//! Passive extraction of compact history facts from parsed JSON bodies
//! (SRS §3). Rules shared by the complete and streaming paths:
//! - a missing or null field stays `None` without an issue;
//! - a present field that is not a usable number/text raises
//!   [`ExtractIssue::InvalidFieldType`] and yields `None`;
//! - no preview ever falls back to an older message.

use serde_json::Value;

use super::{Issues, Preview, TOOL_NAMES_LIMIT, ToolCallsSummary};

/// Facts extracted from one complete upstream response body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AttemptObservation {
    pub response: Option<Preview>,
    pub tool_calls: ToolCallsSummary,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub issues: Issues,
}

/// Facts extracted from one incoming request body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RequestObservation {
    pub input: Option<Preview>,
    pub declared_tools: Option<u32>,
    pub issues: Issues,
}

/// OpenAI-shaped non-text content blocks that we silently skip when
/// previewing; anything else inside an array raises UnsupportedContent.
const KNOWN_NON_TEXT_BLOCKS: [&str; 9] = [
    "image_url",
    "image",
    "audio",
    "input_audio",
    "file",
    "video",
    "document",
    "tool_use",
    "tool_result",
];

/// A numeric token count: `None` for absence, `Some(Ok)` for a usable
/// u64 (bounded by i64::MAX, the sqlite integer range).
fn token_count(value: Option<&Value>, issues: &mut Issues) -> Option<u64> {
    let field = field_object(value)?;
    match field.as_u64() {
        Some(count) if count <= i64::MAX as u64 => Some(count),
        _ => {
            issues.push(super::ExtractIssue::InvalidFieldType);
            None
        }
    }
}

/// Cost is only stored when the upstream reported a finite non-negative
/// number; we never compute it ourselves.
fn cost_value(value: Option<&Value>, issues: &mut Issues) -> Option<f64> {
    let field = field_object(value)?;
    match field.as_f64() {
        Some(cost) if cost.is_finite() && cost >= 0.0 => Some(cost),
        _ => {
            issues.push(super::ExtractIssue::InvalidFieldType);
            None
        }
    }
}

/// Distinguishes absence from a present-but-unusable field.
fn field_object(value: Option<&Value>) -> Option<&Value> {
    match value {
        None | Some(Value::Null) => None,
        Some(v) => Some(v),
    }
}

/// First-match token count over the OpenAI and Anthropic field names,
/// mirroring the live `StreamUsage` reader.
fn any_token_count(usage: &Value, names: [&str; 2], issues: &mut Issues) -> Option<u64> {
    for name in names {
        let count = token_count(usage.get(name), issues);
        if count.is_some() {
            return count;
        }
    }
    None
}

/// Preview of textual content in any of the known shapes: a plain string
/// or an array of content blocks. Non-text blocks are skipped.
fn content_preview(content: &Value, issues: &mut Issues) -> Option<Preview> {
    match content {
        Value::String(text) => Some(super::preview(text)),
        Value::Array(blocks) => {
            let mut text = String::new();
            for block in blocks {
                let Value::Object(map) = block else {
                    issues.push(super::ExtractIssue::InvalidFieldType);
                    continue;
                };
                let Some(Value::String(kind)) = map.get("type") else {
                    issues.push(super::ExtractIssue::InvalidFieldType);
                    continue;
                };
                if kind == "text" {
                    match map.get("text") {
                        Some(Value::String(chunk)) => text.push_str(chunk),
                        _ => issues.push(super::ExtractIssue::InvalidFieldType),
                    }
                } else if !KNOWN_NON_TEXT_BLOCKS.contains(&kind.as_str()) {
                    issues.push(super::ExtractIssue::UnsupportedContent);
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(super::preview(&text))
            }
        }
        // Null is a legal empty content; anything else is a broken body.
        Value::Null => None,
        _ => {
            issues.push(super::ExtractIssue::InvalidFieldType);
            None
        }
    }
}

/// Extract compact facts from a parsed complete (non-streaming) upstream
/// response body.
pub fn complete_attempt(body: &Value) -> AttemptObservation {
    let mut out = AttemptObservation::default();

    if let Some(usage) = field_object(body.get("usage").or_else(|| body.pointer("/message/usage")))
    {
        out.input_tokens =
            any_token_count(usage, ["prompt_tokens", "input_tokens"], &mut out.issues);
        out.output_tokens = any_token_count(
            usage,
            ["completion_tokens", "output_tokens"],
            &mut out.issues,
        );
        out.cost = cost_value(usage.get("cost"), &mut out.issues);
    }
    // OpenRouter reports cost at the top level.
    if out.cost.is_none() {
        out.cost = cost_value(body.get("cost"), &mut out.issues);
    }

    let message = body.pointer("/choices/0/message");
    if let Some(message) = message {
        out.response = content_preview(
            message.get("content").unwrap_or(&Value::Null),
            &mut out.issues,
        );
        out.tool_calls = tool_calls_summary(message.get("tool_calls"), &mut out.issues);
    }
    out
}

/// Tool-call names of a complete response: a trustworthy count when the
/// array shape is known, at most `TOOL_NAMES_LIMIT` preview-sized names.
fn tool_calls_summary(field: Option<&Value>, issues: &mut Issues) -> ToolCallsSummary {
    let Some(Value::Array(calls)) = field_object(field) else {
        if field_object(field).is_some() {
            issues.push(super::ExtractIssue::InvalidFieldType);
        }
        return ToolCallsSummary::default();
    };
    let mut out = ToolCallsSummary {
        count: Some(calls.len() as u32),
        ..ToolCallsSummary::default()
    };
    for call in calls {
        let Some(name) = call
            .pointer("/function/name")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            // The count stays trustworthy; only the name is unusable.
            issues.push(super::ExtractIssue::InvalidFieldType);
            continue;
        };
        if out.names.len() == TOOL_NAMES_LIMIT {
            out.truncated_list = true;
            break;
        }
        let cut = super::preview(&name);
        out.truncated_names |= cut.truncated;
        out.names.push(cut.text);
    }
    out
}

/// Extract the request-side facts: preview of the LAST user message and
/// the declared tools count (§2.1). No fallback to older messages.
pub fn request_input(body: &Value) -> RequestObservation {
    let mut out = RequestObservation::default();

    let Some(Value::Array(messages)) = body.get("messages") else {
        if field_object(body.get("messages")).is_some() {
            out.issues.push(super::ExtractIssue::InvalidFieldType);
        }
        return finalize_tools(body, out);
    };

    for message in messages.iter().rev() {
        let is_user = message
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role == "user");
        if !is_user {
            continue;
        }
        out.input = content_preview(
            message.get("content").unwrap_or(&Value::Null),
            &mut out.issues,
        );
        break;
    }

    finalize_tools(body, out)
}

/// Attach the declared-tools count for the known array-of-objects shape.
fn finalize_tools(body: &Value, mut out: RequestObservation) -> RequestObservation {
    if let Some(tools) = field_object(body.get("tools")) {
        match tools {
            Value::Array(items) if items.iter().all(Value::is_object) => {
                out.declared_tools = Some(items.len() as u32);
            }
            _ => out.issues.push(super::ExtractIssue::InvalidFieldType),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(messages: Value) -> Value {
        json!({ "messages": messages })
    }

    #[test]
    fn preview_cuts_at_80_scalar_values_not_bytes() {
        let p = super::super::preview(&"а".repeat(81));
        assert_eq!(p.text.chars().count(), 80);
        assert!(p.truncated);
        let p = super::super::preview(&"а".repeat(80));
        assert_eq!(p.text.chars().count(), 80);
        assert!(!p.truncated);
        // 4-byte emoji cut safely between scalar values
        let p = super::super::preview(&"😀".repeat(100));
        assert_eq!(p.text.chars().count(), 80);
    }

    #[test]
    fn last_user_message_wins_and_no_fallback() {
        let body = req(json!([
            {"role": "user", "content": "старый вопрос"},
            {"role": "assistant", "content": "ответ"},
            {"role": "user", "content": "новый вопрос"},
        ]));
        let out = request_input(&body);
        assert_eq!(out.input.unwrap().text, "новый вопрос");
        assert!(out.issues.0.is_empty());
    }

    #[test]
    fn user_message_without_text_gives_no_preview() {
        let body = req(json!([
            {"role": "user", "content": "старый вопрос"},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "x"}},
            ]},
        ]));
        let out = request_input(&body);
        assert!(out.input.is_none());
        assert!(out.issues.0.is_empty()); // known non-text blocks are fine
    }

    #[test]
    fn content_blocks_text_is_concatenated() {
        let body = req(json!([
            {"role": "user", "content": [
                {"type": "text", "text": "часть один "},
                {"type": "text", "text": "и часть два"},
            ]},
        ]));
        assert_eq!(
            request_input(&body).input.unwrap().text,
            "часть один и часть два"
        );
    }

    #[test]
    fn unknown_block_type_is_reported() {
        let body = req(json!([
            {"role": "user", "content": [{"type": "hologram", "data": 1}]},
        ]));
        let out = request_input(&body);
        assert!(out.input.is_none());
        assert!(
            out.issues
                .0
                .contains(&super::super::ExtractIssue::UnsupportedContent)
        );
    }

    #[test]
    fn missing_messages_is_silent_absence() {
        let out = request_input(&json!({}));
        assert!(out.input.is_none());
        assert!(out.issues.0.is_empty());
    }

    #[test]
    fn declared_tools_counted_for_known_shape() {
        let body = json!({"messages": [], "tools": [{"type":"function"}, {"type":"function"}]});
        assert_eq!(request_input(&body).declared_tools, Some(2));
        let broken = json!({"messages": [], "tools": "all"});
        let out = request_input(&broken);
        assert_eq!(out.declared_tools, None);
        assert!(
            out.issues
                .0
                .contains(&super::super::ExtractIssue::InvalidFieldType)
        );
    }

    #[test]
    fn usage_openai_and_anthropic_names() {
        let openai = json!({"choices": [], "usage": {"prompt_tokens": 11, "completion_tokens": 22, "cost": 0.5}});
        let out = complete_attempt(&openai);
        assert_eq!(out.input_tokens, Some(11));
        assert_eq!(out.output_tokens, Some(22));
        assert_eq!(out.cost, Some(0.5));

        let anthropic = json!({"message": {"usage": {"input_tokens": 3, "output_tokens": 4}}});
        let out = complete_attempt(&anthropic);
        assert_eq!(out.input_tokens, Some(3));
        assert_eq!(out.output_tokens, Some(4));
    }

    #[test]
    fn usage_bad_numbers_absent_with_issue_not_zero() {
        for bad in [
            json!("123"),
            json!(-5),
            json!(1.5),
            json!(i64::MAX as u64 + 1),
        ] {
            let body = json!({"usage": {"prompt_tokens": bad, "completion_tokens": bad}});
            let out = complete_attempt(&body);
            assert_eq!(out.input_tokens, None, "{bad}");
            assert_eq!(out.output_tokens, None, "{bad}");
            assert!(
                out.issues
                    .0
                    .contains(&super::super::ExtractIssue::InvalidFieldType)
            );
        }
    }

    #[test]
    fn cost_only_numeric_and_top_level_fallback() {
        let top = json!({"cost": 0.25, "usage": {}});
        assert_eq!(complete_attempt(&top).cost, Some(0.25));
        let bad = json!({"cost": "0.25"});
        let out = complete_attempt(&bad);
        assert_eq!(out.cost, None);
        assert!(
            out.issues
                .0
                .contains(&super::super::ExtractIssue::InvalidFieldType)
        );
        let negative = json!({"cost": -1.0});
        assert_eq!(complete_attempt(&negative).cost, None);
    }

    #[test]
    fn tool_calls_capped_names_and_trustworthy_count() {
        let names: Vec<Value> = (0..6)
            .map(|i| json!({"function": {"name": format!("tool_{i}")}}))
            .collect();
        let body = json!({"choices": [{"message": {"tool_calls": names}}]});
        let out = complete_attempt(&body);
        assert_eq!(out.tool_calls.count, Some(6));
        assert_eq!(out.tool_calls.names.len(), 4);
        assert!(out.tool_calls.truncated_list);
        assert!(!out.tool_calls.truncated_names);
    }

    #[test]
    fn long_tool_name_is_preview_cut() {
        let body = json!({"choices": [{"message": {"tool_calls": [
            {"function": {"name": "x".repeat(100)}},
        ]}}]});
        let out = complete_attempt(&body);
        assert_eq!(out.tool_calls.names, ["x".repeat(80)]);
        assert!(out.tool_calls.truncated_names);
    }

    #[test]
    fn tool_only_response_has_no_text_preview() {
        let body = json!({"choices": [{"message": {
            "content": null,
            "tool_calls": [{"function": {"name": "search"}}],
        }}]});
        let out = complete_attempt(&body);
        assert!(out.response.is_none());
        assert_eq!(out.tool_calls.names, ["search"]);
        assert!(out.issues.0.is_empty()); // null content is a legal empty
    }

    #[test]
    fn tool_calls_not_array_reports_issue() {
        let body = json!({"choices": [{"message": {"tool_calls": "many"}}]});
        let out = complete_attempt(&body);
        assert_eq!(out.tool_calls.count, None);
        assert!(
            out.issues
                .0
                .contains(&super::super::ExtractIssue::InvalidFieldType)
        );
    }
}
