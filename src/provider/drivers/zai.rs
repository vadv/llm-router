// The Z.AI Coding Plan driver: OpenAI-compatible Chat Completions with a
// dynamic catalog and Z.AI-specific error semantics. Inference and catalog
// use Bearer auth; the monitor endpoint uses x-api-key.

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

/// Z.AI JSON error.code values meaning quota/plan exhaustion. 1302 (rate
/// limit) and 1305 (temporary overload) are deliberately absent: they stay
/// short-lived failures, never a durable quota ban.
const QUOTA_ERROR_CODES: [i64; 11] = [
    1113, 1308, 1309, 1310, 1314, 1316, 1317, 1318, 1319, 1320, 1321,
];

/// Structured exhaustion names any OpenAI-compatible provider may carry.
const QUOTA_CODE_NAMES: [&str; 2] = ["insufficient_quota", "insufficient_balance"];

/// Reason string cap for history: enough to diagnose, never a body dump.
const MESSAGE_LIMIT: usize = 200;

pub struct ZaiDriver {
    transport: ChatCompletionsTransport,
    monitor_url: String,
    timeouts: HttpTimeouts,
}

/// The monitor path on the account root: derived from the configured base
/// host, so a mirror or proxy in base_url is followed, not hardcoded to
/// api.z.ai.
const MONITOR_PATH: &str = "/api/monitor/usage/quota/limit";

/// The base URL's scheme, host, and port — everything before the first path
/// segment. The monitor lives on that root, not under the API version path.
fn url_origin(base_url: &str) -> String {
    let Some((scheme, rest)) = base_url.split_once("://") else {
        return base_url.to_owned();
    };
    let host = rest.split('/').next().unwrap_or(rest);
    format!("{scheme}://{host}")
}

impl ZaiDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        ZaiDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
            monitor_url: format!("{}{MONITOR_PATH}", url_origin(base_url)),
            timeouts,
        }
    }
}

impl Driver for ZaiDriver {
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
            parse_openai_models(&value).map_err(|reason| DriverError {
                // A bad catalog schema is upstream trouble, not quota, and an
                // error never becomes an empty catalog: the old snapshot stays.
                class: FailureClass::Transient,
                message: format!("zai catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_json(&self.monitor_url, self.timeouts.catalog, AuthKind::XApiKey)
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            parse_quota(&value).map(Some).map_err(|reason| DriverError {
                // A bad envelope is upstream trouble, never zero quota: the
                // last good observations stay in force.
                class: FailureClass::Transient,
                message: format!("zai monitor: {reason}"),
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
            self.transport
                .execute(model, request)
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
}

/// Turn one raw transport failure into a classified, redacted driver error.
/// The transport carries no credentials; the only untrusted text is the
/// upstream body, kept to `MESSAGE_LIMIT` characters.
fn classify(failure: TransportFailure, now_unix: i64) -> DriverError {
    let class = match &failure {
        // The request never left the router as a valid Chat Completions body.
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
            format!("zai upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("zai network: {err}"),
        TransportFailure::FirstByteTimeout => "zai first byte timeout".into(),
        TransportFailure::AttemptTimeout => "zai attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// Z.AI error meaning by response markers. Body markers win over the status:
/// a quota code on a `400` is still quota, and a bare `500` can be balance
/// exhaustion — without markers the cause stays unknown.
fn classify_http(
    status: u16,
    body: &str,
    retry_after: Option<&str>,
    now_unix: i64,
) -> FailureClass {
    let (numeric, name) = body_markers(body);
    if name.is_some() || numeric.is_some_and(|code| QUOTA_ERROR_CODES.contains(&code)) {
        // Z.AI reports no reset time with its quota codes.
        return FailureClass::QuotaExhausted {
            reset_at_unix: None,
        };
    }
    match numeric {
        Some(1302) => return rate_limited(retry_after, now_unix),
        Some(1305) => return FailureClass::Transient,
        _ => {}
    }
    match status {
        402 => FailureClass::QuotaExhausted {
            reset_at_unix: None,
        },
        // Rejected credentials or entitlement: the connection is broken.
        401 | 403 => FailureClass::InvalidBackend,
        400 => FailureClass::UpstreamBadRequest,
        404 | 413 | 422 => FailureClass::InvalidRequest,
        // A bare Z.AI 429 is "too many requests": their exhaustion always
        // carries a marker, so the status alone means short-term pressure.
        429 => rate_limited(retry_after, now_unix),
        // Upstream gateway/overload answers: retryable, no ban.
        502..=504 => FailureClass::Transient,
        _ => FailureClass::Unknown,
    }
}

/// Z.AI codes live in `error.code` or a bare top-level `code`, encoded as a
/// number or a numeric string; exhaustion names appear in `code` or `type`
/// (old-project router.rs `structured_quota_code`). Returns the numeric code
/// and the matched exhaustion name, if either is present.
fn body_markers(body: &str) -> (Option<i64>, Option<&'static str>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return (None, None);
    };
    let mut numeric = None;
    let mut name = None;
    for scope in [value.get("error"), Some(&value)].into_iter().flatten() {
        for field in ["code", "type"] {
            match scope.get(field) {
                Some(serde_json::Value::Number(number)) if numeric.is_none() => {
                    numeric = number.as_i64();
                }
                Some(serde_json::Value::String(text)) if name.is_none() => {
                    name = QUOTA_CODE_NAMES
                        .iter()
                        .find(|quota| text.eq_ignore_ascii_case(quota))
                        .copied();
                    if name.is_none() && numeric.is_none() {
                        numeric = text.parse::<i64>().ok();
                    }
                }
                _ => {}
            }
        }
    }
    (numeric, name)
}

/// Retry-After as plain seconds, the only form validated for Z.AI; an
/// HTTP-date form is left unset rather than guessed. The value is a
/// deadline; routing caps how far into the future it may reach.
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

/// Parse the monitor envelope `{code,msg,data:{limits,level},success}`.
/// `success:false`, a non-200 code, or a missing limits list is an error —
/// an unavailable window is never zero usage or an exhausted plan. Only a
/// numeric `code` enters the message: a provider echoing a secret back in
/// `code` must not reach history.
fn parse_quota(value: &serde_json::Value) -> Result<Vec<Indicator>, String> {
    if value.get("success") == Some(&serde_json::Value::Bool(false)) {
        return Err("quota_envelope_rejected".into());
    }
    if let Some(code) = value.get("code") {
        match code.as_i64() {
            Some(200) => {}
            Some(number) => return Err(format!("quota_envelope_code_{number}")),
            None => return Err("quota_envelope_code_schema_error".into()),
        }
    }
    let data = value
        .get("data")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| "quota_invalid_envelope".to_owned())?;
    let limits = data
        .get("limits")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "quota_missing_limits".to_owned())?;
    // A malformed element is a schema error, never a shorter window list
    // that would silently replace the last good snapshot.
    limits
        .iter()
        .map(|limit| parse_limit(limit).ok_or_else(|| "quota_bad_limit".to_owned()))
        .collect()
}

/// One limit window → one indicator. `usage` is the cap, `currentValue` the
/// spent part, `remaining` the rest; numbers are kept verbatim so a future
/// fractional credit shows as a visible schema change, never a truncation.
/// Percentage and `level` are dropped: per the spec, percent is not an
/// absolute spend, and the plan tier has no numeric consumer.
fn parse_limit(limit: &serde_json::Value) -> Option<Indicator> {
    let object = limit.as_object()?;
    let int = |field: &str| object.get(field).and_then(serde_json::Value::as_i64);
    let number = |field: &str| {
        object
            .get(field)
            .and_then(serde_json::Value::as_number)
            .map(serde_json::Number::to_string)
    };
    let raw_type = object.get("type").and_then(serde_json::Value::as_str);
    Some(Indicator {
        resource: "coding-plan".into(),
        metric: "credits".into(),
        unit: Some("credits".into()),
        limit: number("usage"),
        usage: number("currentValue"),
        remaining: number("remaining"),
        window: Some(window_label(raw_type, int("unit"), int("number"))),
        // Reset arrives as epoch milliseconds; anything else stays None,
        // never invented from wall-clock guesses.
        resets_at_unix: int("nextResetTime").map(|ms| ms / 1000),
    })
}

/// A friendly label only for the documented current-plan shapes; unit alone
/// is ambiguous (legacy TIME_LIMIT unit 5 is a month), so everything else
/// keeps an honest raw label instead of a guess.
fn window_label(raw_type: Option<&str>, unit: Option<i64>, number: Option<i64>) -> String {
    let raw = || {
        format!(
            "{}:u{}:n{}",
            raw_type.unwrap_or("UNKNOWN"),
            unit.map_or("-".to_owned(), |u| u.to_string()),
            number.map_or("-".to_owned(), |n| n.to_string())
        )
    };
    match (raw_type, unit) {
        (Some("CREDIT_LIMIT"), Some(3)) if number == Some(5) => "5h".to_owned(),
        // "week" is only the confirmed weekly shape: unit 6 with another
        // number keeps the honest raw label.
        (Some("CREDIT_LIMIT"), Some(6)) if number == Some(1) => "week".to_owned(),
        _ => raw(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const NOW: i64 = 1_000_000;

    fn http(status: u16, body: &str, retry_after: Option<&str>) -> TransportFailure {
        TransportFailure::Http {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            retry_after: retry_after.map(str::to_owned),
            body: body.to_owned(),
        }
    }

    #[test]
    fn quota_codes_win_over_any_status_and_accept_string_encoding() {
        for (status, body) in [
            (429, r#"{"error":{"code":1113,"message":"plan exhausted"}}"#),
            (400, r#"{"error":{"code":"1308"}}"#),
            (500, r#"{"code":1314}"#),
            (200, r#"{"error":{"code":"insufficient_quota"}}"#),
            (503, r#"{"error":{"type":"Insufficient_Balance"}}"#),
        ] {
            let error = classify(http(status, body, None), NOW);
            assert_eq!(
                error.class,
                FailureClass::QuotaExhausted {
                    reset_at_unix: None
                },
                "status {status} body {body}"
            );
        }
    }

    #[test]
    fn zai_specific_rate_limit_and_overload_codes_stay_short_lived() {
        let error = classify(http(429, r#"{"error":{"code":1302}}"#, Some("7")), NOW);
        assert_eq!(
            error.class,
            FailureClass::RateLimited {
                retry_after_unix: Some(NOW + 7)
            }
        );

        let error = classify(http(429, r#"{"error":{"code":1305}}"#, None), NOW);
        assert_eq!(error.class, FailureClass::Transient);
    }

    #[test]
    fn a_bare_429_means_rate_limited_and_dates_are_not_guessed() {
        let error = classify(http(429, "not json", None), NOW);
        assert_eq!(
            error.class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );

        let error = classify(
            http(
                429,
                r#"{"error":{"message":"slow down"}}"#,
                Some("Wed, 21 Oct 2026 07:28:00 GMT"),
            ),
            NOW,
        );
        assert_eq!(
            error.class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );
    }

    #[test]
    fn plain_statuses_classify_without_invented_causes() {
        for (status, expected) in [
            (
                402,
                FailureClass::QuotaExhausted {
                    reset_at_unix: None,
                },
            ),
            (401, FailureClass::InvalidBackend),
            (403, FailureClass::InvalidBackend),
            (400, FailureClass::UpstreamBadRequest),
            (422, FailureClass::InvalidRequest),
            (404, FailureClass::InvalidRequest),
            (503, FailureClass::Transient),
            (502, FailureClass::Transient),
            (504, FailureClass::Transient),
            (500, FailureClass::Unknown),
        ] {
            assert_eq!(
                classify_http(status, "", None, NOW),
                expected,
                "status {status}"
            );
        }
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

    #[tokio::test]
    async fn an_http_error_message_is_capped_and_single_line() {
        let body = format!("{}\nsecond line never shown", "x".repeat(500));
        let error = classify(http(500, &body, None), NOW);
        assert!(error.message.starts_with("zai upstream 500: "));
        assert!(error.message.len() <= "zai upstream 500: ".len() + MESSAGE_LIMIT + "…".len());
        assert!(!error.message.contains("second line"));
    }

    #[test]
    fn a_bad_catalog_schema_is_an_error_not_an_empty_catalog() {
        for value in [
            json!({"object": "list"}),
            json!({"data": "not-array"}),
            json!({"data": [{"no_id": true}]}),
            json!({"data": [42]}),
        ] {
            assert!(parse_openai_models(&value).is_err(), "value {value}");
        }
    }

    fn driver(server: &MockServer) -> ZaiDriver {
        ZaiDriver::new(&server.uri(), "zai-key", HttpTimeouts::default())
    }

    /// Exact account fixture: reviews/zai-validation-fixtures.md of the old
    /// project (2026-11-16).
    const QUOTA_FIXTURE: &str = r#"{"code":200,"msg":"Operation successful","data":{
      "limits":[
        {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":67,"remaining":27932,"percentage":1,"nextResetTime":1794819400888},
        {"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":140000,"currentValue":108103,"remaining":31896,"percentage":77,"nextResetTime":1794938003999}
      ],
      "level":"max"},"success":true}"#;

    fn quota_fixture() -> serde_json::Value {
        serde_json::from_str(QUOTA_FIXTURE).unwrap()
    }

    #[test]
    fn quota_fixture_maps_to_two_credit_indicators() {
        let indicators = parse_quota(&quota_fixture()).unwrap();
        assert_eq!(indicators.len(), 2);

        let five_hour = indicators
            .iter()
            .find(|i| i.window.as_deref() == Some("5h"))
            .unwrap();
        assert_eq!(five_hour.resource, "coding-plan");
        assert_eq!(five_hour.metric, "credits");
        assert_eq!(five_hour.limit.as_deref(), Some("28000"));
        assert_eq!(five_hour.usage.as_deref(), Some("67"));
        assert_eq!(five_hour.remaining.as_deref(), Some("27932"));
        assert_eq!(five_hour.resets_at_unix, Some(1794819400));

        let week = indicators
            .iter()
            .find(|i| i.window.as_deref() == Some("week"))
            .unwrap();
        assert_eq!(week.limit.as_deref(), Some("140000"));
        assert_eq!(week.usage.as_deref(), Some("108103"));
        assert_eq!(week.resets_at_unix, Some(1794938003));
    }

    #[test]
    fn an_unconfirmed_window_shape_keeps_the_raw_label() {
        let value = serde_json::json!({"data":{"limits":[
            {"type":"TIME_LIMIT","unit":5,"number":0,"usage":30,"currentValue":3,"remaining":27}
        ]},"success":true});
        let indicators = parse_quota(&value).unwrap();
        // Unit 5 alone would read "month" on a legacy plan; the honest raw
        // label keeps the shape visible instead of guessing.
        assert_eq!(indicators[0].window.as_deref(), Some("TIME_LIMIT:u5:n0"));
    }

    #[test]
    fn a_rejected_or_malformed_envelope_is_an_error_not_zero_quota() {
        let rejected = serde_json::json!({"code":1234,"msg":"no","data":{},"success":false});
        assert!(parse_quota(&rejected).is_err());
        let bad_code =
            serde_json::json!({"code":"reflected-secret","data":{"limits":[]},"success":true});
        // A string code never enters the message: a reflected secret stays
        // out of history.
        let error = parse_quota(&bad_code).unwrap_err();
        assert_eq!(error, "quota_envelope_code_schema_error");
        let no_limits = serde_json::json!({"code":200,"data":{},"success":true});
        assert_eq!(parse_quota(&no_limits).unwrap_err(), "quota_missing_limits");
        let bad_limit = serde_json::json!({"data":{"limits":["garbage"]},"success":true});
        assert_eq!(parse_quota(&bad_limit).unwrap_err(), "quota_bad_limit");
    }

    #[test]
    fn the_monitor_url_follows_the_configured_host() {
        let driver = ZaiDriver::new(
            "https://mirror.example/api/coding/paas/v4",
            "key",
            HttpTimeouts::default(),
        );
        assert_eq!(
            driver.monitor_url,
            "https://mirror.example/api/monitor/usage/quota/limit"
        );
    }

    #[tokio::test]
    async fn fetch_observations_uses_the_x_api_key_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/monitor/usage/quota/limit"))
            .and(header("x-api-key", "zai-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(quota_fixture()))
            .mount(&server)
            .await;

        let indicators = driver(&server).fetch_observations().await.unwrap().unwrap();
        assert_eq!(indicators.len(), 2);
    }

    #[tokio::test]
    async fn fetch_catalog_uses_bearer_and_returns_discovered_models() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("authorization", "Bearer zai-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{"id": "glm-5.3"}, "glm-5.3-air"]
            })))
            .mount(&server)
            .await;

        let models = driver(&server).fetch_catalog().await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].upstream_id, "glm-5.3");
    }

    #[tokio::test]
    async fn a_catalog_http_error_is_classified_not_swallowed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let error = driver(&server).fetch_catalog().await.unwrap_err();
        assert_eq!(error.class, FailureClass::InvalidBackend);
    }

    #[tokio::test]
    async fn execute_substitutes_the_model_and_classifies_upstream_errors() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({"model": "glm-5.3"})))
            .respond_with(ResponseTemplate::new(402))
            .mount(&server)
            .await;

        let request = InferenceRequest {
            body: json!({"model": "pool-model", "messages": []}),
            session_id: "conversation-7".into(),
        };
        let error = driver(&server)
            .execute("glm-5.3", &request)
            .await
            .err()
            .expect("402 must fail");
        assert_eq!(
            error.class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
    }
}
