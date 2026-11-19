// The OpenCode Go driver: OpenAI-compatible Chat Completions behind a cloud
// subscription. The only non-generic contract is session affinity: the
// upstream refuses any request without `x-opencode-session` (400
// MissingSessionID), so the router's conversation id is forwarded as that
// header. A 429 with `GoUsageLimitError` is the plan's monthly allowance:
// quota exhaustion, banned for the configured duration (the message carries
// a human reset like "19d 16h", not a machine-readable timestamp). There is
// no account/usage endpoint: balance exists only per request inside
// `usage.opencode`, which the handler already stores verbatim.

use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{
    ChatCompletionsTransport, TransportFailure, parse_openai_models,
};
use crate::routing::classify::{DriverError, FailureClass};

/// Reason string cap for history: enough to diagnose, never a body dump.
const MESSAGE_LIMIT: usize = 200;

pub struct OpenCodeDriver {
    transport: ChatCompletionsTransport,
}

impl OpenCodeDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        OpenCodeDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
        }
    }
}

impl Driver for OpenCodeDriver {
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
                message: format!("opencode catalog: {reason}"),
            })
        })
    }

    /// No observation endpoint exists: an explicit "not supported", never a
    /// guess at the plan's remaining allowance.
    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async { Ok(None) })
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
                .execute_with_headers(
                    model,
                    request,
                    &[("x-opencode-session", request.session_id.as_str())],
                )
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
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
            format!("opencode upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("opencode network: {err}"),
        TransportFailure::FirstByteTimeout => "opencode first byte timeout".into(),
        TransportFailure::AttemptTimeout => "opencode attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// OpenCode error meaning by status. The plan's exhausted monthly allowance
/// (`GoUsageLimitError`) is quota: banned for the default duration; no
/// machine-readable reset time exists to honor instead.
fn classify_http(
    status: u16,
    body: &str,
    retry_after: Option<&str>,
    now_unix: i64,
) -> FailureClass {
    match status {
        429 if is_usage_limit(body) => FailureClass::QuotaExhausted {
            reset_at_unix: None,
        },
        429 => rate_limited(retry_after, now_unix),
        400 => FailureClass::UpstreamBadRequest,
        404 => FailureClass::InvalidRequest,
        401 | 403 => FailureClass::InvalidBackend,
        500..=599 => FailureClass::Transient,
        _ => FailureClass::Unknown,
    }
}

/// Whether a 429 body names `GoUsageLimitError` — the subscription's spent
/// allowance, as opposed to ordinary rate limiting.
fn is_usage_limit(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .pointer("/error/type")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some("GoUsageLimitError")
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
    use wiremock::matchers::{header, method, path};
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
    async fn catalog_reads_ids_and_limit_context() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "list",
                "data": [
                    {"id": "beam-free", "limit": {"context": 200000, "output": 32000}},
                    {"id": "glm-5.3-flash", "limit": {"context": 1000000}}
                ]
            })))
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        let catalog = driver.fetch_catalog().await.unwrap();
        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].upstream_id, "beam-free");
        assert_eq!(catalog[0].context_tokens, Some(200_000));
        assert_eq!(catalog[1].upstream_id, "glm-5.3-flash");
        assert_eq!(catalog[1].context_tokens, Some(1_000_000));
    }

    #[tokio::test]
    async fn execute_sends_the_conversation_as_session_affinity() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("x-opencode-session", "conversation-7"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "c1", "object": "chat.completion",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "hi"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        match driver.execute("beam-free", &request()).await.unwrap() {
            UpstreamResponse::Complete(value) => {
                assert_eq!(
                    value.pointer("/choices/0/message/content"),
                    Some(&json!("hi"))
                )
            }
            UpstreamResponse::Stream(_) => panic!("fixture is non-streaming"),
        }
    }

    #[tokio::test]
    async fn a_spent_monthly_allowance_is_quota_exhaustion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_json(json!({
                "type": "error",
                "error": {"type": "GoUsageLimitError",
                          "message": "OpenCode Go usage limit reached (monthly, resets in 19d 16h)."},
                "metadata": {"workspace": "org_1", "limitName": "monthly"}
            })))
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        let err = must_fail(driver.execute("glm-5.3-flash", &request()).await);
        assert_eq!(
            err.class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
        assert!(err.message.contains("GoUsageLimitError"), "{}", err.message);
    }

    #[tokio::test]
    async fn a_model_outside_the_plan_rejects_only_this_member() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(400).set_body_json(json!({
                "error": {"type": "server_error",
                          "message": "Model no-such-model isn't included in OpenCode Go."}
            })))
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        let err = must_fail(driver.execute("no-such-model", &request()).await);
        assert_eq!(err.class, FailureClass::UpstreamBadRequest);
    }

    #[tokio::test]
    async fn an_unknown_429_is_rate_limiting_not_quota() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "7")
                    .set_body_json(json!({"error": {"type": "rate", "message": "slow down"}})),
            )
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        let err = must_fail(driver.execute("beam-free", &request()).await);
        match err.class {
            FailureClass::RateLimited { retry_after_unix } => {
                assert!(retry_after_unix.unwrap_or(0) > now_unix());
            }
            other => panic!("expected rate limiting, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_invalid_credential_is_a_backend_problem() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(json!({
                "error": {"type": "authentication_error", "message": "Invalid credential"}
            })))
            .mount(&server)
            .await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        let err = must_fail(driver.execute("beam-free", &request()).await);
        assert_eq!(err.class, FailureClass::InvalidBackend);
    }

    #[tokio::test]
    async fn observations_are_explicitly_unsupported() {
        let server = MockServer::start().await;
        let driver = OpenCodeDriver::new(&server.uri(), "k", timeouts());
        assert!(driver.fetch_observations().await.unwrap().is_none());
    }
}
