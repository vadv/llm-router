//! Byte-stream observer for SSE chat streams (SRS §4). It watches the
//! SAME bytes that are relayed to the client untouched, never blocks the
//! stream, and derives preview/usage/tool facts incrementally:
//! - SSE event boundaries survive arbitrary chunk splits;
//! - one event larger than `MAX_EVENT` is skipped whole and reported as
//!   `event_too_large`; the stream continues;
//! - text preview stops accumulating at 80 scalar values;
//! - tool-call names arrive in fragments and are joined by stream index.

use serde_json::Value;

use super::extract::AttemptObservation;
use super::{ExtractIssue, PREVIEW_CHARS, Preview, TOOL_NAMES_LIMIT, ToolCallsSummary};

pub const MAX_EVENT: usize = 64 * 1024;

pub struct StreamObserver {
    /// Partial line bytes between chunk boundaries.
    line: Vec<u8>,
    /// True right after a CR, so the following LF does not open a new
    /// (spuriously empty) line.
    pending_lf: bool,
    /// `data:` payloads of the event currently being assembled
    /// (multi-line data joins with a newline per the SSE spec).
    event: Vec<u8>,
    in_data: bool,
    /// Set when the current event passed the cap; the rest is skipped.
    dropped: bool,
    ended: bool,

    text: String,
    text_full: bool,
    /// (stream index, assembled name); streams without `index` share 0.
    tools: Vec<(u64, String)>,
    tool_count: u32,
    tools_truncated: bool,
    observation: AttemptObservation,
}

impl Default for StreamObserver {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamObserver {
    pub fn new() -> Self {
        StreamObserver {
            line: Vec::new(),
            pending_lf: false,
            event: Vec::new(),
            in_data: false,
            dropped: false,
            ended: false,
            text: String::new(),
            text_full: false,
            tools: Vec::new(),
            tool_count: 0,
            tools_truncated: false,
            observation: AttemptObservation::default(),
        }
    }

    /// Feed a chunk of the relayed byte stream. Returns true once a
    /// terminal marker was seen (`data: [DONE]` or `message_stop`).
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        for &byte in bytes {
            match byte {
                b'\n' if self.pending_lf => self.pending_lf = false,
                b'\n' | b'\r' => {
                    self.pending_lf = byte == b'\r';
                    self.end_line();
                }
                _ => {
                    if self.dropped {
                        continue;
                    }
                    if self.line.len() + self.event.len() >= MAX_EVENT {
                        self.drop_event();
                        continue;
                    }
                    self.line.push(byte);
                }
            }
        }
        self.ended
    }

    /// Finalize after the stream closes; facts collected so far survive.
    pub fn finish(mut self) -> AttemptObservation {
        if !self.line.is_empty() || !self.event.is_empty() {
            self.end_line();
            self.end_event();
        }
        let mut out = self.observation;
        if !self.text.is_empty() {
            out.response = Some(Preview {
                text: std::mem::take(&mut self.text),
                // Honest only when more text arrived than we kept.
                truncated: self.text_full,
            });
        }
        out.tool_calls = ToolCallsSummary {
            count: (self.tool_count > 0).then_some(self.tool_count),
            names: self.tools.iter().map(|(_, name)| name.clone()).collect(),
            truncated_names: false,
            truncated_list: self.tools_truncated,
        };
        out
    }

    fn end_line(&mut self) {
        let line = std::mem::take(&mut self.line);
        if self.dropped {
            // A blank line ends the oversized event.
            if line.is_empty() {
                self.dropped = false;
                self.in_data = false;
                self.event.clear();
            }
            return;
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            self.observation.issues.push(ExtractIssue::InvalidUtf8);
            return;
        };
        let trimmed = text.trim_end();
        if let Some(event) = trimmed.strip_prefix("event:") {
            if event.trim() == "message_stop" {
                self.ended = true;
            }
            self.in_data = false;
            return;
        }
        if let Some(data) = trimmed.strip_prefix("data:") {
            if self.in_data && !self.event.is_empty() {
                self.event.push(b'\n');
            }
            self.in_data = true;
            self.event.extend_from_slice(data.trim_start().as_bytes());
            if self.event.len() >= MAX_EVENT {
                self.drop_event();
            }
            return;
        }
        if trimmed.is_empty() {
            self.in_data = false;
            self.end_event();
        }
    }

    fn end_event(&mut self) {
        let payload = std::mem::take(&mut self.event);
        if payload.is_empty() {
            return;
        }
        let Ok(text) = std::str::from_utf8(&payload) else {
            self.observation.issues.push(ExtractIssue::InvalidUtf8);
            return;
        };
        if text.trim() == "[DONE]" {
            self.ended = true;
            return;
        }
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            self.observation.issues.push(ExtractIssue::InvalidJson);
            return;
        };
        self.observe(&value);
    }

    fn drop_event(&mut self) {
        self.dropped = true;
        self.event.clear();
        self.line.clear();
        self.observation.issues.push(ExtractIssue::EventTooLarge);
    }

    fn observe(&mut self, value: &Value) {
        // Usage arrives in the final OpenAI chunk or Anthropic
        // message_start/message_delta; one reader covers both shapes.
        if let Some(usage) = value
            .get("usage")
            .or_else(|| value.pointer("/message/usage"))
        {
            // Reuse the complete-path field rules verbatim.
            let merged = super::extract::complete_attempt(&serde_json::json!({ "usage": usage }));
            if let Some(v) = merged.input_tokens {
                self.observation.input_tokens = Some(v);
            }
            if let Some(v) = merged.output_tokens {
                self.observation.output_tokens = Some(v);
            }
            if let Some(v) = merged.cost {
                self.observation.cost = Some(v);
            }
            for issue in merged.issues.0 {
                self.observation.issues.push(issue);
            }
        }
        if let Some(delta) = value.pointer("/choices/0/delta") {
            self.observe_delta(delta);
        } else if let Some(delta) = value.get("delta").filter(|d| d.is_object()) {
            // Anthropic content_block_delta.
            self.observe_delta(delta);
        }
    }

    fn observe_delta(&mut self, delta: &Value) {
        if let Some(Value::String(chunk)) = delta.get("content") {
            self.push_text(chunk);
        }
        if let Some(Value::String(chunk)) = delta.get("text") {
            self.push_text(chunk);
        }
        if let Some(Value::Array(calls)) = delta.get("tool_calls") {
            for call in calls {
                let index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                if let Some(fragment) = call.pointer("/function/name").and_then(Value::as_str) {
                    self.push_tool_fragment(index, fragment);
                }
            }
        }
    }

    /// Append to the preview until the cap; after that only remember
    /// that more text arrived.
    fn push_text(&mut self, chunk: &str) {
        if self.text_full {
            return;
        }
        let kept = PREVIEW_CHARS.saturating_sub(self.text.chars().count());
        if chunk.chars().count() > kept {
            self.text_full = true;
        }
        self.text.extend(chunk.chars().take(kept));
    }

    fn push_tool_fragment(&mut self, index: u64, fragment: &str) {
        if let Some((_, name)) = self.tools.iter_mut().find(|(i, _)| *i == index) {
            let kept = PREVIEW_CHARS.saturating_sub(name.chars().count());
            name.extend(fragment.chars().take(kept));
            return;
        }
        // First fragment for an unseen index introduces a new call.
        self.tool_count += 1;
        if self.tools.len() == TOOL_NAMES_LIMIT {
            // Keep the count honest, stop keeping names.
            self.tools_truncated = true;
            return;
        }
        let mut name = String::new();
        let kept = PREVIEW_CHARS;
        name.extend(fragment.chars().take(kept));
        self.tools.push((index, name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observe(stream: &[u8]) -> AttemptObservation {
        let mut observer = StreamObserver::new();
        // One byte at a time is the harshest chunk split.
        for &byte in stream.iter() {
            observer.feed(&[byte]);
        }
        observer.finish()
    }

    #[test]
    fn chunk_boundaries_split_lines_and_events() {
        let stream = b"data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n\
                      data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n\
                      data: [DONE]\n\n";
        let mut observer = StreamObserver::new();
        let mut ended = false;
        for &byte in stream.iter() {
            ended |= observer.feed(&[byte]);
        }
        assert!(ended);
        assert_eq!(observer.finish().response.unwrap().text, "hello");
    }

    #[test]
    fn crlf_and_multiline_data_parse() {
        let stream = b"event: message_delta\r\ndata: {\"usage\":\r\ndata: {\"output_tokens\":7}}\r\n\r\ndata: [DONE]\r\n\r\n";
        let out = observe(stream);
        assert_eq!(out.output_tokens, Some(7));
    }

    #[test]
    fn done_inside_text_is_not_terminal() {
        // No real terminal marker in this stream at all.
        let stream =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"the marker is [DONE]\"}}]}\n\n";
        let mut observer = StreamObserver::new();
        assert!(!observer.feed(stream));
        let out = observer.finish();
        assert!(out.response.unwrap().text.contains("[DONE]"));
    }

    #[test]
    fn oversize_event_skipped_but_stream_continues() {
        let mut big = String::from("data: {\"choices\":[{\"delta\":{\"content\":\"");
        big.push_str(&"x".repeat(MAX_EVENT));
        big.push_str("\"}}]}\n\n");
        let stream =
            format!("{big}data: {{\"usage\":{{\"prompt_tokens\":5}}}}\n\ndata: [DONE]\n\n");
        let out = observe(stream.as_bytes());
        assert_eq!(out.input_tokens, Some(5));
        assert!(out.issues.0.contains(&ExtractIssue::EventTooLarge));
        assert!(out.response.is_none());
    }

    #[test]
    fn text_preview_caps_at_80_scalar_values() {
        let mut stream = String::new();
        for _ in 0..30 {
            stream.push_str("data: {\"choices\":[{\"delta\":{\"content\":\"абвгд\"}}]}\n\n");
        }
        stream.push_str("data: [DONE]\n\n");
        let out = observe(stream.as_bytes());
        let preview = out.response.unwrap();
        assert_eq!(preview.text.chars().count(), 80);
        assert!(preview.truncated);
    }

    #[test]
    fn tool_name_fragments_join_by_index() {
        let stream = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"sea\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"name\":\"sky\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"rch\"}}]}}]}\n\n",
            "data: [DONE]\n\n",
        );
        let out = observe(stream.as_bytes());
        assert_eq!(out.tool_calls.count, Some(2));
        assert_eq!(out.tool_calls.names, ["search", "sky"]);
    }

    #[test]
    fn more_than_four_tool_calls_keep_count_only() {
        let mut stream = String::new();
        for i in 0..6 {
            stream.push_str(&format!(
                "data: {{\"choices\":[{{\"delta\":{{\"tool_calls\":[{{\"index\":{i},\"function\":{{\"name\":\"t{i}\"}}}}]}}}}]}}\n\n"
            ));
        }
        stream.push_str("data: [DONE]\n\n");
        let out = observe(stream.as_bytes());
        assert_eq!(out.tool_calls.count, Some(6));
        assert_eq!(out.tool_calls.names.len(), 4);
        assert!(out.tool_calls.truncated_list);
    }

    #[test]
    fn anthropic_message_events_feed_usage_and_text() {
        let stream = concat!(
            "event: message_start\ndata: {\"message\":{\"usage\":{\"input_tokens\":7}}}\n\n",
            "event: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"привет\"}}\n\n",
            "event: message_delta\ndata: {\"usage\":{\"output_tokens\":9}}\n\n",
            "event: message_stop\n\n",
        );
        let out = observe(stream.as_bytes());
        assert_eq!(out.input_tokens, Some(7));
        assert_eq!(out.output_tokens, Some(9));
        assert_eq!(out.response.unwrap().text, "привет");
    }

    #[test]
    fn invalid_json_event_is_reported_not_fatal() {
        let stream =
            b"data: {broken\n\ndata: {\"usage\":{\"prompt_tokens\":1}}\n\ndata: [DONE]\n\n";
        let out = observe(stream);
        assert_eq!(out.input_tokens, Some(1));
        assert!(out.issues.0.contains(&ExtractIssue::InvalidJson));
    }
}
