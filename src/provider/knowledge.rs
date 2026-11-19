// Model card researcher: asks a chat model with web search (DeepSeek's
// server-side `deepseek_web_search` tool) for one card and digests the
// answer. LLM output is untrusted: strings arrive as arrays, numbers as
// "84.5%", JSON with raw newlines or half-broken. This layer coerces,
// validates, and allows exactly one repair round without new searches.
// A card that still fails validation is an honest error, never a guess.

use crate::provider::driver::{Driver, InferenceRequest, UpstreamResponse};
use serde_json::{Map, Number, Value, json};

/// Proven budget for one research call: enough for ~8 web searches.
const MAX_TOKENS: u64 = 6_000;

#[derive(Debug)]
pub struct CollectedCard {
    /// The coerced card as canonical JSON text, ready to store.
    pub card_json: String,
    /// What the digest layer had to fix or drop; shown in the API response.
    pub repairs: Vec<String>,
}

#[derive(Debug)]
pub struct ResearchError(pub String);

impl std::fmt::Display for ResearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "research: {}", self.0)
    }
}
impl std::error::Error for ResearchError {}

const SCHEMA: &str = r#"{
  "canonical_name": "official name or null",
  "vendor": "string",
  "release_date": "YYYY-MM-DD or null",
  "description": "STRING, 3-4 sentences, no line breaks",
  "use_cases": ["up to 6 short strings"],
  "strengths": ["up to 6"],
  "weaknesses": ["up to 6"],
  "modality": "string",
  "context_window": "number or null",
  "pricing_hint": "STRING, 1 sentence, or null",
  "ratings": [{"source": "string", "metric": "string", "value": 84.5, "as_of": "YYYY-MM", "note": "string or null"}],
  "family_line": "STRING 1-2 sentences or null",
  "sources": ["url"]
}"#;

fn research_prompt(upstream_id: &str, catalog_provider: &str) -> String {
    format!(
        "Research the LLM model \"{id}\" (catalog entry of provider \"{prov}\"; \
the id may be an alias — find the real model behind it). Use web search, \
up to 8 queries. Answer with STRICT JSON matching this schema:\n{schema}\n\
Hard rules: numbers and dates only from sources; unknown = null or []; every \
rating needs a source and a month; up to 8 searches; output JSON only.",
        id = upstream_id,
        prov = catalog_provider,
        schema = SCHEMA
    )
}

fn repair_prompt(problems: &[String]) -> String {
    format!(
        "Your JSON is damaged or incomplete. Problems: {}. Return the \
CORRECTED complete JSON of the same schema. No new searches.",
        problems.join("; ")
    )
}

fn request_body(model: &str, messages: Value) -> InferenceRequest {
    InferenceRequest {
        body: json!({
            "model": model,
            "messages": messages,
            "tools": [{"type": "deepseek_web_search", "name": "deepseek_web_search"}],
            "max_tokens": MAX_TOKENS,
            "temperature": 0.0,
            "stream": false,
        }),
        // No conversation identity: this is a one-shot research call.
        session_id: String::new(),
    }
}

/// One non-streaming call; returns the assistant message content.
async fn complete_text(
    driver: &dyn Driver,
    model: &str,
    messages: Value,
) -> Result<String, ResearchError> {
    let response = driver
        .execute(model, &request_body(model, messages))
        .await
        .map_err(|e| ResearchError(format!("upstream: {e:?}")))?;
    match response {
        UpstreamResponse::Complete(body) => body
            .pointer("/choices/0/message/content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| ResearchError("no message content in answer".into())),
        UpstreamResponse::Stream(_) => Err(ResearchError(
            "upstream answered with a stream despite stream=false".into(),
        )),
    }
}

/// Extract a JSON object from model output: strip code fences, take first
/// '{' to last '}', and neutralize raw control characters inside strings
/// (models emit them; strict JSON forbids them).
fn extract_json(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    let trimmed = trimmed.strip_suffix("```").unwrap_or(trimmed);
    let start = trimmed.find('{').ok_or("no JSON object found")?;
    let end = trimmed.rfind('}').ok_or("no JSON object found")?;
    if end <= start {
        return Err("no JSON object found".into());
    }
    let slice = &trimmed[start..=end];
    let mut clean = String::with_capacity(slice.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in slice.chars() {
        let out = if in_string && matches!(ch, '\n' | '\r' | '\t') {
            ' '
        } else {
            ch
        };
        if in_string {
            if ch == '"' && !escaped {
                in_string = false;
            }
            escaped = ch == '\\' && !escaped;
        } else if ch == '"' {
            in_string = true;
            escaped = false;
        }
        clean.push(out);
    }
    serde_json::from_str(&clean).map_err(|e| format!("JSON did not parse: {e}"))
}

/// A string field: a string wins (raw line breaks collapsed), an array is
/// joined, everything else is None.
fn as_str(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => {
            let collapsed = s.split_whitespace().collect::<Vec<_>>().join(" ");
            if collapsed.is_empty() {
                None
            } else {
                Some(collapsed)
            }
        }
        Some(Value::Array(items)) => {
            let joined = items
                .iter()
                .filter_map(|x| as_str(Some(x)))
                .collect::<Vec<_>>()
                .join(" ");
            if joined.is_empty() {
                None
            } else {
                Some(joined)
            }
        }
        _ => None,
    }
}

/// A number: 84, "84.5%", "1 234" -> numbers; bools and prose are None.
fn as_num(v: Option<&Value>) -> Option<Number> {
    match v {
        Some(Value::Number(n)) => Some(n.clone()),
        Some(Value::String(s)) => {
            let num: String = s
                .chars()
                .filter(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | ' '))
                .collect();
            let num = num.trim().replace([' ', ','], "");
            if num.is_empty() {
                return None;
            }
            if let Ok(i) = num.parse::<i64>() {
                Number::from(i).into()
            } else {
                num.parse::<f64>().ok().and_then(Number::from_f64)
            }
        }
        _ => None,
    }
}

fn as_list(v: Option<&Value>, cap: usize) -> Vec<String> {
    let items = match v {
        Some(Value::String(_)) => return as_str(v).into_iter().collect(),
        Some(Value::Array(items)) => items,
        _ => return Vec::new(),
    };
    items
        .iter()
        .take(cap)
        .filter_map(|x| as_str(Some(x)))
        .collect()
}

/// Coerce one card to the contract; record everything questionable.
fn normalize(card: &Value, repairs: &mut Vec<String>) -> Value {
    let mut out = Map::new();

    fn as_date(card: &Value, repairs: &mut Vec<String>) -> Option<String> {
        let v = as_str(card.get("release_date")).or_else(|| as_str(card.get("release_date")))?;
        let parts: Vec<&str> = v.split('-').collect();
        if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) {
            return Some(v);
        }
        repairs.push("release_date: not a date -> None".into());
        None
    }
    out.insert(
        "canonical_name".into(),
        as_str(card.get("canonical_name")).into(),
    );
    out.insert("vendor".into(), as_str(card.get("vendor")).into());
    out.insert("release_date".into(), as_date(card, repairs).into());
    out.insert("description".into(), as_str(card.get("description")).into());
    out.insert(
        "use_cases".into(),
        Value::Array(
            as_list(card.get("use_cases"), 6)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert(
        "strengths".into(),
        Value::Array(
            as_list(card.get("strengths"), 6)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert(
        "weaknesses".into(),
        Value::Array(
            as_list(card.get("weaknesses"), 6)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert("modality".into(), as_str(card.get("modality")).into());
    out.insert(
        "context_window".into(),
        as_num(card.get("context_window")).into(),
    );
    out.insert(
        "pricing_hint".into(),
        as_str(card.get("pricing_hint")).into(),
    );

    let mut ratings = Vec::new();
    if let Some(Value::Array(raw)) = card.get("ratings") {
        for r in raw {
            let Value::Object(entry) = r else { continue };
            let raw_value = entry
                .get("value")
                .filter(|v| !v.is_null())
                .or_else(|| entry.get("score"));
            let value = as_num(raw_value);
            if as_str(entry.get("source")).is_none() || value.is_none() {
                repairs.push("ratings: dropped an entry without source/value".into());
                continue;
            }
            let as_of = match as_str(entry.get("as_of")) {
                Some(s) if s.len() == 7 && s.as_bytes()[4] == b'-' => Some(s),
                Some(_) => None,
                None => None,
            };
            ratings.push(json!({
                "source": as_str(entry.get("source")),
                "metric": as_str(entry.get("metric")).or(Some("value".into())),
                "value": value,
                "as_of": as_of,
                "note": as_str(entry.get("note")),
            }));
        }
    }
    out.insert("ratings".into(), Value::Array(ratings));
    out.insert("family_line".into(), as_str(card.get("family_line")).into());
    out.insert(
        "sources".into(),
        Value::Array(
            as_list(card.get("sources"), 15)
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    Value::Object(out)
}

/// Hard requirements after coercion.
fn validate(card: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    if card
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .is_empty()
    {
        errors.push("description is required (string)".into());
    }
    if card
        .get("sources")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true)
    {
        errors.push("sources is required (list of urls)".into());
    }
    errors
}

/// Research one model: collect, digest, validate; on failure exactly one
/// repair round without new searches.
pub async fn research_card(
    driver: &dyn Driver,
    model: &str,
    upstream_id: &str,
    catalog_provider: &str,
) -> Result<CollectedCard, ResearchError> {
    let mut messages = vec![json!({
        "role": "user",
        "content": research_prompt(upstream_id, catalog_provider),
    })];
    let mut repairs: Vec<String> = Vec::new();
    let mut last_errors = Vec::new();

    for attempt in 1..=2 {
        let text = complete_text(driver, model, Value::Array(messages.clone())).await?;
        let card = match extract_json(&text) {
            Ok(v) => normalize(&v, &mut repairs),
            Err(e) => {
                repairs.push(format!("attempt {attempt}: {e}"));
                normalize(&Value::Null, &mut repairs)
            }
        };
        let errors = validate(&card);
        if errors.is_empty() {
            return Ok(CollectedCard {
                card_json: serde_json::to_string(&card)
                    .map_err(|e| ResearchError(format!("canonical encode: {e}")))?,
                repairs,
            });
        }
        last_errors = errors;
        // Repair round: show the assistant its own output and the problems.
        messages.push(json!({"role": "assistant", "content": text}));
        let mut problems = last_errors.clone();
        problems.extend(repairs.iter().take(5).cloned());
        messages.push(json!({
            "role": "user",
            "content": repair_prompt(&problems),
        }));
    }
    Err(ResearchError(format!(
        "card still invalid after one repair round: {}",
        last_errors.join("; ")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::future::BoxFuture;
    use std::collections::VecDeque;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A driver answering from a queue of message contents, one per call.
    struct QueueDriver {
        contents: Mutex<VecDeque<String>>,
        calls: AtomicUsize,
        stream_once: bool,
    }

    impl QueueDriver {
        fn new(contents: &[&str]) -> Self {
            Self {
                contents: Mutex::new(contents.iter().map(|s| s.to_string()).collect()),
                calls: AtomicUsize::new(0),
                stream_once: false,
            }
        }
    }

    impl Driver for QueueDriver {
        fn catalog_mode(&self) -> crate::provider::driver::CatalogMode {
            crate::provider::driver::CatalogMode::Dynamic
        }
        fn fetch_catalog(
            &self,
        ) -> BoxFuture<
            'static,
            Result<
                Vec<crate::provider::driver::DiscoveredModel>,
                crate::routing::classify::DriverError,
            >,
        > {
            Box::pin(async { Ok(Vec::new()) })
        }
        fn fetch_observations(
            &self,
        ) -> BoxFuture<
            'static,
            Result<
                Option<Vec<crate::provider::driver::Indicator>>,
                crate::routing::classify::DriverError,
            >,
        > {
            Box::pin(async { Ok(None) })
        }
        fn fetch_local_state(
            &self,
        ) -> BoxFuture<
            'static,
            Result<
                Option<crate::provider::driver::LocalState>,
                crate::routing::classify::DriverError,
            >,
        > {
            Box::pin(async { Ok(None) })
        }
        fn execute<'a>(
            &'a self,
            model: &'a str,
            request: &'a InferenceRequest,
        ) -> BoxFuture<'a, Result<UpstreamResponse, crate::routing::classify::DriverError>>
        {
            Box::pin(async move {
                assert_eq!(model, "deepseek-flash");
                assert_eq!(request.body["stream"], false);
                assert_eq!(request.body["tools"][0]["type"], "deepseek_web_search");
                self.calls.fetch_add(1, Ordering::SeqCst);
                if self.stream_once {
                    return Ok(UpstreamResponse::Stream(Box::pin(
                        futures_util::stream::empty(),
                    )));
                }
                let content = self
                    .contents
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap_or_default();
                Ok(UpstreamResponse::Complete(json!({
                    "choices": [{"message": {"content": content}}]
                })))
            })
        }
    }

    const GOOD_CARD: &str = r#"```json
{"canonical_name": "GLM 5.3", "vendor": "Z.ai", "release_date": "2026-09-30",
 "description": ["General-purpose model.", "Strong at code."],
 "use_cases": ["coding", "agentic", "long context"],
 "strengths": "single string not array",
 "weaknesses": [],
 "modality": "text",
 "context_window": "256,000 tokens",
 "pricing_hint": null,
 "ratings": [
   {"source": "Artificial Analysis", "metric": "Output speed", "value": "84.5 tok/s"},
   {"source": "LMArena", "score": 1421, "as_of": "2026-10"},
   {"metric": "orphan without source", "value": 1}
 ],
 "family_line": "GLM open family since 2023.",
 "sources": ["https://z.ai/glm"]}
```"#;

    #[tokio::test]
    async fn coerces_a_messy_but_real_card_in_one_call() {
        let driver = QueueDriver::new(&[GOOD_CARD]);
        let card = research_card(&driver, "deepseek-flash", "z-ai/glm-5.3", "zai")
            .await
            .unwrap();
        assert_eq!(driver.calls.load(Ordering::SeqCst), 1);

        let v: Value = serde_json::from_str(&card.card_json).unwrap();
        // description array -> joined string
        assert_eq!(v["description"], "General-purpose model. Strong at code.");
        // strengths string -> single-item list
        assert_eq!(v["strengths"], json!(["single string not array"]));
        // "256,000 tokens" -> number
        assert_eq!(v["context_window"], json!(256000));
        // "84.5 tok/s" -> number; score alias accepted; orphan rating dropped
        assert_eq!(v["ratings"].as_array().unwrap().len(), 2);
        assert_eq!(v["ratings"][0]["value"], json!(84.5));
        assert_eq!(v["ratings"][1]["value"], json!(1421));
        assert!(card.repairs.iter().any(|r| r.contains("dropped")));
    }

    #[tokio::test]
    async fn repairs_broken_json_once_then_succeeds() {
        let driver = QueueDriver::new(&["Sure! Here is the card: {truncated...}", GOOD_CARD]);
        let card = research_card(&driver, "deepseek-flash", "glm-5.3", "zai")
            .await
            .unwrap();
        assert_eq!(driver.calls.load(Ordering::SeqCst), 2);
        assert!(card.repairs.iter().any(|r| r.contains("did not parse")));
    }

    #[tokio::test]
    async fn fails_honestly_after_one_repair_round() {
        let driver = QueueDriver::new(&["{\"nope\": 1}", "{\"still\": 2}"]);
        let err = research_card(&driver, "deepseek-flash", "glm-5.3", "zai")
            .await
            .unwrap_err();
        assert_eq!(driver.calls.load(Ordering::SeqCst), 2);
        assert!(err.0.contains("description is required"));
    }

    #[test]
    fn raw_newlines_inside_json_strings_are_neutralized() {
        let dirty = "{\"description\": \"line one\nline two\", \"sources\": [\"u\"]}";
        assert!(serde_json::from_str::<Value>(dirty).is_err());
        let extracted = extract_json(dirty).unwrap();
        assert_eq!(extracted["description"], "line one line two");
    }

    #[tokio::test]
    async fn a_stream_answer_is_an_error() {
        let driver = QueueDriver {
            contents: Mutex::new(VecDeque::new()),
            calls: AtomicUsize::new(0),
            stream_once: true,
        };
        let err = research_card(&driver, "deepseek-flash", "glm-5.3", "zai")
            .await
            .unwrap_err();
        assert!(err.0.contains("stream"));
    }
}
