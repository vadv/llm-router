// The OpenRouter driver: OpenAI-compatible Chat Completions with a dynamic
// catalog and OpenRouter-specific error semantics. The 402 split is theirs:
// `openrouter_in_flight_budget` is transient (Retry-After), everything else
// on 402 is money exhaustion. Observations come from /api/v1/key and
// /api/v1/credits; the account-wide free-model daily limit is attached to
// every `:free` model so the display matches per-model subscriptions of
// other providers.

use std::sync::Mutex;

use super::error_excerpt;
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

pub struct OpenRouterDriver {
    transport: ChatCompletionsTransport,
    key_url: String,
    credits_url: String,
    /// The `:free` ids of the last successful catalog fetch. The daily free
    /// limit is account-wide, but it is reported per model for display
    /// unification; without a catalog there is nothing to attach it to.
    free_models: Mutex<Vec<String>>,
    timeouts: HttpTimeouts,
}

/// Both observation endpoints live on the account root, not under the
/// API version path a base_url like https://openrouter.ai/api/v1 carries.
fn url_origin(base_url: &str) -> String {
    let Some((scheme, rest)) = base_url.split_once("://") else {
        return base_url.to_owned();
    };
    let host = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{host}")
}

impl OpenRouterDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        let origin = url_origin(base_url);
        OpenRouterDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
            key_url: format!("{origin}/api/v1/key"),
            credits_url: format!("{origin}/api/v1/credits"),
            free_models: Mutex::new(Vec::new()),
            timeouts,
        }
    }
}

impl Driver for OpenRouterDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_models()
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            // A bad catalog schema is upstream trouble, not an empty catalog.
            let models = parse_openai_models(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("openrouter catalog: {reason}"),
            })?;
            let free: Vec<String> = models
                .iter()
                .map(|m| m.upstream_id.as_str())
                .filter(|id| id.ends_with(":free"))
                .map(str::to_owned)
                .collect();
            *self.free_models.lock().unwrap() = free;
            Ok(models)
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let key = self
                .transport
                .get_json(&self.key_url, self.timeouts.catalog, AuthKind::Bearer)
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            let credits = self
                .transport
                .get_json(&self.credits_url, self.timeouts.catalog, AuthKind::Bearer)
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            // A bad envelope is upstream trouble, never zero balance: the
            // last good observations stay in force.
            let free_models = self.free_models.lock().unwrap().clone();
            let mut indicators = parse_key(&key, &free_models).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("openrouter key: {reason}"),
            })?;
            indicators.extend(parse_credits(&credits).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("openrouter credits: {reason}"),
            })?);
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
            self.transport
                .execute(model, request)
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
}

fn classify(failure: TransportFailure, now_unix: i64) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        // No response or budget spent: worth a retry, never a ban.
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http {
            status,
            retry_after,
            body,
        } => classify_http(status.as_u16(), body, retry_after.as_deref(), now_unix),
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!("openrouter upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("openrouter network: {err}"),
        TransportFailure::FirstByteTimeout => "openrouter first byte timeout".into(),
        TransportFailure::AttemptTimeout => "openrouter attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// OpenRouter error meaning by status. The 402 body's
/// `error.metadata.limit_source` separates in-flight budget (transient)
/// from money exhaustion (banned for the configured duration, never
/// permanently).
fn classify_http(
    status: u16,
    body: &str,
    retry_after: Option<&str>,
    now_unix: i64,
) -> FailureClass {
    if status == 402 && is_in_flight_budget(body) {
        return rate_limited(retry_after, now_unix);
    }
    match status {
        402 => FailureClass::QuotaExhausted {
            // OpenRouter's 402 carries no reset time; the configured
            // duration (default 1 h) applies, never "forever".
            reset_at_unix: None,
        },
        401 | 403 => FailureClass::InvalidBackend,
        429 => rate_limited(retry_after, now_unix),
        400 => FailureClass::UpstreamBadRequest,
        500..=599 => FailureClass::Transient,
        _ => FailureClass::Unknown,
    }
}

/// Whether a 402 body's `error.metadata.limit_source` names the in-flight
/// budget — the only transient 402; any other (or unreadable) body is money
/// exhaustion.
fn is_in_flight_budget(body: &str) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    value
        .get("error")
        .and_then(|error| error.get("metadata"))
        .and_then(|metadata| metadata.get("limit_source"))
        .and_then(serde_json::Value::as_str)
        == Some("openrouter_in_flight_budget")
}

fn rate_limited(retry_after: Option<&str>, now_unix: i64) -> FailureClass {
    let retry_after_unix = retry_after
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| now_unix + secs);
    FailureClass::RateLimited { retry_after_unix }
}

/// First line of the body, capped: diagnostic text, not a payload copy.
fn excerpt(body: &str) -> String {
    error_excerpt(body, MESSAGE_LIMIT)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

/// Accept a number as OpenRouter reports it: JSON number or numeric string.
/// A missing or null field stays None — never a zero.
fn number_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `GET /api/v1/key`: the per-key spending cap and the account-wide free
/// limit, attached to each `:free` model of the last catalog fetch.
fn parse_key(value: &serde_json::Value, free_models: &[String]) -> Result<Vec<Indicator>, String> {
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "key_envelope_rejected".to_owned())?;

    let mut indicators = Vec::new();
    // A null limit means the key has no cap: the indicator still exists,
    // with unknown amounts rather than a fake zero.
    indicators.push(Indicator {
        resource: "key".into(),
        metric: "money".into(),
        unit: Some("USD".into()),
        limit: number_string(data.get("limit")),
        usage: number_string(data.get("usage_monthly")),
        remaining: number_string(data.get("limit_remaining")),
        window: data
            .get("limit_reset")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        resets_at_unix: data
            .get("budgets")
            .and_then(serde_json::Value::as_array)
            .and_then(|budgets| budgets.first())
            .and_then(|budget| budget.get("resets_at"))
            .and_then(serde_json::Value::as_str)
            .and_then(parse_rfc3339_utc),
    });

    // The free-model daily limit is account-wide and reported only as a
    // counter; it is duplicated onto each `:free` model of the last catalog
    // snapshot. Tiers without the counter get no indicators, not zeroes.
    if let Some(free) = data
        .get("free_model_daily_requests")
        .and_then(serde_json::Value::as_object)
    {
        let counter = Indicator {
            resource: String::new(),
            metric: "requests".into(),
            unit: Some("request".into()),
            limit: number_string(free.get("limit")),
            usage: number_string(free.get("used")),
            remaining: number_string(free.get("remaining")),
            // Resets at 00:00 UTC but the endpoint reports no reset time:
            // no guessed deadline.
            window: Some("daily".into()),
            resets_at_unix: None,
        };
        for model in free_models {
            let mut per_model = counter.clone();
            per_model.resource = model.clone();
            indicators.push(per_model);
        }
    }
    Ok(indicators)
}

/// `GET /api/v1/credits`: the account's purchased credits, all-time.
fn parse_credits(value: &serde_json::Value) -> Result<Vec<Indicator>, String> {
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "credits_envelope_rejected".to_owned())?;
    let limit = number_string(data.get("total_credits"));
    let usage = number_string(data.get("total_usage"));
    // Remaining is plain subtraction of the two reported amounts, not a
    // guess; it only exists when both halves do.
    let remaining = match (&limit, &usage) {
        (Some(limit), Some(usage)) => {
            match (limit.parse::<f64>().ok(), usage.parse::<f64>().ok()) {
                (Some(limit), Some(usage)) => Some(format!("{:.4}", limit - usage)),
                _ => None,
            }
        }
        _ => None,
    };
    Ok(vec![Indicator {
        resource: "credits".into(),
        metric: "money".into(),
        unit: Some("USD".into()),
        limit,
        usage,
        remaining,
        window: None,
        resets_at_unix: None,
    }])
}

/// Parse the UTC RFC 3339 timestamps OpenRouter reports (`resets_at`).
/// Only `Z`/`+00:00` offsets are accepted: a local offset is rejected
/// rather than silently shifted.
pub(crate) fn parse_rfc3339_utc(text: &str) -> Option<i64> {
    let head = text.get(0..19)?;
    let tail = text[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    if tail != "Z" && tail != "+00:00" {
        return None;
    }
    let year: i64 = head.get(0..4)?.parse().ok()?;
    let month: i64 = head.get(5..7)?.parse().ok()?;
    let day: i64 = head.get(8..10)?.parse().ok()?;
    let hour: i64 = head.get(11..13)?.parse().ok()?;
    let minute: i64 = head.get(14..16)?.parse().ok()?;
    let second: i64 = head.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days since the Unix epoch (Howard Hinnant's days-from-civil).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HttpTimeouts;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NOW: i64 = 10_000;

    fn http(status: u16, body: &str, retry_after: Option<&str>) -> TransportFailure {
        TransportFailure::Http {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            retry_after: retry_after.map(str::to_owned),
            body: body.to_owned(),
        }
    }

    #[test]
    fn plain_statuses_classify_without_invented_causes() {
        let cases = [
            (
                402u16,
                FailureClass::QuotaExhausted {
                    reset_at_unix: None,
                },
            ),
            (401, FailureClass::InvalidBackend),
            (403, FailureClass::InvalidBackend),
            (400, FailureClass::UpstreamBadRequest),
            (500, FailureClass::Transient),
            (503, FailureClass::Transient),
            (404, FailureClass::Unknown),
        ];
        for (status, expected) in cases {
            assert_eq!(
                classify_http(status, "", None, NOW),
                expected,
                "status {status}"
            );
        }
    }

    #[test]
    fn in_flight_budget_is_transient_and_honors_retry_after() {
        let body = r#"{"error":{"code":402,"message":"You have exceeded your in-flight budget",
            "metadata":{"limit_source":"openrouter_in_flight_budget"}}}"#;
        assert_eq!(
            classify(http(402, body, Some("7")), NOW).class,
            FailureClass::RateLimited {
                retry_after_unix: Some(NOW + 7)
            }
        );
        // Without a usable Retry-After the default rate-limit ban applies.
        assert_eq!(
            classify(http(402, body, None), NOW).class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );
    }

    #[test]
    fn any_other_402_is_money_exhaustion_even_with_metadata() {
        let body = r#"{"error":{"code":402,"message":"Insufficient credits",
            "metadata":{"limit_source":"openrouter_key_limit"}}}"#;
        assert_eq!(
            classify(http(402, body, None), NOW).class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
        // An unreadable 402 body still means money exhaustion: 402 is not
        // in-flight unless it says so.
        assert_eq!(
            classify(http(402, "not json", None), NOW).class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
    }

    #[test]
    fn a_429_is_rate_limited_and_dates_are_not_guessed() {
        assert_eq!(
            classify(http(429, "rate limit", Some("30")), NOW).class,
            FailureClass::RateLimited {
                retry_after_unix: Some(NOW + 30)
            }
        );
        // Zero, negative, and unparseable values invent no deadline.
        for retry_after in ["0", "-5", "not-a-number"] {
            assert_eq!(
                classify(http(429, "rate limit", Some(retry_after)), NOW).class,
                FailureClass::RateLimited {
                    retry_after_unix: None
                },
                "retry_after {retry_after}"
            );
        }
        assert_eq!(
            classify(http(429, "rate limit", None), NOW).class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );
    }

    #[tokio::test]
    async fn transport_failures_map_to_request_or_transient() {
        assert_eq!(
            classify(TransportFailure::MalformedBody, NOW).class,
            FailureClass::InvalidRequest
        );
        // TEST-NET-1 with a short connect timeout: a guaranteed network error.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(100))
            .build()
            .unwrap();
        let network = client.get("http://192.0.2.1:9").send().await.unwrap_err();
        for failure in [
            TransportFailure::FirstByteTimeout,
            TransportFailure::AttemptTimeout,
            TransportFailure::Network(network),
        ] {
            assert_eq!(classify(failure, NOW).class, FailureClass::Transient);
        }
    }

    #[test]
    fn rfc3339_parses_utc_shapes_and_rejects_the_rest() {
        assert_eq!(
            parse_rfc3339_utc("2026-12-01T00:00:00.000Z"),
            Some(1_796_083_200)
        );
        assert_eq!(
            parse_rfc3339_utc("2026-12-01T00:00:00Z"),
            Some(1_796_083_200)
        );
        assert_eq!(
            parse_rfc3339_utc("2026-12-01T00:00:00+00:00"),
            Some(1_796_083_200)
        );
        assert_eq!(parse_rfc3339_utc("2026-12-01T00:00:00+03:00"), None);
        assert_eq!(parse_rfc3339_utc("not a date"), None);
        assert_eq!(parse_rfc3339_utc("2026-13-01T00:00:00Z"), None);
    }

    fn key_fixture() -> serde_json::Value {
        json!({
            "data": {
                "limit": 100,
                "limit_remaining": 40.866471815,
                "limit_reset": "monthly",
                "usage_monthly": 59.133528185,
                "free_model_daily_requests": {"used": 2, "limit": 1000, "remaining": 998},
                "budgets": [{
                    "scope": "key_limit",
                    "limit_usd": 100,
                    "spend_usd": 59.133528185,
                    "remaining_usd": 40.866471815,
                    "reset_interval": "monthly",
                    "resets_at": "2026-12-01T00:00:00.000Z"
                }]
            }
        })
    }

    fn credits_fixture() -> serde_json::Value {
        json!({"data": {"total_credits": 171, "total_usage": 151.010409736}})
    }

    #[test]
    fn key_maps_to_budget_and_free_indicators() {
        let free_models = [
            "deepseek/deepseek-r1:free".to_owned(),
            "meta-llama/llama-3:free".to_owned(),
        ];
        let indicators = parse_key(&key_fixture(), &free_models).unwrap();
        assert_eq!(indicators.len(), 3);

        let budget = &indicators[0];
        assert_eq!(budget.resource, "key");
        assert_eq!(budget.metric, "money");
        assert_eq!(budget.unit.as_deref(), Some("USD"));
        assert_eq!(budget.limit.as_deref(), Some("100"));
        assert_eq!(budget.usage.as_deref(), Some("59.133528185"));
        assert_eq!(budget.remaining.as_deref(), Some("40.866471815"));
        assert_eq!(budget.window.as_deref(), Some("monthly"));
        assert_eq!(budget.resets_at_unix, Some(1_796_083_200));

        for (indicator, model) in indicators[1..].iter().zip(&free_models) {
            assert_eq!(indicator.resource, *model);
            assert_eq!(indicator.metric, "requests");
            assert_eq!(indicator.unit.as_deref(), Some("request"));
            assert_eq!(indicator.limit.as_deref(), Some("1000"));
            assert_eq!(indicator.usage.as_deref(), Some("2"));
            assert_eq!(indicator.remaining.as_deref(), Some("998"));
            assert_eq!(indicator.window.as_deref(), Some("daily"));
            assert_eq!(indicator.resets_at_unix, None);
        }
    }

    #[test]
    fn a_key_without_a_cap_and_without_free_counter_reports_unknowns() {
        let value = json!({"data": {"limit": null, "usage_monthly": 5}});
        let indicators = parse_key(&value, &[]).unwrap();
        assert_eq!(indicators.len(), 1);
        assert_eq!(indicators[0].resource, "key");
        assert_eq!(indicators[0].limit, None);
        assert_eq!(indicators[0].remaining, None);
    }

    #[test]
    fn credits_map_to_one_indicator_with_subtracted_remaining() {
        let indicators = parse_credits(&credits_fixture()).unwrap();
        assert_eq!(indicators.len(), 1);
        let credits = &indicators[0];
        assert_eq!(credits.resource, "credits");
        assert_eq!(credits.limit.as_deref(), Some("171"));
        assert_eq!(credits.usage.as_deref(), Some("151.010409736"));
        assert_eq!(credits.remaining.as_deref(), Some("19.9896"));
    }

    #[test]
    fn a_rejected_envelope_is_an_error_not_zero_balance() {
        assert!(parse_key(&json!({"error": "no"}), &[]).is_err());
        assert!(parse_credits(&json!({})).is_err());
    }

    fn driver(server: &MockServer) -> OpenRouterDriver {
        OpenRouterDriver::new(&server.uri(), "openrouter-key", HttpTimeouts::default())
    }

    #[tokio::test]
    async fn observations_fetch_both_endpoints_with_bearer_auth() {
        let server = MockServer::start().await;
        // A catalog fetch first: the free limit needs models to attach to.
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{"id": "deepseek/deepseek-r1:free", "context_length": 163840}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(key_fixture()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/credits"))
            .respond_with(ResponseTemplate::new(200).set_body_json(credits_fixture()))
            .expect(1)
            .mount(&server)
            .await;
        let driver = driver(&server);
        driver.fetch_catalog().await.unwrap();
        let indicators = driver.fetch_observations().await.unwrap().unwrap();
        // key + one free model + credits
        assert_eq!(indicators.len(), 3);
        assert_eq!(indicators[1].resource, "deepseek/deepseek-r1:free");
        assert_eq!(indicators[2].resource, "credits");
    }

    #[tokio::test]
    async fn observations_follow_the_configured_host() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(key_fixture()))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/credits"))
            .respond_with(ResponseTemplate::new(200).set_body_json(credits_fixture()))
            .expect(1)
            .mount(&server)
            .await;
        // base_url carries a version path; the endpoints sit on the root.
        let driver = OpenRouterDriver::new(
            &format!("{}/api/v1", server.uri()),
            "openrouter-key",
            HttpTimeouts::default(),
        );
        assert!(driver.fetch_observations().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn catalog_fetch_parses_models_and_remembers_free_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [
                    {"id": "openai/gpt-4o", "context_length": 128000},
                    {"id": "deepseek/deepseek-r1:free", "context_length": 163840}
                ]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let driver = driver(&server);
        let models = driver.fetch_catalog().await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(
            models[1],
            DiscoveredModel {
                upstream_id: "deepseek/deepseek-r1:free".into(),
                context_tokens: Some(163_840)
            }
        );
        let free = driver.free_models.lock().unwrap().clone();
        assert_eq!(free, vec!["deepseek/deepseek-r1:free".to_owned()]);
    }
}
