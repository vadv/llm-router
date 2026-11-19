// System event log (events.sqlite): what happened to the router itself —
// bans recorded and expired, catalog refreshes, balance poll failures.
// Per-request data (switches, usage, texts) stays in requests.sqlite and
// balance history stays in observations; events never duplicate them.
//
// The connection sits behind a Mutex: handlers, the scheduler and the ban
// writer share one store, and no lock is ever held across a network await.

use std::sync::Mutex;

use rusqlite::Connection;
use serde_json::Value;

use super::StorageError;

/// Event kinds, one constant per emission point. Only genuinely notable
/// things become events; routine polls (catalog refresh, balance checks)
/// stay in the per-provider status instead of spamming the feed.
pub mod event_kind {
    pub const BAN_RECORDED: &str = "ban_recorded";
    pub const BAN_EXPIRED: &str = "ban_expired";
    pub const CATALOG_ERROR: &str = "catalog_error";
    pub const BALANCE_ERROR: &str = "balance_error";
    pub const SERVER_STARTED: &str = "server_started";
    pub const MODEL_SWITCH: &str = "model_switch";
    pub const ALL_MODELS_FAILED: &str = "all_models_failed";
    pub const KNOWLEDGE_CARD: &str = "knowledge_card";
    pub const KNOWLEDGE_ERROR: &str = "knowledge_error";
    pub const RETENTION_PURGED: &str = "retention_purged";
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    pub id: i64,
    pub ts_unix: i64,
    pub kind: String,
    pub provider_id: Option<String>,
    /// Verbatim detail JSON, or None when the event has no detail.
    pub detail: Option<String>,
}

pub struct EventStore {
    conn: Mutex<Connection>,
}

impl EventStore {
    /// Takes ownership of the events database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS events (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 ts_unix     INTEGER NOT NULL,
                 kind        TEXT NOT NULL,
                 provider_id TEXT,
                 detail      TEXT
             )",
            [],
        )
        .map_err(|e| StorageError(format!("create events: {e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Append one event. A failed event write must not fail the operation
    /// that caused it — callers log and continue.
    pub fn record(
        &self,
        ts_unix: i64,
        kind: &str,
        provider_id: Option<&str>,
        detail: &Value,
    ) -> Result<(), StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "INSERT INTO events (ts_unix, kind, provider_id, detail)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ts_unix, kind, provider_id, detail.to_string()],
        )
        .map_err(|e| StorageError(format!("record event: {e}")))?;
        Ok(())
    }

    /// Recent events, newest first. `limit` comes from the caller and is
    /// already bounded.
    pub fn list(&self, limit: i64) -> Result<Vec<StoredEvent>, StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, ts_unix, kind, provider_id, detail
                 FROM events
                 ORDER BY id DESC
                 LIMIT ?1",
            )
            .map_err(|e| StorageError(format!("prepare events: {e}")))?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok(StoredEvent {
                    id: r.get(0)?,
                    ts_unix: r.get(1)?,
                    kind: r.get(2)?,
                    provider_id: r.get(3)?,
                    detail: r.get(4)?,
                })
            })
            .map_err(|e| StorageError(format!("query events: {e}")))?;
        let mut events = Vec::new();
        for row in rows {
            let event = row.map_err(|e| StorageError(format!("read event: {e}")))?;
            events.push(event);
        }
        Ok(events)
    }

    /// Delete events older than the cutoff. Same retention policy as
    /// request history.
    pub fn purge_older_than(&self, cutoff_unix: i64) -> Result<u64, StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute("DELETE FROM events WHERE ts_unix < ?1", [cutoff_unix])
            .map(|_| ())
            .map_err(|e| StorageError(format!("purge events: {e}")))?;
        let purged =
            conn.query_row("SELECT changes()", [], |r| r.get::<_, i64>(0))
                .map_err(|e| StorageError(format!("count purged events: {e}")))? as u64;
        Ok(purged)
    }

    /// Trivial connectivity check.
    pub fn ping(&self) -> bool {
        let conn = self.conn.lock().map_err(|_| false).ok();
        let Some(conn) = conn else { return false };
        conn.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }
}

fn poisoned() -> StorageError {
    StorageError("events connection lock poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> EventStore {
        EventStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn a_recorded_event_is_listed_newest_first() {
        let events = store();
        events
            .record(
                100,
                event_kind::BAN_RECORDED,
                Some("kimi"),
                &json!({"reason": "quota"}),
            )
            .unwrap();
        events
            .record(
                200,
                event_kind::CATALOG_ERROR,
                Some("zai"),
                &json!({"error": "timeout"}),
            )
            .unwrap();
        let listed = events.list(10).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].kind, event_kind::CATALOG_ERROR);
        assert_eq!(listed[0].ts_unix, 200);
        assert_eq!(listed[0].provider_id.as_deref(), Some("zai"));
        assert_eq!(listed[0].detail.as_deref(), Some(r#"{"error":"timeout"}"#));
        assert_eq!(listed[1].kind, event_kind::BAN_RECORDED);
        assert_eq!(listed[1].detail.as_deref(), Some(r#"{"reason":"quota"}"#));
    }

    #[test]
    fn limit_bounds_the_list() {
        let events = store();
        for i in 0..5 {
            events
                .record(i, event_kind::SERVER_STARTED, None, &json!({"n": i}))
                .unwrap();
        }
        let listed = events.list(2).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].ts_unix, 4);
        assert_eq!(listed[1].ts_unix, 3);
    }

    #[test]
    fn an_empty_log_lists_nothing() {
        assert!(store().list(50).unwrap().is_empty());
    }

    #[test]
    fn purge_deletes_only_older_events() {
        let events = store();
        events
            .record(100, event_kind::BAN_RECORDED, None, &json!({}))
            .unwrap();
        events
            .record(300, event_kind::BAN_EXPIRED, None, &json!({}))
            .unwrap();
        assert_eq!(events.purge_older_than(200).unwrap(), 1);
        let listed = events.list(10).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, event_kind::BAN_EXPIRED);
    }

    #[test]
    fn ping_answers_true_on_a_live_connection() {
        assert!(store().ping());
    }
}
