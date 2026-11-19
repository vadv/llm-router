//! Async history writer (SRS §5): completed request summaries go through
//! a bounded queue to ONE writer thread, so inference never waits on
//! SQLite and no locks are held across generation. The queue budget
//! covers the pending summaries INCLUDING the batch the writer holds;
//! on overflow or a write error a WHOLE summary (or batch) is dropped
//! and reported through counters plus the `on_dropped` callback —
//! never through the inference path.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use std::sync::mpsc::{Receiver, Sender, channel};

use super::RequestSummary;
use crate::storage::history::HistoryStore;

/// Queue budget for pending summaries plus the writer's current batch.
pub const DEFAULT_BUDGET: usize = 1024 * 1024;
/// Flush interval for small trailing batches.
pub const DEFAULT_FLUSH_EVERY: Duration = Duration::from_secs(10);

/// Rough per-summary footprint: fixed part plus the strings it carries.
/// Used only for budget accounting, never persisted.
fn approximate_size(summary: &RequestSummary) -> usize {
    let strings = summary.id.len()
        + summary.key_alias.len()
        + summary.metamodel.len()
        + summary.outcome.len()
        + summary.input.as_ref().map_or(0, |p| p.text.len() + 1);
    let attempts = summary.attempts.iter().fold(0, |acc, attempt| {
        acc + 256
            + attempt.provider_id.len()
            + attempt.upstream_id.len()
            + attempt.result.len()
            + attempt.error.as_deref().map_or(0, str::len)
            + attempt.switch_reason.as_deref().map_or(0, str::len)
            + attempt.response.as_ref().map_or(0, |p| p.text.len() + 1)
            + attempt
                .tool_calls
                .names
                .iter()
                .map(String::len)
                .sum::<usize>()
    });
    128 + strings + attempts
}

#[derive(Default)]
pub struct WriterStats {
    pub dropped_total: u64,
    pub written_total: u64,
}

struct Shared {
    queued_bytes: AtomicUsize,
    dropped_total: AtomicU64,
    written_total: AtomicU64,
    /// Set by the writer thread after its final flush: the force-stop exit
    /// may proceed. A bool, not a channel: one event, many waiters.
    stopped: AtomicBool,
}

enum Job {
    Summary(Box<RequestSummary>, usize),
    /// Final flush and stop.
    Shutdown,
}

/// The drop report callback shared by the enqueue path and the writer
/// thread: one reporting road for every lost summary.
type DropReport = Arc<dyn Fn(u32, &str) + Send + Sync>;

pub struct HistoryWriter {
    tx: Sender<Job>,
    shared: Arc<Shared>,
    report: DropReport,
}

impl HistoryWriter {
    /// Spawn the single writer thread. `on_dropped` fires at most once
    /// per dropped batch (count, reason) and must stay cheap — both for
    /// queue rejections and writer failures.
    pub fn spawn(
        mut store: HistoryStore,
        flush_every: Duration,
        budget: usize,
        on_dropped: impl Fn(u32, &str) + Send + Sync + 'static,
    ) -> HistoryWriter {
        let (tx, rx) = channel();
        let shared = Arc::new(Shared {
            queued_bytes: AtomicUsize::new(0),
            dropped_total: AtomicU64::new(0),
            written_total: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
        });
        let thread_shared = Arc::clone(&shared);
        let thread_budget = budget;
        let report = Arc::new(on_dropped);
        let thread_report = Arc::clone(&report);
        std::thread::Builder::new()
            .name("history-writer".to_owned())
            .spawn(move || {
                writer_loop(
                    &mut store,
                    &rx,
                    &thread_shared,
                    thread_budget,
                    flush_every,
                    &*thread_report,
                )
            })
            .expect("spawn history writer");
        HistoryWriter { tx, shared, report }
    }

    /// Queue one completed summary. Err means the budget rejected it and
    /// the summary is DROPPED (already counted; the caller may report).
    pub fn enqueue(&self, summary: RequestSummary) -> Result<(), ()> {
        let size = approximate_size(&summary);
        // Shared with the writer's own cap check through the same
        // atomic counter; the caller-side budget is the same constant.
        let mut queued = self.shared.queued_bytes.load(Ordering::Relaxed);
        loop {
            if queued
                .checked_add(size)
                .is_none_or(|total| total > DEFAULT_BUDGET)
            {
                self.shared.dropped_total.fetch_add(1, Ordering::Relaxed);
                (self.report)(1, "queue budget exceeded");
                return Err(());
            }
            match self.shared.queued_bytes.compare_exchange_weak(
                queued,
                queued + size,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => queued = current,
            }
        }
        self.tx
            .send(Job::Summary(Box::new(summary), size))
            .map_err(|_| ())
    }

    /// Final flush and writer shutdown: the process is stopping.
    pub fn shutdown(&self) {
        let _ = self.tx.send(Job::Shutdown);
    }

    /// Block until the writer thread finished its final flush, at most
    /// `deadline`. False means it is still writing — force exit drops the
    /// rest of the queue rather than hang the restart on it.
    pub fn wait_stopped(&self, deadline: Duration) -> bool {
        let wake_at = std::time::Instant::now() + deadline;
        while !self.shared.stopped.load(Ordering::Acquire) {
            if std::time::Instant::now() >= wake_at {
                return false;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        true
    }

    pub fn stats(&self) -> WriterStats {
        WriterStats {
            dropped_total: self.shared.dropped_total.load(Ordering::Relaxed),
            written_total: self.shared.written_total.load(Ordering::Relaxed),
        }
    }

    pub fn queued_bytes(&self) -> usize {
        self.shared.queued_bytes.load(Ordering::Relaxed)
    }
}

fn writer_loop(
    store: &mut HistoryStore,
    rx: &Receiver<Job>,
    shared: &Shared,
    budget: usize,
    flush_every: Duration,
    on_dropped: &dyn Fn(u32, &str),
) {
    let mut pending: Vec<RequestSummary> = Vec::new();
    let mut pending_bytes = 0usize;
    loop {
        let first_after_idle = pending.is_empty();
        let job = if first_after_idle {
            // Nothing held: block until work arrives.
            rx.recv().ok()
        } else {
            // Batch is open: flush on timeout even if quiet.
            rx.recv_timeout(flush_every).ok()
        };
        match job {
            Some(Job::Summary(summary, size)) => {
                pending_bytes += size;
                pending.push(*summary);
                // A burst batches until the budget; a lone arrival writes
                // at once, so a record never waits out the whole interval.
                if pending_bytes >= budget || first_after_idle {
                    flush(store, shared, &mut pending, &mut pending_bytes, on_dropped);
                }
            }
            // Shutdown or channel close: write what we hold and stop.
            Some(Job::Shutdown) | None => {
                flush(store, shared, &mut pending, &mut pending_bytes, on_dropped);
                shared.stopped.store(true, Ordering::Release);
                break;
            }
        }
    }
}

fn flush(
    store: &mut HistoryStore,
    shared: &Shared,
    pending: &mut Vec<RequestSummary>,
    pending_bytes: &mut usize,
    on_dropped: &dyn Fn(u32, &str),
) {
    if pending.is_empty() {
        return;
    }
    shared
        .queued_bytes
        .fetch_sub(*pending_bytes, Ordering::Relaxed);
    match store.insert_summaries(pending) {
        Ok(()) => {
            shared
                .written_total
                .fetch_add(pending.len() as u64, Ordering::Relaxed);
        }
        Err(error) => {
            let reason = error.0;
            shared
                .dropped_total
                .fetch_add(pending.len() as u64, Ordering::Relaxed);
            on_dropped(pending.len() as u32, &reason);
        }
    }
    pending.clear();
    *pending_bytes = 0;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{AttemptSummary, Preview};
    use rusqlite::Connection;
    use std::sync::Mutex;

    fn summary(id: &str, text_len: usize) -> RequestSummary {
        RequestSummary {
            id: id.to_owned(),
            key_alias: "m5".to_owned(),
            metamodel: "glm".to_owned(),
            started_at_unix: 100,
            finished_at_unix: 109,
            outcome: "ok".to_owned(),
            input: Some(Preview {
                text: "x".repeat(text_len),
                truncated: false,
            }),
            declared_tools: None,
            issues: vec![],
            attempts: vec![AttemptSummary {
                provider_id: "zai".to_owned(),
                upstream_id: "glm-5.3".to_owned(),
                started_at_unix: 100,
                finished_at_unix: 109,
                result: "ok".to_owned(),
                error: None,
                error_class: None,
                duration_ms: None,
                switch_reason: None,
                input_tokens: Some(1),
                output_tokens: Some(2),
                cost: None,
                response: None,
                tool_calls: Default::default(),
                issues: vec![],
            }],
        }
    }

    fn db_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "history-writer-{name}-{}.sqlite",
            std::process::id()
        ))
    }

    #[test]
    fn flushes_within_interval() {
        let path = db_path("interval");
        let _ = std::fs::remove_file(&path);
        let store = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        let writer =
            HistoryWriter::spawn(store, Duration::from_millis(40), DEFAULT_BUDGET, |_, _| {});
        writer.enqueue(summary("r1", 10)).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(writer.stats().written_total, 1);
        assert_eq!(writer.queued_bytes(), 0);
        let reader = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(
            reader
                .list(&crate::storage::history::RequestFilter {
                    limit: 10,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
        writer.shutdown();
    }

    #[test]
    fn shutdown_flushes_pending_before_quiet() {
        let path = db_path("shutdown");
        let _ = std::fs::remove_file(&path);
        let store = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        // Long interval: only the shutdown flush can write this.
        let writer =
            HistoryWriter::spawn(store, Duration::from_secs(30), DEFAULT_BUDGET, |_, _| {});
        writer.enqueue(summary("r2", 10)).unwrap();
        writer.shutdown();
        // The force-stop wait replaces a blind sleep: it returns only after
        // the final flush, so the row must already be on disk.
        assert!(writer.wait_stopped(Duration::from_secs(2)));
        let reader = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        assert_eq!(
            reader
                .list(&crate::storage::history::RequestFilter {
                    limit: 10,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn oversized_summary_is_rejected_and_counted() {
        let store = HistoryStore::new(Connection::open_in_memory().unwrap()).unwrap();
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let seen = seen.clone();
            move |count: u32, reason: &str| seen.lock().unwrap().push((count, reason.to_owned()))
        };
        let writer = HistoryWriter::spawn(store, Duration::from_secs(30), DEFAULT_BUDGET, sink);
        // Bigger than the whole 1 MiB budget.
        let result = writer.enqueue(summary("huge", DEFAULT_BUDGET + 4096));
        assert!(result.is_err());
        assert_eq!(writer.stats().dropped_total, 1);
        // The rejection reaches the same reporting path as writer drops.
        let dropped = seen.lock().unwrap().clone();
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].0, 1);
        assert_eq!(dropped[0].1, "queue budget exceeded");
        writer.shutdown();
    }

    #[test]
    fn write_failure_drops_whole_batch_and_reports() {
        let path = db_path("failure");
        let _ = std::fs::remove_file(&path);
        let store = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        let writer =
            HistoryWriter::spawn(store, Duration::from_millis(40), DEFAULT_BUDGET, |_, _| {});
        writer.enqueue(summary("dup", 10)).unwrap();
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(writer.stats().written_total, 1);
        // A second writer on the same file hits the primary key and
        // must drop its batch, not crash.
        let second_store = HistoryStore::new(Connection::open(&path).unwrap()).unwrap();
        let (drops_tx, drops_rx) = std::sync::mpsc::channel::<(u32, String)>();
        let second = HistoryWriter::spawn(
            second_store,
            Duration::from_millis(40),
            DEFAULT_BUDGET,
            move |count, reason| {
                drops_tx.send((count, reason.to_owned())).unwrap();
            },
        );
        second.enqueue(summary("dup", 10)).unwrap();
        let (count, reason) = drops_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(count, 1);
        assert!(reason.contains("insert request 'dup'"));
        assert_eq!(second.stats().dropped_total, 1);
        writer.shutdown();
        second.shutdown();
    }
}
