//! Compact history summaries: what one request and its attempts leave
//! behind (SRS docs/history-storage-spec.md §2). Extraction is passive —
//! it never decides the inference outcome, only observes it.

pub mod extract;
pub mod observer;
pub mod spend;
pub mod writer;

pub use extract::AttemptObservation;

/// A preview of at most PREVIEW_CHARS Unicode scalar values. `truncated`
/// distinguishes a short finished text from the cut of a longer one.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Preview {
    pub text: String,
    pub truncated: bool,
}

pub const PREVIEW_CHARS: usize = 80;

/// Fixed diagnostic codes for extraction problems (§3.3). Upstream data
/// never widens this set; no arbitrary messages are stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractIssue {
    /// A field is present but has the wrong type; other fields survive.
    InvalidFieldType,
    /// The content shape is known but not text we can preview.
    UnsupportedContent,
    /// A streaming event failed to parse as JSON.
    InvalidJson,
    /// A streaming chunk split a UTF-8 sequence outside the buffer bound.
    InvalidUtf8,
    /// A streaming event exceeded the observer buffer and was skipped.
    EventTooLarge,
}

impl ExtractIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            ExtractIssue::InvalidFieldType => "invalid_field_type",
            ExtractIssue::UnsupportedContent => "unsupported_content",
            ExtractIssue::InvalidJson => "invalid_json",
            ExtractIssue::InvalidUtf8 => "invalid_utf8",
            ExtractIssue::EventTooLarge => "event_too_large",
        }
    }
}

/// Issue list without duplicates, bounded by the fixed code set.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Issues(pub Vec<ExtractIssue>);

impl Issues {
    pub fn push(&mut self, issue: ExtractIssue) {
        if !self.0.contains(&issue) {
            self.0.push(issue);
        }
    }
}

/// Compact tool-call facts of one attempt (§2.3): a trustworthy count
/// when determinable, at most TOOL_NAMES_LIMIT names of at most
/// PREVIEW_CHARS scalar values each.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolCallsSummary {
    pub count: Option<u32>,
    pub names: Vec<String>,
    pub truncated_names: bool,
    pub truncated_list: bool,
}

pub const TOOL_NAMES_LIMIT: usize = 4;

/// One completed upstream attempt as history will store it (§2.2).
/// Unknown values stay `None`; zero is only ever a known zero.
#[derive(Clone, Debug)]
pub struct AttemptSummary {
    pub provider_id: String,
    pub upstream_id: String,
    pub started_at_unix: i64,
    pub finished_at_unix: i64,
    pub result: String,
    pub error: Option<String>,
    /// Recognized failure class of `error` (the router's own label, never
    /// re-parsed from the message). None when the attempt did not fail.
    pub error_class: Option<String>,
    /// Monotonic wall time of the whole upstream call, including reading
    /// the answer. None only for records written before the field existed.
    pub duration_ms: Option<i64>,
    pub switch_reason: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Reported cost, only when the upstream sent a numeric field; we
    /// never compute or convert it ourselves.
    pub cost: Option<f64>,
    pub response: Option<Preview>,
    pub tool_calls: ToolCallsSummary,
    pub issues: Vec<ExtractIssue>,
}

/// One completed request with all its attempts — the queue unit (§5.1).
#[derive(Clone, Debug)]
pub struct RequestSummary {
    pub id: String,
    pub key_alias: String,
    pub metamodel: String,
    pub started_at_unix: i64,
    pub finished_at_unix: i64,
    pub outcome: String,
    pub input: Option<Preview>,
    /// Declared tools count, only for the known array-of-objects form.
    pub declared_tools: Option<u32>,
    pub issues: Vec<ExtractIssue>,
    pub attempts: Vec<AttemptSummary>,
}

pub fn preview(text: &str) -> Preview {
    let mut p = Preview::default();
    if text.chars().count() > PREVIEW_CHARS {
        p.text = text.chars().take(PREVIEW_CHARS).collect();
        p.truncated = true;
    } else {
        p.text = text.to_owned();
    }
    p
}

/// A live request as the management API shows it while it runs (§2.5).
#[derive(Clone, Debug, PartialEq)]
pub struct RunningAttempt {
    pub provider_id: String,
    pub upstream_id: String,
    pub started_at_unix: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunningRequest {
    pub id: String,
    pub key_alias: String,
    pub metamodel: String,
    pub started_at_unix: i64,
    pub attempts: Vec<RunningAttempt>,
}

/// In-memory view of requests currently being served. Completed
/// summaries move to the writer queue; this only answers "what is
/// happening right now" and never touches SQLite.
#[derive(Default)]
pub struct RunningRegistry {
    inner: std::sync::Mutex<std::collections::HashMap<String, RunningRequest>>,
}

impl RunningRegistry {
    pub fn begin(&self, request: RunningRequest) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.insert(request.id.clone(), request);
        }
    }

    pub fn add_attempt(&self, request_id: &str, attempt: RunningAttempt) {
        if let Ok(mut inner) = self.inner.lock()
            && let Some(request) = inner.get_mut(request_id)
        {
            request.attempts.push(attempt);
        }
    }

    pub fn end(&self, request_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.remove(request_id);
        }
    }

    /// Oldest first: a stable list for the UI.
    pub fn snapshot(&self) -> Vec<RunningRequest> {
        let Ok(inner) = self.inner.lock() else {
            return Vec::new();
        };
        let mut list: Vec<RunningRequest> = inner.values().cloned().collect();
        list.sort_by_key(|request| request.started_at_unix);
        list
    }
}
