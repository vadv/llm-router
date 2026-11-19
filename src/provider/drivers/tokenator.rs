// The Tokenator driver: an OpenAI-compatible Chat Completions aggregator
// behind prepaid token packs. The chat path is fully generic; the only
// provider-specific contract is the usage endpoint `GET /v1/tokens`: a
// top-level pack counter (limit/used/remaining) plus per-`free_models[]`
// daily token and request counters with RFC 3339 reset times. The free
// limits are account-wide: each free model's row carries the same numbers.
// A 403 on any endpoint is an observation/auth failure, never quota
// exhaustion. There is no
// machine-readable error taxonomy beyond that: 402 is money, 429 is rate.

use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{
    AuthKind, ChatCompletionsTransport, TransportFailure, parse_openai_models,
};
use crate::provider::drivers::openrouter::parse_rfc3339_utc;
use crate::routing::classify::{DriverError, FailureClass};

/// Reason string cap for history: enough to diagnose, never a body dump.
const MESSAGE_LIMIT: usize = 200;

pub struct TokenatorDriver {
    transport: ChatCompletionsTransport,
    tokens_url: String,
    timeouts: HttpTimeouts,
}

impl TokenatorDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        TokenatorDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
            tokens_url: format!("{base_url}/tokens"),
            timeouts,
        }
    }
}

impl Driver for TokenatorDriver {
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
                class: FailureClass::Transient,
                message: format!("tokenator catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_json(&self.tokens_url, self.timeouts.catalog, AuthKind::Bearer)
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            // A bad envelope is upstream trouble, never a zero balance: the
            // last good observations stay in force.
            let indicators = parse_tokens(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("tokenator usage: {reason}"),
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
            self.transport
                .execute(model, request)
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
}

/// `GET /v1/tokens`: the account's token pack plus per-free-model daily
/// counters. Missing or null fields stay absent — never a zero.
fn parse_tokens(value: &serde_json::Value) -> Result<Vec<Indicator>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "tokens_envelope_rejected".to_owned())?;

    let mut indicators = vec![Indicator {
        resource: "tokens".into(),
        metric: "tokens".into(),
        unit: Some("token".into()),
        limit: number_string(object.get("limit")),
        usage: number_string(object.get("used")),
        remaining: number_string(object.get("remaining")),
        window: None,
        resets_at_unix: None,
    }];

    for entry in object
        .get("free_models")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&Vec::new())
    {
        let Some(model) = entry.get("model").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let resets_at_unix = entry
            .get("resets_at")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_rfc3339_utc);
        // The daily limits are account-wide: every free model reports the
        // same counters; each model's row carries them verbatim.
        indicators.push(Indicator {
            resource: model.to_owned(),
            metric: "tokens".into(),
            unit: Some("token".into()),
            limit: number_string(entry.get("daily_tokens")),
            usage: number_string(entry.get("tokens_used")),
            remaining: number_string(entry.get("tokens_remaining")),
            window: Some("daily".into()),
            resets_at_unix,
        });
        indicators.push(Indicator {
            resource: model.to_owned(),
            metric: "requests".into(),
            unit: Some("request".into()),
            limit: number_string(entry.get("daily_requests")),
            usage: number_string(entry.get("requests_used")),
            remaining: number_string(entry.get("requests_remaining")),
            window: Some("daily".into()),
            resets_at_unix,
        });
    }
    Ok(indicators)
}

fn classify(failure: TransportFailure, now_unix: i64) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
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
            format!("tokenator upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("tokenator network: {err}"),
        TransportFailure::FirstByteTimeout => "tokenator first byte timeout".into(),
        TransportFailure::AttemptTimeout => "tokenator attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// Tokenator error meaning by status. 403 is an observation or access
/// failure, never quota exhaustion.
fn classify_http(
    status: u16,
    _body: &str,
    retry_after: Option<&str>,
    now_unix: i64,
) -> FailureClass {
    match status {
        400 => FailureClass::UpstreamBadRequest,
        401 | 403 => FailureClass::InvalidBackend,
        402 => FailureClass::QuotaExhausted {
            reset_at_unix: None,
        },
        429 => rate_limited(retry_after, now_unix),
        500..=599 => FailureClass::Transient,
        _ => FailureClass::Unknown,
    }
}

fn rate_limited(retry_after: Option<&str>, now_unix: i64) -> FailureClass {
    let retry_after_unix = retry_after
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| now_unix + secs);
    FailureClass::RateLimited { retry_after_unix }
}

/// Accept a number as Tokenator reports it: JSON number or numeric string.
/// A missing or null field stays None — never a zero.
fn number_string(value: Option<&serde_json::Value>) -> Option<String> {
    match value {
        Some(serde_json::Value::Number(number)) => Some(number.to_string()),
        Some(serde_json::Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// First line of the body, capped: diagnostic text, not a payload copy.
fn excerpt(body: &str) -> String {
    super::error_excerpt(body, MESSAGE_LIMIT)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
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

    #[tokio::test]
    async fn observations_carry_the_pack_and_free_model_counters() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/tokens"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "limit": 35000000,
                "used": 27300000,
                "remaining": 7700000,
                "free_models": [
                    {"model": "free-glm-5.3-flash",
                     "daily_tokens": 200000, "tokens_used": 1000, "tokens_remaining": 199000,
                     "daily_requests": 50, "requests_used": 2, "requests_remaining": 48,
                     "resets_at": "2026-12-01T00:00:00Z"}
                ]
            })))
            .mount(&server)
            .await;
        let driver = TokenatorDriver::new(&format!("{}/v1", server.uri()), "k", timeouts());
        let indicators = driver.fetch_observations().await.unwrap().unwrap();

        let pack = &indicators[0];
        assert_eq!(pack.resource, "tokens");
        assert_eq!(pack.remaining.as_deref(), Some("7700000"));
        assert_eq!(pack.resets_at_unix, None);

        let tokens = &indicators[1];
        assert_eq!(tokens.resource, "free-glm-5.3-flash");
        assert_eq!(tokens.metric, "tokens");
        assert_eq!(tokens.limit.as_deref(), Some("200000"));
        assert_eq!(tokens.window.as_deref(), Some("daily"));
        assert_eq!(tokens.resets_at_unix, Some(1_796_083_200));

        let requests = &indicators[2];
        assert_eq!(requests.metric, "requests");
        assert_eq!(requests.remaining.as_deref(), Some("48"));
        assert_eq!(requests.resets_at_unix, Some(1_796_083_200));
    }

    #[tokio::test]
    async fn absent_free_counters_stay_unknown_not_zero() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/tokens"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "limit": 35000000,
                "free_models": [{"model": "free-x", "resets_at": "2026-12-01T00:00:00Z"}]
            })))
            .mount(&server)
            .await;
        let driver = TokenatorDriver::new(&format!("{}/v1", server.uri()), "k", timeouts());
        let indicators = driver.fetch_observations().await.unwrap().unwrap();
        let tokens = &indicators[1];
        assert_eq!(tokens.usage, None);
        assert_eq!(tokens.remaining, None);
    }

    #[tokio::test]
    async fn a_rejected_envelope_fails_the_refresh_not_the_balance() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/tokens"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!(["nope"])))
            .mount(&server)
            .await;
        let driver = TokenatorDriver::new(&format!("{}/v1", server.uri()), "k", timeouts());
        assert!(driver.fetch_observations().await.is_err());
    }

    #[tokio::test]
    async fn a_forbidden_observation_is_not_quota() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/tokens"))
            .respond_with(ResponseTemplate::new(403).set_body_string("Forbidden"))
            .mount(&server)
            .await;
        let driver = TokenatorDriver::new(&format!("{}/v1", server.uri()), "k", timeouts());
        let err = must_fail(driver.fetch_observations().await);
        assert_eq!(err.class, FailureClass::InvalidBackend);
    }

    #[tokio::test]
    async fn a_payment_error_is_quota_exhaustion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error": {"message": "insufficient tokens"}
            })))
            .mount(&server)
            .await;
        let driver = TokenatorDriver::new(&format!("{}/v1", server.uri()), "k", timeouts());
        let err = must_fail(driver.execute("free-glm-5.3-flash", &request()).await);
        assert_eq!(
            err.class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
    }
}
