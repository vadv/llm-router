// The WorkBuddy driver (the international CodeBuddy build, www.workbuddy.ai,
// `ck_…` API keys). Wire contract measured live and cross-checked against
// the community provider plugin: OpenAI-shaped chat on /v2/chat/completions
// that only ever streams, an app-channel /v3/config catalog, and credit
// balances from the /v2 billing meter. The CLI-shaped headers are part of
// the upstream's contract, not camouflage we chose.

use super::error_excerpt;
use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{AuthKind, ChatCompletionsTransport, TransportFailure};
use crate::routing::classify::{DriverError, FailureClass};
use serde_json::{Value, json};

/// The chat endpoint presents itself as the CLI agent; the config endpoint
/// only answers the full document (with the model list) to the product UA
/// carrying the CLI channel. Both measured: any other shape returns a
/// reduced doc without `models`.
const CHAT_UA: &str = "CLI/2.63.2 CodeBuddy/2.63.2";
const CONFIG_UA: &str = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";

/// Reason string cap for history: diagnostic text, not a body dump.
const MESSAGE_LIMIT: usize = 200;

/// The personal credit packages the meter reports for ProductCode p_tcaca
/// (the AI Code Assistant). Status 3 entries are spent packs kept for
/// history; they never add balance.
const PRODUCT_CODE: &str = "p_tcaca";

pub struct WorkBuddyDriver {
    /// Chat transport rooted at the API version path ({base}/v2).
    transport: ChatCompletionsTransport,
    /// The account root (scheme://host), for /v3/config and the meter.
    base: String,
    key: String,
    /// `anonymous_<last 8 key chars>`: the documented companion of key auth.
    user_id: String,
    timeouts: HttpTimeouts,
}

impl WorkBuddyDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        let base = base_url.trim_end_matches('/').to_owned();
        WorkBuddyDriver {
            transport: ChatCompletionsTransport::new(
                &format!("{base}/v2"),
                Some(api_key),
                timeouts,
            ),
            base,
            key: api_key.to_owned(),
            user_id: format!("anonymous_{}", &api_key[api_key.len().saturating_sub(8)..]),
            timeouts,
        }
    }

    /// The shared auth/identity headers every data-plane call carries. The
    /// Bearer key rides separately (transport auth), so the key name never
    /// appears twice in different forms.
    fn common_headers(&self) -> Vec<(&'static str, String)> {
        vec![
            ("x-api-key", self.key.clone()),
            ("x-user-id", self.user_id.clone()),
            ("x-product", "SaaS".into()),
            ("x-no-enterprise-id", "1".into()),
            ("x-no-department-info", "1".into()),
        ]
    }

    fn owned_headers<'a>(extra: &'a [(&'static str, String)]) -> Vec<(&'static str, &'a str)> {
        extra.iter().map(|(n, v)| (*n, v.as_str())).collect()
    }
}

impl Driver for WorkBuddyDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let mut headers = vec![("user-agent", CONFIG_UA.to_owned())];
            headers.extend(self.common_headers());
            let value = self
                .transport
                .get_json_with_headers(
                    &format!("{}/v3/config", self.base),
                    self.timeouts.catalog,
                    AuthKind::Bearer,
                    &Self::owned_headers(&headers),
                )
                .await
                .map_err(classify)?;
            parse_catalog(&value).map_err(|reason| DriverError {
                // A bad catalog envelope is upstream trouble, not quota, and
                // an error never becomes an empty catalog: the old snapshot
                // stays in force.
                class: FailureClass::Transient,
                message: format!("workbuddy catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let mut headers = vec![("user-agent", CONFIG_UA.to_owned())];
            headers.extend(self.common_headers());
            let now = now_unix();
            let value = self
                .transport
                .post_json_with_headers(
                    &format!(
                        "{base}/v2/billing/meter/get-user-resource",
                        base = self.base
                    ),
                    self.timeouts.catalog,
                    AuthKind::Bearer,
                    &Self::owned_headers(&headers),
                    &billing_query(now),
                )
                .await
                .map_err(classify)?;
            parse_credits(&value)
                .map(Some)
                .map_err(|reason| DriverError {
                    // A bad envelope is upstream trouble, never zero credits:
                    // the last good observations stay in force.
                    class: FailureClass::Transient,
                    message: format!("workbuddy meter: {reason}"),
                })
        })
    }

    fn fetch_local_state(&self) -> BoxFuture<'_, Result<Option<LocalState>, DriverError>> {
        Box::pin(async { Ok(None) })
    }

    fn execute<'a>(
        &'a self,
        model: &'a str,
        request: &'a InferenceRequest,
    ) -> BoxFuture<'a, Result<UpstreamResponse, DriverError>> {
        Box::pin(async move {
            let prepared = InferenceRequest {
                body: prepare_body(&request.body),
                session_id: request.session_id.clone(),
            };
            let mut headers = vec![
                ("user-agent", CHAT_UA.to_owned()),
                ("x-conversation-id", fresh_uuid()),
                ("x-request-id", fresh_uuid()),
                ("x-message-id", fresh_uuid()),
            ];
            headers.extend(self.common_headers());
            self.transport
                .execute_with_headers(model, &prepared, &Self::owned_headers(&headers))
                .await
                .map_err(classify)
        })
    }
}

/// Shape the body into the only form /v2/chat/completions accepts: always a
/// stream (non-streaming is refused with code 11101), a system message
/// first (its absence reads as a foreign channel, code 11128), no
/// `developer` role, and `tool_choice` as the plain type string the
/// endpoint understands. Everything else passes through verbatim.
fn prepare_body(body: &Value) -> Value {
    let mut body = body.clone();
    if !body.is_object() {
        return body;
    }
    body["stream"] = json!(true);
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages.iter_mut() {
            if message.get("role") == Some(&json!("developer")) {
                message["role"] = json!("system");
            }
        }
        let needs_system = messages
            .first()
            .and_then(|m| m.get("role"))
            .and_then(Value::as_str)
            .map(|role| role == "system")
            != Some(true);
        if needs_system {
            messages.insert(
                0,
                json!({"role": "system", "content": "You are a helpful assistant."}),
            );
        }
    }
    if let Some(kind) = body
        .get("tool_choice")
        .and_then(|choice| choice.get("type"))
        .and_then(Value::as_str)
    {
        body["tool_choice"] = json!(kind);
    }
    body
}

/// WorkBuddy error semantics: the numeric `code` in the body decides, the
/// HTTP status only breaks ties. Codes measured live or documented by the
/// community client.
fn classify(failure: TransportFailure) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http {
            status,
            retry_after,
            body,
        } => classify_http(status.as_u16(), body, retry_after.as_deref(), now_unix()),
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!("workbuddy upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("workbuddy network: {err}"),
        TransportFailure::FirstByteTimeout => "workbuddy first byte timeout".into(),
        TransportFailure::AttemptTimeout => "workbuddy attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

fn classify_http(
    status: u16,
    body: &str,
    retry_after: Option<&str>,
    now_unix: i64,
) -> FailureClass {
    if let Some(code) = body_code(body) {
        return match code {
            // Credits or the free-tier allowance ran out: durable for this
            // account until a package resets; WorkBuddy sends no reset time.
            14018 => FailureClass::QuotaExhausted {
                reset_at_unix: None,
            },
            // Queue pressure and load: retryable, never a ban.
            6020 | 6021 | 6022 | 14003 | 11134 => FailureClass::Transient,
            // The session or account stopped being valid: broken connection.
            12153 | 11140 => FailureClass::InvalidBackend,
            // Request shapes WorkBuddy refuses (context overflow, foreign
            // channel, non-stream). A different member may accept the same body.
            11101 | 11115 | 11128 if status != 400 => FailureClass::InvalidRequest,
            _ => classify_status(status, retry_after, now_unix),
        };
    }
    classify_status(status, retry_after, now_unix)
}

fn classify_status(status: u16, retry_after: Option<&str>, now_unix: i64) -> FailureClass {
    match status {
        401 | 403 => FailureClass::InvalidBackend,
        400 => FailureClass::UpstreamBadRequest,
        404 | 413 | 422 => FailureClass::InvalidRequest,
        // A bare 429 without a body code is plain pressure; the only
        // documented reset form is plain seconds.
        429 => rate_limited(retry_after, now_unix),
        502..=504 => FailureClass::Transient,
        _ => FailureClass::Unknown,
    }
}

/// Retry-After as plain seconds, the only form WorkBuddy documents; the
/// value is a deadline, routing caps how far out it may sit.
fn rate_limited(retry_after: Option<&str>, now_unix: i64) -> FailureClass {
    let retry_after_unix = retry_after
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| now_unix + secs);
    FailureClass::RateLimited { retry_after_unix }
}

/// The numeric `code` at the top of the error envelope, encoded as a number
/// or a numeric string; the bare `code:0` of a success envelope never
/// reaches here (only failures are classified).
fn body_code(body: &str) -> Option<i64> {
    let value = serde_json::from_str::<Value>(body).ok()?;
    match value.get("code")? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

/// Parse the /v3/config envelope `{code, msg, data:{models[]}}`. Entries
/// without `maxInputTokens` are the image/video engines, not chat models:
/// skipped, not errors.
fn parse_catalog(value: &Value) -> Result<Vec<DiscoveredModel>, String> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => {}
        Some(code) => return Err(format!("config_envelope_code_{code}")),
        None => return Err("config_envelope_schema_error".into()),
    }
    let models = value
        .get("data")
        .and_then(|data| data.get("models"))
        .and_then(Value::as_array)
        .ok_or_else(|| "config_missing_models".to_owned())?;
    let mut discovered = Vec::new();
    for model in models {
        let Some(id) = model.get("id").and_then(Value::as_str) else {
            return Err("config_model_without_id".into());
        };
        let Some(context) = model.get("maxInputTokens").and_then(Value::as_u64) else {
            continue; // Image/video engine: not a chat model.
        };
        discovered.push(DiscoveredModel {
            upstream_id: id.to_owned(),
            context_tokens: Some(context),
        });
    }
    Ok(discovered)
}

/// The meter's paging window: packages that end between now and far in the
/// future. The backend reads these as plain strings; the exact clock zone
/// only shifts the window's edge by hours, which no package sits on.
fn billing_query(now_unix: i64) -> Value {
    json!({
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": PRODUCT_CODE,
        "Status": [0, 3],
        "PackageEndTimeRangeBegin": format_utc(now_unix),
        "PackageEndTimeRangeEnd": format_utc(now_unix + 101 * 365 * 86_400),
    })
}

/// Parse the meter answer into one aggregate credit indicator. A pack of a
/// cycle (a subscription, CapacityType 2; a monthly pack, 4) counts even at
/// zero: it is what refills, so its end is the reset to wait for and its
/// size the limit. A one-shot pack (a bonus pack) counts while it has
/// something left; a spent one drops out. `usage` is what the cycle packs
/// used of their size, or the account's lifetime spend when the meter names
/// no size; `remaining` is the sum of what is counted, `resets_at_unix` the
/// earliest end among it.
fn parse_credits(value: &Value) -> Result<Vec<Indicator>, String> {
    match value.get("code").and_then(Value::as_i64) {
        Some(0) => {}
        Some(code) => return Err(format!("meter_envelope_code_{code}")),
        None => return Err("meter_envelope_schema_error".into()),
    }
    let accounts = value
        .pointer("/data/Response/Data/Accounts")
        .and_then(Value::as_array)
        .ok_or_else(|| "meter_missing_accounts".to_owned())?;
    let mut remaining: i64 = 0;
    let mut any_live = false;
    let mut cycle_size: Option<i64> = None;
    let mut cycle_used: i64 = 0;
    let mut resets_at_unix: Option<i64> = None;
    for account in accounts {
        let field = |name: &str| account.get(name).and_then(Value::as_i64);
        let cyclic = matches!(field("CapacityType"), Some(2 | 4));
        // The cycle fields are absent on one-shot packs; then the plain
        // capacity is the truth.
        let left = field("CycleCapacityRemain")
            .or_else(|| field("CapacityRemain"))
            .ok_or_else(|| "meter_account_without_remain".to_owned())?;
        let left = left.max(0);
        if left == 0 && !cyclic {
            continue;
        }
        any_live = true;
        remaining += left;
        if cyclic {
            let size = field("CycleCapacitySize").or_else(|| field("CapacitySize"));
            cycle_size = Some(cycle_size.unwrap_or(0) + size.unwrap_or(0));
            cycle_used += field("CycleCapacityUsed")
                .or_else(|| field("CapacityUsed"))
                .unwrap_or(0);
        }
        if let Some(end) = field("DeductionEndTime") {
            let end = end / 1000;
            resets_at_unix = Some(match resets_at_unix {
                Some(earliest) if earliest <= end => earliest,
                _ => end,
            });
        }
    }
    // The cycle's size and spend are the limit and the usage when the meter
    // reports them; otherwise the account's lifetime spend stands as before.
    let (limit, usage) = match (cycle_size, usage_of(value)) {
        (Some(size), _) if size > 0 => (Some(size.to_string()), Some(cycle_used.to_string())),
        _ => (None, usage_of(value)),
    };
    if !any_live {
        return Ok(vec![Indicator {
            resource: "account".into(),
            metric: "credits".into(),
            unit: Some("credit".into()),
            limit: None,
            usage: usage_of(value),
            remaining: Some("0".into()),
            window: None,
            resets_at_unix: None,
        }]);
    }
    Ok(vec![Indicator {
        resource: "account".into(),
        metric: "credits".into(),
        unit: Some("credit".into()),
        limit,
        usage,
        remaining: Some(remaining.to_string()),
        window: None,
        resets_at_unix,
    }])
}

/// The account's lifetime spend, kept verbatim when the meter reports it.
fn usage_of(value: &Value) -> Option<String> {
    value
        .pointer("/data/Response/Data/TotalDosage")
        .and_then(Value::as_number)
        .map(serde_json::Number::to_string)
}

fn excerpt(body: &str) -> String {
    error_excerpt(body, MESSAGE_LIMIT)
}

/// UTC "YYYY-MM-DD HH:MM:SS" from a unix timestamp (Howard Hinnant's
/// civil-from-days): no calendar dependency for two date strings.
fn format_utc(unix: i64) -> String {
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// A fresh per-request id in UUID shape: 128 bits from two independently
/// keyed hashers. The upstream wants uniqueness per request, not
/// cryptographic strength — nothing here is a secret.
fn fresh_uuid() -> String {
    use std::hash::{BuildHasher, Hasher, RandomState};
    let mut bits = [0u64; 2];
    for slot in &mut bits {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(0);
        *slot = hasher.finish();
    }
    let hex = format!("{:016x}{:016x}", bits[0], bits[1]);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use crate::provider::driver::UpstreamResponse;

    fn driver(server: &MockServer) -> WorkBuddyDriver {
        WorkBuddyDriver::new(&server.uri(), "ck-test12345678", HttpTimeouts::default())
    }

    #[test]
    fn body_preparation_matches_the_endpoint_contract() {
        // Streaming is forced, a developer role becomes system, and a
        // missing system head is supplied.
        let prepared = prepare_body(&json!({
            "model": "pool",
            "messages": [
                {"role": "user", "content": "hi"}
            ]
        }));
        assert_eq!(prepared["stream"], json!(true));
        // A missing system head is supplied; the user messages follow.
        assert_eq!(prepared["messages"][0]["role"], json!("system"));
        assert_eq!(prepared["messages"][1]["role"], json!("user"));
        // A developer role is folded into system without a duplicate head.
        let prepared = prepare_body(&json!({
            "messages": [
                {"role": "developer", "content": "be brief"},
                {"role": "user", "content": "hi"}
            ]
        }));
        assert_eq!(prepared["messages"][0]["role"], json!("system"));
        assert_eq!(prepared["messages"][1]["role"], json!("user"));
        assert_eq!(prepared["messages"].as_array().unwrap().len(), 2);
        // A structured tool_choice collapses to its type string.
        let prepared = prepare_body(&json!({
            "messages": [{"role": "system", "content": "s"}],
            "tool_choice": {"type": "auto", "function": {"name": "f"}}
        }));
        assert_eq!(prepared["tool_choice"], json!("auto"));
        assert_eq!(prepared["messages"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn error_codes_map_to_their_failure_classes() {
        let quota = classify_http(400, r#"{"code":14018,"msg":"no credits"}"#, None, 1_000_000);
        assert!(matches!(quota, FailureClass::QuotaExhausted { .. }));
        let queue = classify_http(429, r#"{"code":"6020"}"#, None, 1_000_000);
        assert_eq!(queue, FailureClass::Transient);
        let session = classify_http(401, r#"{"code":12153}"#, None, 1_000_000);
        assert_eq!(session, FailureClass::InvalidBackend);
        let channel = classify_http(400, r#"{"code":11128}"#, None, 1_000_000);
        assert_eq!(channel, FailureClass::UpstreamBadRequest);
        // Without a code the status decides; a string code is not a match.
        let unknown = classify_http(418, r#"{"code":"teapot"}"#, None, 1_000_000);
        assert_eq!(unknown, FailureClass::Unknown);
    }

    #[test]
    fn catalog_entries_skip_non_chat_engines() {
        let value = json!({
            "code": 0,
            "data": {"models": [
                {"id": "default-model", "maxInputTokens": 176000},
                {"id": "hy-image-3.5"},
                {"id": "max-model", "maxInputTokens": 272000}
            ]}
        });
        let models = parse_catalog(&value).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].upstream_id, "default-model");
        assert_eq!(models[0].context_tokens, Some(176000));
        assert_eq!(models[1].upstream_id, "max-model");
        // A refused envelope is an error, never an empty catalog.
        assert!(parse_catalog(&json!({"code": 401, "msg": "no"})).is_err());
    }

    #[test]
    fn credits_sum_live_packages_and_report_the_earliest_reset() {
        // Live shapes from the meter: a spent bonus pack, a live
        // subscription, and a full plan bonus.
        let value = json!({
            "code": 0,
            "data": {"Response": {"Data": {
                "TotalDosage": 1275,
                "Accounts": [
                    {"CapacityType": 1, "CycleCapacityRemain": 0,
                     "CapacityRemain": 0, "DeductionEndTime": 1795366686000u64},
                    {"CapacityType": 2, "CycleCapacityRemain": 175,
                     "DeductionEndTime": 1799999999000u64},
                    {"CapacityType": 2, "CycleCapacityRemain": 1000,
                     "DeductionEndTime": 1799999999000u64}
                ]
            }}}
        });
        let indicators = parse_credits(&value).unwrap();
        assert_eq!(indicators.len(), 1);
        let indicator = &indicators[0];
        assert_eq!(indicator.remaining.as_deref(), Some("1175"));
        assert_eq!(indicator.usage.as_deref(), Some("1275"));
        assert_eq!(indicator.resets_at_unix, Some(1799999999));
        // No live packages is an honest zero, not an error.
        let dead = json!({"code": 0, "data": {"Response": {"Data": {"Accounts": [
            {"CapacityType": 1, "CycleCapacityRemain": 0}
        ]}}}});
        let indicators = parse_credits(&dead).unwrap();
        assert_eq!(indicators[0].remaining.as_deref(), Some("0"));
        assert_eq!(indicators[0].resets_at_unix, None);
    }

    #[test]
    fn an_exhausted_subscription_still_names_its_reset_and_its_size() {
        // A live account with its cycle spent: a monthly plan and the plan's
        // bonus quota, both at zero, ending together a month after they began.
        let pack = |capacity_type: i64, size: i64, left: i64| {
            json!({
                "CapacityType": capacity_type, "CapacityUnit": "credit",
                "CapacitySize": size, "CapacityUsed": size - left, "CapacityRemain": left,
                "CycleCapacitySize": size, "CycleCapacityUsed": size - left,
                "CycleCapacityRemain": left,
                "CycleStartTime": "2026-11-18 12:08:35", "CycleEndTime": "2026-12-18 12:08:34",
                "DeductionStartTime": 1794974915000u64, "DeductionEndTime": 1797566914000u64,
            })
        };
        let meter = |accounts: Vec<Value>| json!({"code": 0, "data": {"Response": {"Data": {"TotalDosage": 100, "Accounts": accounts}}}});
        let spent = parse_credits(&meter(vec![pack(2, 1000, 0), pack(2, 1000, 0)])).unwrap();
        assert_eq!(spent[0].remaining.as_deref(), Some("0"));
        assert_eq!(spent[0].usage.as_deref(), Some("2000"));
        assert_eq!(spent[0].limit.as_deref(), Some("2000"));
        assert_eq!(spent[0].resets_at_unix, Some(1797566914));
        // A bonus pack with something left adds to what is left, not to the cycle.
        let with_bonus = parse_credits(&meter(vec![
            pack(2, 1000, 0),
            pack(2, 1000, 0),
            pack(1, 110, 110),
        ]))
        .unwrap();
        assert_eq!(with_bonus[0].remaining.as_deref(), Some("110"));
        assert_eq!(with_bonus[0].limit.as_deref(), Some("2000"));
        // A spent bonus pack alone is no cycle: nothing to wait for.
        let bonus_only = parse_credits(&meter(vec![pack(1, 110, 0)])).unwrap();
        assert_eq!(bonus_only[0].remaining.as_deref(), Some("0"));
        assert_eq!(bonus_only[0].limit, None);
        assert_eq!(bonus_only[0].resets_at_unix, None);
    }

    #[tokio::test]
    async fn catalog_reads_the_app_channel_config() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v3/config"))
            .and(header("user-agent", CONFIG_UA))
            .and(header("x-api-key", "ck-test12345678"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0,
                "data": {"models": [{"id": "hy4flash", "maxInputTokens": 176000}]}
            })))
            .mount(&server)
            .await;
        let models = driver(&server).fetch_catalog().await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].upstream_id, "hy4flash");
    }

    #[tokio::test]
    async fn balances_post_the_meter_query() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/billing/meter/get-user-resource"))
            .and(body_partial_json(json!({"ProductCode": "p_tcaca"})))
            .and(header("x-user-id", "anonymous_12345678"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "code": 0,
                "data": {"Response": {"Data": {"Accounts": [
                    {"CapacityType": 2, "CycleCapacityRemain": 42,
                     "DeductionEndTime": 1799999999000u64}
                ]}}}
            })))
            .mount(&server)
            .await;
        let indicators = driver(&server).fetch_observations().await.unwrap().unwrap();
        assert_eq!(indicators[0].remaining.as_deref(), Some("42"));
    }

    #[tokio::test]
    async fn chat_streams_with_prepared_body_and_cli_headers() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/chat/completions"))
            .and(header("user-agent", CHAT_UA))
            .and(body_partial_json(json!({
                "model": "hy4flash",
                "stream": true,
                "messages": [{"role": "system"}]
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string("data: {\"choices\":[]}\n\ndata: [DONE]\n\n"),
            )
            .mount(&server)
            .await;
        let request = InferenceRequest {
            // No stream, no system message: the driver must supply both.
            body: json!({"model": "pool", "messages": [{"role": "user", "content": "hi"}]}),
            session_id: "conv-1".into(),
        };
        let response = driver(&server).execute("hy4flash", &request).await.unwrap();
        assert!(matches!(response, UpstreamResponse::Stream(_)));
    }

    #[tokio::test]
    async fn refused_credits_surface_as_quota_exhaustion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/chat/completions"))
            .respond_with(
                ResponseTemplate::new(400)
                    .set_body_string(r#"{"code":14018,"msg":"insufficient credits"}"#),
            )
            .mount(&server)
            .await;
        let request = InferenceRequest {
            body: json!({"model": "pool", "messages": [{"role": "user", "content": "hi"}]}),
            session_id: "conv-1".into(),
        };
        let error = driver(&server).execute("hy4flash", &request).await;
        assert!(matches!(
            error,
            Err(DriverError {
                class: FailureClass::QuotaExhausted { .. },
                ..
            })
        ));
    }
}
