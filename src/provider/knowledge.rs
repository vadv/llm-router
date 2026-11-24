// Model card researcher: asks a chat model with web search (DeepSeek's
// server-side `deepseek_web_search` tool) for one card and digests the
// answer. LLM output is untrusted: strings arrive as arrays, numbers as
// "84.5%", JSON with raw newlines or half-broken. This layer coerces,
// validates, and allows exactly one repair round without new searches.
// A card that still fails validation is an honest error, never a guess.

use crate::provider::driver::{Driver, InferenceRequest, UpstreamResponse};
use serde_json::{Map, Number, Value, json};

/// Proven budget for one research call: enough for ~10 web searches and
/// a full card.
const MAX_TOKENS: u64 = 8_000;

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

// What a model takes in and gives out, as the dashboard spells them.
const INPUT_MODALITIES: [&str; 5] = ["text", "image", "video", "audio", "pdf"];
const OUTPUT_MODALITIES: [&str; 4] = ["text", "image", "audio", "video"];
const REASONING: [&str; 3] = ["always", "optional", "none"];
// What a model is for, in words a filter can match.
const TAGS: [&str; 18] = [
    "coding",
    "agents",
    "reasoning",
    "math",
    "vision",
    "audio",
    "long-context",
    "fast",
    "cheap",
    "chat",
    "writing",
    "multilingual",
    "embedding",
    "image-generation",
    "speech",
    "open-weights",
    "on-device",
    "roleplay",
];

// Facts the Wiki compares across models are asked for as numbers and lists,
// never as prose: a price is read, not parsed out of a sentence.
const SCHEMA: &str = r#"{
  "canonical_name": "official model name or null",
  "vendor": "canonical company name, e.g. \"Anthropic\", \"Alibaba Cloud\"",
  "release_date": "YYYY-MM-DD or null",
  "snapshot": "the exact model version this id serves, when the id is an alias or a moving pointer; otherwise null",
  "description": "STRING, 2-3 sentences, no line breaks: what the model is, what it is best at, where it falls short. Do not restate the numbers and lists below",
  "tags": ["up to 6, only from: coding, agents, reasoning, math, vision, audio, long-context, fast, cheap, chat, writing, multilingual, embedding, image-generation, speech, open-weights, on-device, roleplay"],
  "use_cases": ["up to 6 short strings"],
  "strengths": ["up to 6 short strings"],
  "weaknesses": ["up to 6 short strings"],
  "input_modalities": ["only from: text, image, video, audio, pdf"],
  "output_modalities": ["only from: text, image, audio, video"],
  "context_window": "number of tokens or null",
  "max_output_tokens": "number of tokens or null",
  "parameters": "e.g. \"397B total, 17B active\" or null",
  "license": "e.g. \"Apache 2.0\", \"MIT\", \"proprietary\" or null",
  "open_weights": "true, false or null",
  "knowledge_cutoff": "YYYY-MM or null",
  "reasoning": "\"always\" if the model always reasons, \"optional\" if the caller can switch reasoning on, \"none\", or null",
  "tool_calling": "true, false or null",
  "structured_output": "true, false or null",
  "speed": {"output_tokens_per_second": "number or null", "time_to_first_token_seconds": "number or null", "source": "who measured", "as_of": "YYYY-MM or null"},
  "pricing": {
    "currency": "USD",
    "input_per_1m": "number or null",
    "cached_input_per_1m": "number or null",
    "output_per_1m": "number or null",
    "note": "one sentence on tiers, free tiers or promotions, or null"
  },
  "ratings": [{"source": "who published the number", "metric": "benchmark name exactly as its publisher writes it, without effort or tool conditions", "value": 84.5, "as_of": "YYYY-MM", "url": "url of the page that shows this number, or null", "note": "conditions such as the reasoning effort, or null"}],
  "family_line": "STRING 1-2 sentences or null",
  "sources": ["url"]
}"#;

fn research_prompt(upstream_id: &str, catalog_provider: &str) -> String {
    format!(
        "Research the LLM model \"{id}\" (catalog entry of provider \"{prov}\"; \
the id may be an alias — find the real model behind it). Use web search, \
up to 10 queries. Answer with STRICT JSON matching this schema:\n{schema}\n\
Hard rules: numbers and dates only from sources; unknown = null or []; \
every rating needs a source and a month, and independent evaluations \
(Artificial Analysis, LMArena, SWE-bench, Epoch AI) are preferred over the \
vendor's own numbers; report up to 10 ratings; prices are the standard list \
price per million tokens, zero only when it is really free; up to 10 \
searches; output JSON only.",
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

// How a model words a known value: "images", "vision" and "documents" are
// read as the value they mean.
const SYNONYMS: [(&str, &str); 12] = [
    ("images", "image"),
    ("vision", "image"),
    ("visual", "image"),
    ("speech", "audio"),
    ("voice", "audio"),
    ("audios", "audio"),
    ("videos", "video"),
    ("file", "pdf"),
    ("files", "pdf"),
    ("document", "pdf"),
    ("documents", "pdf"),
    ("text-only", "text"),
];

/// A list kept to its known values, lowercased and without repeats. "Text"
/// and " images " are read; anything else is dropped and reported.
fn as_enum_list(
    v: Option<&Value>,
    allowed: &[&str],
    field: &str,
    repairs: &mut Vec<String>,
) -> Vec<String> {
    let items: Vec<String> = match v {
        Some(Value::String(s)) => s.split(',').map(str::to_string).collect(),
        Some(Value::Array(items)) => items.iter().filter_map(|x| as_str(Some(x))).collect(),
        _ => Vec::new(),
    };
    let mut out = Vec::new();
    for item in items {
        let spelled = item.trim().to_ascii_lowercase().replace(['_', ' '], "-");
        let name = allowed
            .contains(&spelled.as_str())
            .then_some(spelled.clone())
            .or_else(|| {
                SYNONYMS
                    .iter()
                    .find(|(from, _)| *from == spelled)
                    .map(|(_, to)| (*to).to_string())
            })
            .unwrap_or(spelled);
        if allowed.contains(&name.as_str()) {
            if !out.contains(&name) {
                out.push(name);
            }
        } else if !name.is_empty() {
            repairs.push(format!("{field}: unknown value '{name}' dropped"));
        }
    }
    out
}

/// A list as a phrase: "text", "text and image", "text, image, and pdf".
fn list_prose(items: &[String]) -> String {
    match items.len() {
        0 => String::new(),
        1 => items[0].clone(),
        2 => format!("{} and {}", items[0], items[1]),
        n => format!("{}, and {}", items[..n - 1].join(", "), items[n - 1]),
    }
}

/// `true`, `"yes"` and `1` are true; `false`, `"no"` and `0` are false.
fn as_bool(v: Option<&Value>) -> Option<bool> {
    match v {
        Some(Value::Bool(b)) => Some(*b),
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0),
        Some(Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "yes" => Some(true),
            "false" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// One of a fixed set of words, however it is cased.
fn as_choice(v: Option<&Value>, allowed: &[&str]) -> Option<String> {
    let text = as_str(v)?;
    allowed
        .iter()
        .find(|choice| **choice == text.trim().to_ascii_lowercase())
        .map(|choice| (*choice).to_string())
}

/// A price that is a non-negative finite number, or nothing.
fn as_price(v: Option<&Value>) -> Option<Number> {
    as_num(v).filter(|n| n.as_f64().is_some_and(|x| x.is_finite() && x >= 0.0))
}

/// A token count. 128000, "128,000 tokens" and "128K" are one number; a
/// figure in a unit this does not know (billions) is nothing.
fn as_token_count(v: Option<&Value>) -> Option<Number> {
    let text = match v {
        Some(Value::String(text)) => text,
        other => return as_num(other),
    };
    let chars: Vec<char> = text.trim().chars().collect();
    let start = chars.iter().position(|c| c.is_ascii_digit())?;
    let mut end = start;
    while end < chars.len()
        && (chars[end].is_ascii_digit() || matches!(chars[end], '.' | ',' | ' '))
    {
        end += 1;
    }
    while end > start && chars[end - 1] == ' ' {
        end -= 1;
    }
    let figure: String = chars[start..end].iter().filter(|c| **c != ',').collect();
    let mut unit_at = end;
    while unit_at < chars.len() && chars[unit_at] == ' ' {
        unit_at += 1;
    }
    // One letter after the figure is a unit ("128K", "1 M"); a word is
    // just a word ("256,000 tokens").
    let scale = match chars.get(unit_at) {
        Some(unit)
            if unit.is_ascii_alphabetic()
                && !chars
                    .get(unit_at + 1)
                    .is_some_and(char::is_ascii_alphabetic) =>
        {
            match unit {
                'k' | 'K' => 1_000.0,
                'm' | 'M' => 1_000_000.0,
                _ => return None,
            }
        }
        _ => 1.0,
    };
    figure
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|x| x.is_finite() && *x >= 0.0)
        .map(|x| x * scale)
        .and_then(|x| {
            if x.fract() == 0.0 && x <= i64::MAX as f64 {
                Number::from(x as i64).into()
            } else {
                Number::from_f64(x)
            }
        })
}

/// The pricing object: amounts as numbers, the currency as a code. Null
/// when no amount arrived, so a reader never mistakes a missing price for
/// a free one.
fn as_pricing(card: &Value) -> Value {
    let Some(Value::Object(pricing)) = card.get("pricing") else {
        return Value::Null;
    };
    let input = as_price(pricing.get("input_per_1m"));
    let cached = as_price(pricing.get("cached_input_per_1m"));
    let output = as_price(pricing.get("output_per_1m"));
    if input.is_none() && cached.is_none() && output.is_none() {
        return Value::Null;
    }
    json!({
        "currency": as_str(pricing.get("currency"))
            .map(|c| c.trim().to_ascii_uppercase())
            .filter(|c| c.len() == 3)
            .unwrap_or("USD".into()),
        "input_per_1m": input,
        "cached_input_per_1m": cached,
        "output_per_1m": output,
        "note": as_str(pricing.get("note")),
    })
}

/// The pricing object as the sentence older readers expect.
fn pricing_prose(pricing: &Value) -> Option<String> {
    let price = |key: &str| pricing.get(key).and_then(Value::as_f64);
    let currency = pricing
        .get("currency")
        .and_then(Value::as_str)
        .unwrap_or("USD");
    // "$8", "$1.131", "$0.007", "$0.000035": the digits the card states.
    let amount = |x: f64| {
        let digits = if x < 0.001 {
            6
        } else if x < 0.01 {
            5
        } else {
            3
        };
        let text = if x.fract() == 0.0 {
            format!("{}", x as i64)
        } else {
            format!("{x:.digits$}")
                .trim_end_matches('0')
                .trim_end_matches('.')
                .to_string()
        };
        if currency == "USD" {
            format!("${text}")
        } else {
            format!("{currency} {text}")
        }
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(x) = price("input_per_1m") {
        parts.push(format!("{} per 1M input tokens", amount(x)));
    }
    if let Some(x) = price("cached_input_per_1m") {
        parts.push(format!("{} per 1M cached input", amount(x)));
    }
    if let Some(x) = price("output_per_1m") {
        parts.push(format!("{} per 1M output tokens", amount(x)));
    }
    let last = parts.pop()?;
    let mut sentence = if parts.is_empty() {
        last
    } else {
        format!("{} and {last}", parts.join(", "))
    };
    sentence.push('.');
    if let Some(note) = pricing
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|note| !note.is_empty())
    {
        sentence.push(' ');
        sentence.push_str(note.trim_end_matches('.'));
        sentence.push('.');
    }
    Some(sentence)
}

/// A month "YYYY-MM", or nothing.
fn as_month(v: Option<&Value>) -> Option<String> {
    as_str(v).filter(|s| s.len() == 7 && s.as_bytes()[4] == b'-')
}

/// A time to first token a person would wait for. A figure of minutes is
/// a confusion with something else (a benchmark runtime, a latency score),
/// and showing it would be a false fact.
fn as_first_token(v: Option<&Value>) -> Option<Number> {
    as_price(v).filter(|n| n.as_f64().is_some_and(|x| x > 0.0 && x < 120.0))
}

/// Measured speed: output tokens per second and time to first token, with
/// who measured. Null when neither was measured.
fn as_speed(v: Option<&Value>) -> Value {
    let Some(Value::Object(speed)) = v else {
        return Value::Null;
    };
    let tokens = as_price(speed.get("output_tokens_per_second"));
    let first = as_first_token(speed.get("time_to_first_token_seconds"));
    if tokens.is_none() && first.is_none() {
        return Value::Null;
    }
    json!({
        "output_tokens_per_second": tokens,
        "time_to_first_token_seconds": first,
        "source": as_str(speed.get("source")),
        "as_of": as_month(speed.get("as_of")),
    })
}

/// Coerce one card to the contract; record everything questionable.
fn normalize(card: &Value, repairs: &mut Vec<String>) -> Value {
    let mut out = Map::new();

    fn as_date(card: &Value, repairs: &mut Vec<String>) -> Option<String> {
        let v = as_str(card.get("release_date"))?;
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
    let input = as_enum_list(
        card.get("input_modalities"),
        &INPUT_MODALITIES,
        "input_modalities",
        repairs,
    );
    let output = as_enum_list(
        card.get("output_modalities"),
        &OUTPUT_MODALITIES,
        "output_modalities",
        repairs,
    );
    // Readers that predate the lists get the same facts as a sentence.
    let modality = (!input.is_empty() || !output.is_empty()).then(|| {
        let prose = format!(
            "{} input; {} output",
            list_prose(&input),
            list_prose(&output)
        );
        let mut chars = prose.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    });
    let pricing = as_pricing(card);
    let pricing_hint = pricing_prose(&pricing);
    out.insert(
        "modality".into(),
        as_str(card.get("modality")).or(modality).into(),
    );
    out.insert(
        "context_window".into(),
        as_token_count(card.get("context_window")).into(),
    );
    out.insert(
        "max_output_tokens".into(),
        as_token_count(card.get("max_output_tokens")).into(),
    );
    out.insert("parameters".into(), as_str(card.get("parameters")).into());
    out.insert("license".into(), as_str(card.get("license")).into());
    out.insert(
        "open_weights".into(),
        as_bool(card.get("open_weights")).into(),
    );
    out.insert(
        "knowledge_cutoff".into(),
        as_month(card.get("knowledge_cutoff")).into(),
    );
    out.insert(
        "reasoning".into(),
        as_choice(card.get("reasoning"), &REASONING).into(),
    );
    out.insert(
        "tool_calling".into(),
        as_bool(card.get("tool_calling")).into(),
    );
    out.insert(
        "structured_output".into(),
        as_bool(card.get("structured_output")).into(),
    );
    out.insert("snapshot".into(), as_str(card.get("snapshot")).into());
    out.insert(
        "tags".into(),
        json!(as_enum_list(card.get("tags"), &TAGS, "tags", repairs)),
    );
    out.insert("speed".into(), as_speed(card.get("speed")));
    out.insert("input_modalities".into(), json!(input));
    out.insert("output_modalities".into(), json!(output));
    out.insert("pricing".into(), pricing);
    out.insert(
        "pricing_hint".into(),
        as_str(card.get("pricing_hint")).or(pricing_hint).into(),
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
                "url": as_str(entry.get("url")),
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

    // A real answer shape: fenced, with arrays where strings belong, numbers
    // with units, and a rating that has no source.
    const GOOD_CARD: &str = r#"```json
{"canonical_name": "GLM 5.3", "vendor": "Z.ai", "release_date": "2026-09-30",
 "description": ["General-purpose model.", "Strong at code."],
 "snapshot": "GLM-5.3-20260930",
 "tags": ["Coding", "agents", "holography", "coding"],
 "use_cases": ["coding", "agentic", "long context"],
 "strengths": "single string not array",
 "weaknesses": [],
 "input_modalities": ["Text", " images "],
 "output_modalities": "text",
 "context_window": "256,000 tokens",
 "max_output_tokens": "128K",
 "license": "MIT",
 "open_weights": "yes",
 "knowledge_cutoff": "around March",
 "reasoning": "Optional",
 "tool_calling": false,
 "speed": {"output_tokens_per_second": "84.5 tok/s", "time_to_first_token_seconds": 0.8, "source": "Artificial Analysis", "as_of": "2026-10"},
 "pricing": {"currency": "usd", "input_per_1m": "$1.13", "cached_input_per_1m": null, "output_per_1m": -6, "note": "Free on OpenRouter's free endpoint."},
 "ratings": [
   {"source": "Artificial Analysis", "metric": "Output speed", "value": "84.5 tok/s", "url": "https://artificialanalysis.ai/models/glm-5-3"},
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
        assert_eq!(
            v["ratings"][0]["url"],
            "https://artificialanalysis.ai/models/glm-5-3"
        );
        assert!(card.repairs.iter().any(|r| r.contains("dropped")));
    }

    #[tokio::test]
    async fn structured_facts_are_numbers_and_known_words() {
        let driver = QueueDriver::new(&[GOOD_CARD]);
        let card = research_card(&driver, "deepseek-flash", "z-ai/glm-5.3", "zai")
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&card.card_json).unwrap();
        // Tags: known words lowercased, repeats and unknown words dropped.
        assert_eq!(v["tags"], json!(["coding", "agents"]));
        assert!(card.repairs.iter().any(|r| r.contains("holography")));
        // Modalities: "Text" and " images " are read, nothing else.
        assert_eq!(v["input_modalities"], json!(["text", "image"]));
        assert_eq!(v["output_modalities"], json!(["text"]));
        // A negative price is not a price.
        assert_eq!(v["pricing"]["input_per_1m"], json!(1.13));
        assert!(v["pricing"]["output_per_1m"].is_null());
        assert_eq!(v["pricing"]["currency"], "USD");
        // "128K" is 128,000 tokens.
        assert_eq!(v["max_output_tokens"], json!(128000));
        assert_eq!(v["license"], "MIT");
        assert_eq!(v["open_weights"], true);
        assert_eq!(v["reasoning"], "optional");
        assert_eq!(v["tool_calling"], false);
        // A cutoff that is not a month is dropped, never guessed.
        assert!(v["knowledge_cutoff"].is_null());
        assert_eq!(v["snapshot"], "GLM-5.3-20260930");
        assert_eq!(v["speed"]["output_tokens_per_second"], json!(84.5));
        assert_eq!(v["speed"]["time_to_first_token_seconds"], json!(0.8));
        assert_eq!(v["speed"]["source"], "Artificial Analysis");
        assert_eq!(v["speed"]["as_of"], "2026-10");
    }

    #[test]
    fn a_first_token_time_in_minutes_is_not_shown_as_one() {
        let speed = |seconds: Value| {
            as_speed(Some(&json!({
                "output_tokens_per_second": 73,
                "time_to_first_token_seconds": seconds,
                "source": "Artificial Analysis",
                "as_of": "2026-08",
            })))
        };
        assert_eq!(speed(json!(1.2))["time_to_first_token_seconds"], json!(1.2));
        // A reasoning model can make a person wait a minute and a half.
        assert_eq!(
            speed(json!(81.07))["time_to_first_token_seconds"],
            json!(81.07)
        );
        assert!(speed(json!(810.7))["time_to_first_token_seconds"].is_null());
        assert!(speed(json!(0.0))["time_to_first_token_seconds"].is_null());
        // The tokens-per-second figure survives a bad time next to it.
        assert_eq!(speed(json!(810.7))["output_tokens_per_second"], json!(73));
    }

    #[tokio::test]
    async fn structured_facts_also_read_as_the_sentences_older_readers_expect() {
        let driver = QueueDriver::new(&[GOOD_CARD]);
        let card = research_card(&driver, "deepseek-flash", "z-ai/glm-5.3", "zai")
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&card.card_json).unwrap();
        assert_eq!(v["modality"], "Text and image input; text output");
        assert_eq!(
            v["pricing_hint"],
            "$1.13 per 1M input tokens. Free on OpenRouter's free endpoint."
        );
    }

    #[test]
    fn prose_sentences_keep_the_digits_the_card_states() {
        let price = |json: Value| pricing_prose(&json).unwrap();
        assert_eq!(
            price(
                json!({"currency": "USD", "input_per_1m": 8, "cached_input_per_1m": 0.8, "output_per_1m": 40})
            ),
            "$8 per 1M input tokens, $0.8 per 1M cached input and $40 per 1M output tokens."
        );
        assert_eq!(
            price(json!({"currency": "USD", "input_per_1m": 1.131, "output_per_1m": 3.957})),
            "$1.131 per 1M input tokens and $3.957 per 1M output tokens."
        );
        assert_eq!(
            price(json!({"currency": "USD", "input_per_1m": 0.000035, "output_per_1m": 0.00007})),
            "$0.000035 per 1M input tokens and $0.00007 per 1M output tokens."
        );
        assert_eq!(
            price(json!({"currency": "CNY", "input_per_1m": 2, "output_per_1m": 10})),
            "CNY 2 per 1M input tokens and CNY 10 per 1M output tokens."
        );
        // A card without amounts has no price sentence.
        assert!(pricing_prose(&Value::Null).is_none());
        assert!(pricing_prose(&json!({"currency": "USD", "note": "Subscription only"})).is_none());
    }

    #[test]
    fn a_card_from_before_the_structured_fields_still_normalizes() {
        let mut repairs = Vec::new();
        let v = normalize(
            &json!({"description": "d", "modality": "text", "pricing_hint": "$1 in, $2 out.", "sources": ["u"]}),
            &mut repairs,
        );
        assert!(validate(&v).is_empty());
        assert_eq!(v["modality"], "text");
        assert_eq!(v["pricing_hint"], "$1 in, $2 out.");
        for field in [
            "pricing",
            "speed",
            "max_output_tokens",
            "license",
            "open_weights",
            "knowledge_cutoff",
            "reasoning",
            "tool_calling",
            "structured_output",
            "snapshot",
            "parameters",
        ] {
            assert!(v[field].is_null(), "{field} should be null, not invented");
        }
        assert_eq!(v["tags"], json!([]));
        assert_eq!(v["input_modalities"], json!([]));
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
