// The Kimi Code subscription driver: OpenAI-compatible Chat Completions
// plus a read-only usage monitor the API key itself can reach — unlike the
// console-cookie plans (Alibaba, MiMo), Kimi exposes `GET /coding/v1/usages`
// with Bearer auth. The 5-hour rolling window is the account's hard gate
// (monthly pools share it), so it is required; monthly ratios and the
// booster wallet are optional additions, skipped when the account has none.

use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{
    AuthKind, ChatCompletionsTransport, TransportFailure, parse_openai_models,
};
use crate::routing::classify::{DriverError, FailureClass};

/// Reason string cap for history: enough to diagnose, never a body dump.
const MESSAGE_LIMIT: usize = 200;

pub struct KimiDriver {
    transport: ChatCompletionsTransport,
    usages_url: String,
    timeouts: HttpTimeouts,
}

impl KimiDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        KimiDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
            usages_url: format!("{base_url}/usages"),
            timeouts,
        }
    }
}

impl Driver for KimiDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let value = self.transport.get_models().await.map_err(classify)?;
            // A bad catalog schema is upstream trouble, not an empty catalog.
            parse_openai_models(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("kimi catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_json(&self.usages_url, self.timeouts.catalog, AuthKind::Bearer)
                .await
                .map_err(classify)?;
            // A bad envelope is upstream trouble, never a zero balance: the
            // last good observations stay in force.
            let indicators = parse_usages(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("kimi usages: {reason}"),
            })?;
            Ok(Some(indicators))
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
        Box::pin(async {
            let request = strip_fixed_sampling(model, request);
            self.transport
                .execute(model, &request)
                .await
                .map_err(classify)
        })
    }
}

/// Moonshot thinking models fix the sampling parameters (K3.1 Pro docs:
/// temperature=1.0, top_p=0.95, n=1, presence_penalty=0, frequency_penalty=0
/// are fixed — "omit them from requests"), and reject any client value with
/// 400 before generating. Dropping the fields upstream refuses to honor is
/// the documented contract; the values live on in the stored request body.
fn strip_fixed_sampling<'a>(
    model: &str,
    request: &'a InferenceRequest,
) -> std::borrow::Cow<'a, InferenceRequest> {
    let fixed = model.contains("k2-thinking") || model.starts_with("k3.1-pro");
    if !fixed {
        return std::borrow::Cow::Borrowed(request);
    }
    let mut body = request.body.clone();
    if let Some(object) = body.as_object_mut() {
        for field in [
            "temperature",
            "top_p",
            "n",
            "presence_penalty",
            "frequency_penalty",
        ] {
            object.remove(field);
        }
    }
    std::borrow::Cow::Owned(InferenceRequest {
        body,
        session_id: request.session_id.clone(),
    })
}

/// One usage snapshot → indicators, following the account chemistry the
/// aiquota monitor validated on live data: `limits[duration=300].detail`
/// for the 5h window (required), `usages.limit_month_*` ratios (optional),
/// `booster_wallet.balance` (optional fuel pack). Amounts stay verbatim
/// strings: the upstream's counts have no documented unit.
fn parse_usages(value: &serde_json::Value) -> Result<Vec<Indicator>, String> {
    let limits = value
        .get("limits")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "no limits array".to_owned())?;
    let five_hour = limits
        .iter()
        .find(|entry| entry.pointer("/window/duration").and_then(v64) == Some(300))
        .ok_or_else(|| "no 5h window".to_owned())?;
    let detail = five_hour
        .get("detail")
        .ok_or_else(|| "5h window has no detail".to_owned())?;

    let mut first = Indicator {
        resource: "coding-plan".into(),
        metric: "credits".into(),
        unit: None,
        limit: amount(detail, "limit"),
        usage: amount(detail, "used"),
        remaining: amount(detail, "remaining"),
        window: Some("5h".into()),
        resets_at_unix: detail
            .get("resetTime")
            .and_then(serde_json::Value::as_str)
            .and_then(rfc3339_to_unix),
    };
    // Live fixtures carry no `used` in the window detail; the ratio map
    // under `usages` is the upstream's own representation of the same spend.
    if first.usage.is_none() {
        first.usage = value
            .pointer("/usages/limit_5h/used_ratio")
            .and_then(ratio_string);
    }

    let mut indicators = vec![first];
    for (field, label) in [
        ("limit_month_total", "monthly"),
        ("limit_month_code", "monthly-code"),
    ] {
        let Some(node) = value.pointer(&format!("/usages/{field}")) else {
            continue;
        };
        let Some(ratio) = node.get("used_ratio").and_then(ratio_string) else {
            continue;
        };
        indicators.push(Indicator {
            resource: "coding-plan".into(),
            metric: "ratio".into(),
            unit: None,
            limit: None,
            usage: Some(ratio),
            remaining: None,
            window: Some(label.into()),
            resets_at_unix: node
                .get("reset_time")
                .and_then(serde_json::Value::as_str)
                .and_then(rfc3339_to_unix),
        });
    }

    // Booster is a prepaid fuel pack; an empty or absent wallet is normal,
    // a present one reports its two verbatim amounts.
    let wallet = value.pointer("/booster_wallet/balance");
    let booster = wallet
        .and_then(|balance| Some((amount(balance, "amount")?, amount(balance, "amountLeft")?)));
    if let Some((total, left)) = booster {
        indicators.push(Indicator {
            resource: "booster".into(),
            metric: "credits".into(),
            unit: None,
            limit: Some(total),
            usage: None,
            remaining: Some(left),
            window: None,
            resets_at_unix: None,
        });
    }

    Ok(indicators)
}

/// A count that arrives as a string ("100") or a number, verbatim either way.
fn amount(node: &serde_json::Value, field: &str) -> Option<String> {
    match node.get(field)? {
        serde_json::Value::String(raw) => Some(raw.clone()),
        serde_json::Value::Number(raw) => Some(raw.to_string()),
        _ => None,
    }
}

fn ratio_string(node: &serde_json::Value) -> Option<String> {
    match node {
        serde_json::Value::String(raw) => Some(raw.clone()),
        serde_json::Value::Number(raw) => Some(raw.to_string()),
        _ => None,
    }
}

fn v64(node: &serde_json::Value) -> Option<i64> {
    node.as_i64()
}

/// Kimi's documented error semantics: quota exhaustion arrives as 429 with
/// distinct message fragments (error reference), while concurrency and
/// overload are short-lived. Message matching is the documented channel —
/// Kimi has no numeric error codes like Z.AI's.
fn classify(failure: TransportFailure) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http { status, body, .. } => {
            let text = body.to_lowercase();
            match status.as_u16() {
                401 | 403 => FailureClass::InvalidBackend,
                402 => FailureClass::QuotaExhausted {
                    reset_at_unix: None,
                },
                400 => FailureClass::UpstreamBadRequest,
                404 | 413 | 422 => FailureClass::InvalidRequest,
                429 => {
                    let quota = [
                        "5-hour usage limit",
                        "weekly (7-day) usage limit",
                        "monthly usage limit",
                        "credit balance is insufficient",
                    ]
                    .iter()
                    .any(|fragment| text.contains(fragment));
                    if quota {
                        FailureClass::QuotaExhausted {
                            reset_at_unix: None,
                        }
                    } else {
                        FailureClass::RateLimited {
                            retry_after_unix: None,
                        }
                    }
                }
                500..=599 => FailureClass::Transient,
                _ => FailureClass::Unknown,
            }
        }
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => format!(
            "kimi upstream {}: {}",
            status.as_u16(),
            super::error_excerpt(body, MESSAGE_LIMIT)
        ),
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("kimi network: {err}"),
        TransportFailure::FirstByteTimeout => "kimi first byte timeout".into(),
        TransportFailure::AttemptTimeout => "kimi attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// RFC3339 → unix seconds (Kimi reset times), without a datetime dependency.
/// Accepts `YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`; anything else is None,
/// never a guess.
fn rfc3339_to_unix(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let slice = &bytes[range];
        if slice.iter().all(u8::is_ascii_digit) {
            std::str::from_utf8(slice).ok()?.parse().ok()
        } else {
            None
        }
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Offset: Z, or ±HH:MM, after an optional fractional part.
    let tail = &raw[19..];
    let offset_seconds = if let Some(rest) = tail.strip_prefix('.') {
        let skipped: usize = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        parse_offset(&rest[skipped..])?
    } else {
        parse_offset(tail)?
    };
    // Days from civil (proleptic Gregorian); February and leap years included.
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146097 + day_of_era - 719468;
    Some(days * 86400 + hour * 3600 + minute * 60 + second - offset_seconds)
}

/// `Z` or `±HH:MM` → seconds east of UTC; anything else is not a timestamp.
fn parse_offset(tail: &str) -> Option<i64> {
    match tail.as_bytes().first() {
        Some(b'Z') | Some(b'z') if tail.len() == 1 => Some(0),
        Some(sign @ (b'+' | b'-')) => {
            let bytes = &tail.as_bytes()[1..];
            if bytes.len() != 5 || bytes[2] != b':' {
                return None;
            }
            let hours: i64 = std::str::from_utf8(&bytes[..2]).ok()?.parse().ok()?;
            let minutes: i64 = std::str::from_utf8(&bytes[3..5]).ok()?.parse().ok()?;
            let magnitude = hours * 3600 + minutes * 60;
            Some(if *sign == b'+' { magnitude } else { -magnitude })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HttpTimeouts;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn timeouts() -> HttpTimeouts {
        HttpTimeouts {
            connect: std::time::Duration::from_secs(5),
            first_byte: std::time::Duration::from_secs(5),
            total_attempt: std::time::Duration::from_secs(10),
            catalog: std::time::Duration::from_secs(5),
            catalog_connect: std::time::Duration::from_secs(5),
            local_state: std::time::Duration::from_secs(2),
        }
    }

    #[test]
    fn empty_assistant_rejection_is_specific_to_this_member() {
        let error = classify(TransportFailure::Http {
            status: reqwest::StatusCode::BAD_REQUEST,
            retry_after: None,
            body: r#"{"error":{"message":"the message at position 1 with role 'assistant' must not be empty","type":"invalid_request_error"}}"#.into(),
        });
        assert_eq!(error.class, FailureClass::UpstreamBadRequest);
    }

    fn request() -> InferenceRequest {
        InferenceRequest {
            body: json!({"model": "meta", "messages": []}),
            session_id: "conversation-7".into(),
        }
    }

    fn must_fail<T>(result: Result<T, DriverError>) -> DriverError {
        match result {
            Err(err) => err,
            Ok(_) => panic!("the upstream call must fail"),
        }
    }

    fn live_usages_fixture() -> serde_json::Value {
        json!({
            "limits": [{
                "window": {"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
                "detail": {
                    "limit": "100", "remaining": "100",
                    "resetTime": "2026-11-16T08:50:36.815407Z"
                }
            }],
            "usages": {
                "limit_5h": {"used_ratio": 0, "reset_time": "2026-11-16T08:50:36Z"},
                "limit_month_total": {"used_ratio": 1, "reset_time": "2026-11-18T19:53:23Z"},
                "limit_month_code": {"used_ratio": 0.9395, "reset_time": "2026-11-18T19:53:23Z"}
            },
            "booster_wallet": {"balance": {"amount": 10, "amountLeft": 7.5}}
        })
    }

    #[test]
    fn strip_fixed_sampling_drops_sampling_fields_on_thinking_models() {
        let request = InferenceRequest {
            body: serde_json::json!({
                "messages": [],
                "temperature": 0.3,
                "top_p": 0.9,
                "n": 2,
                "presence_penalty": 0.5,
                "frequency_penalty": -0.5
            }),
            session_id: "sess".into(),
        };
        let stripped = strip_fixed_sampling("k3.1-pro", &request).into_owned();
        assert_eq!(stripped.body, serde_json::json!({"messages": []}));
        // The same model family with a suffix (highspeed) is covered too.
        let stripped = strip_fixed_sampling("k3.1-pro-highspeed", &request).into_owned();
        assert!(
            stripped
                .body
                .as_object()
                .unwrap()
                .get("temperature")
                .is_none()
        );
        let stripped = strip_fixed_sampling("kimi-k2-thinking-0905", &request).into_owned();
        assert!(
            stripped
                .body
                .as_object()
                .unwrap()
                .get("temperature")
                .is_none()
        );
        // Free-sampling models keep the client's values untouched.
        let kept = strip_fixed_sampling("k3", &request);
        assert_eq!(kept.body["temperature"], serde_json::json!(0.3));
    }

    #[tokio::test]
    async fn execute_passes_through_for_k31_pro_upstream() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "model": "k3.1-pro"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "chatcmpl-1",
                "object": "chat.completion",
                "created": 1,
                "model": "k3.1-pro",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            })))
            .mount(&server)
            .await;
        let driver = super::KimiDriver::new(
            &format!("{}/v1", server.uri()),
            "sk-test",
            crate::config::HttpTimeouts::default(),
        );
        let response = driver
            .execute(
                "k3.1-pro",
                &InferenceRequest {
                    body: serde_json::json!({"messages": [{"role": "user", "content": "hi"}], "temperature": 0.3}),
                    session_id: "sess".into(),
                },
            )
            .await
            .unwrap();
        let UpstreamResponse::Complete(body) = response else {
            panic!("expected complete response");
        };
        assert_eq!(body["model"], serde_json::json!("k3.1-pro"));
    }

    #[test]
    fn usages_snapshot_maps_to_indicators() {
        let indicators = parse_usages(&live_usages_fixture()).unwrap();
        assert_eq!(indicators.len(), 4);

        let five = &indicators[0];
        assert_eq!(five.window.as_deref(), Some("5h"));
        assert_eq!(five.limit.as_deref(), Some("100"));
        assert_eq!(five.remaining.as_deref(), Some("100"));
        // `used` absent in detail: the ratio map supplies the same spend.
        assert_eq!(five.usage.as_deref(), Some("0"));
        assert_eq!(five.resets_at_unix, Some(1794819036));

        let month = &indicators[1];
        assert_eq!(month.window.as_deref(), Some("monthly"));
        assert_eq!(month.usage.as_deref(), Some("1"));
        assert_eq!(month.resets_at_unix, Some(1795031603));

        let month_code = &indicators[2];
        assert_eq!(month_code.window.as_deref(), Some("monthly-code"));
        assert_eq!(month_code.usage.as_deref(), Some("0.9395"));

        let booster = &indicators[3];
        assert_eq!(booster.resource, "booster");
        assert_eq!(booster.limit.as_deref(), Some("10"));
        assert_eq!(booster.remaining.as_deref(), Some("7.5"));
    }

    #[test]
    fn an_empty_plan_still_reports_the_five_hour_window() {
        let mut snapshot = live_usages_fixture();
        snapshot.as_object_mut().unwrap().remove("booster_wallet");
        snapshot
            .pointer_mut("/usages")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("limit_month_code");
        let indicators = parse_usages(&snapshot).unwrap();
        assert_eq!(indicators.len(), 2);
    }

    #[test]
    fn a_broken_envelope_is_an_error_not_a_zero_balance() {
        let err = parse_usages(&json!({"limits": []})).unwrap_err();
        assert!(err.contains("5h"));
    }

    #[test]
    fn rfc3339_edges() {
        assert_eq!(rfc3339_to_unix("2026-11-16T08:50:36Z"), Some(1794819036));
        assert_eq!(
            rfc3339_to_unix("2026-11-16T16:50:36+08:00"),
            Some(1794819036)
        );
        assert_eq!(rfc3339_to_unix("2026-01-01T00:00:00Z"), Some(1767225600));
        assert_eq!(rfc3339_to_unix("not a date"), None);
        assert_eq!(rfc3339_to_unix("2026-13-01T00:00:00Z"), None);
        assert_eq!(rfc3339_to_unix("2026-11-16T08:50:36Zx"), None);
    }

    #[tokio::test]
    async fn observations_come_from_the_usages_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coding/v1/usages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(live_usages_fixture()))
            .mount(&server)
            .await;
        let driver = KimiDriver::new(&format!("{}/coding/v1", server.uri()), "k", timeouts());
        let indicators = driver.fetch_observations().await.unwrap().unwrap();
        assert_eq!(indicators[0].window.as_deref(), Some("5h"));
    }

    #[tokio::test]
    async fn catalog_reads_model_ids_and_context() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/coding/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "list",
                "data": [
                    {"id": "kimi-for-coding", "context_length": 1048576},
                    {"id": "k3.1-pro-highspeed", "context_length": 1048576}
                ]
            })))
            .mount(&server)
            .await;
        let driver = KimiDriver::new(&format!("{}/coding/v1", server.uri()), "k", timeouts());
        let catalog = driver.fetch_catalog().await.unwrap();
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].upstream_id, "kimi-for-coding");
        assert_eq!(catalog[0].context_tokens, Some(1048576));
    }

    #[tokio::test]
    async fn quota_exhaustion_is_distinguished_from_rate_pressure() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/coding/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": {"message": "You've reached your 5-hour usage limit. It resets at 12:00 UTC.",
                          "type": "rate_limit_error"}
            })))
            .mount(&server)
            .await;
        let driver = KimiDriver::new(&format!("{}/coding/v1", server.uri()), "k", timeouts());
        let err = must_fail(driver.execute("k3.1-pro", &request()).await);
        assert_eq!(
            err.class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
    }

    #[tokio::test]
    async fn concurrency_pressure_is_rate_limiting() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/coding/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "error": {"message": "You've reached your concurrent request limit",
                          "type": "rate_limit_error"}
            })))
            .mount(&server)
            .await;
        let driver = KimiDriver::new(&format!("{}/coding/v1", server.uri()), "k", timeouts());
        let err = must_fail(driver.execute("k3.1-pro", &request()).await);
        assert_eq!(
            err.class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );
    }

    #[tokio::test]
    async fn a_dead_key_is_a_backend_problem() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/coding/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": {"message": "The API Key appears to be invalid or may have expired"}
            })))
            .mount(&server)
            .await;
        let driver = KimiDriver::new(&format!("{}/coding/v1", server.uri()), "k", timeouts());
        let err = must_fail(driver.execute("k3.1-pro", &request()).await);
        assert_eq!(err.class, FailureClass::InvalidBackend);
    }
}
