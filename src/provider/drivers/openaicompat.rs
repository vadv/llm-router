// The OpenAI-compatible plan driver (Alibaba Coding Plan, Xiaomi MiMo token
// plan, NVIDIA build.nvidia free NIM): Chat Completions with a dynamic
// catalog and no account endpoints at all — the plan's quota is visible
// only in the vendor console, so the driver reports no observations rather
// than inventing them. Per-request usage (with reasoning_tokens details)
// passes through verbatim like any OpenAI body. Chat and non-chat entries
// in the catalog are not filtered here: pool membership decides what the
// router may ever pick.

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

pub struct OpenAiCompatDriver {
    transport: ChatCompletionsTransport,
}

impl OpenAiCompatDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        OpenAiCompatDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
        }
    }
}

impl Driver for OpenAiCompatDriver {
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
            parse_openai_models(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("openai-compat catalog: {reason}"),
            })
        })
    }

    /// No usage endpoint exists on the plan: an explicit "not supported",
    /// never a guessed balance.
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
                .execute(model, request)
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
}

/// Plan error meaning by status: the plans have no documented quota
/// status; 402 keeps the OpenAI money meaning, 429 is short-lived pressure.
fn classify(failure: TransportFailure, now_unix: i64) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http {
            status,
            retry_after,
            ..
        } => match status.as_u16() {
            402 => FailureClass::QuotaExhausted {
                reset_at_unix: None,
            },
            401 | 403 => FailureClass::InvalidBackend,
            400 => FailureClass::UpstreamBadRequest,
            404 | 413 | 422 => FailureClass::InvalidRequest,
            429 => rate_limited(retry_after.as_deref(), now_unix),
            500..=599 => FailureClass::Transient,
            _ => FailureClass::Unknown,
        },
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!(
                "openai-compat upstream {}: {}",
                status.as_u16(),
                excerpt(body)
            )
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("openai-compat network: {err}"),
        TransportFailure::FirstByteTimeout => "openai-compat first byte timeout".into(),
        TransportFailure::AttemptTimeout => "openai-compat attempt budget exhausted".into(),
    };
    DriverError { class, message }
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
    async fn catalog_reads_the_plan_model_ids() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/compatible-mode/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "list",
                "data": [
                    {"id": "qwen3.7-max"},
                    {"id": "qwen3.6-flash"},
                    {"id": "deepseek-v4-pro"}
                ]
            })))
            .mount(&server)
            .await;
        let driver = OpenAiCompatDriver::new(
            &format!("{}/compatible-mode/v1", server.uri()),
            "k",
            timeouts(),
        );
        let catalog = driver.fetch_catalog().await.unwrap();
        assert_eq!(catalog.len(), 3);
        assert_eq!(catalog[0].upstream_id, "qwen3.7-max");
    }

    #[tokio::test]
    async fn the_body_passes_through_with_reasoning_fields() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/compatible-mode/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "c1", "object": "chat.completion",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "hi",
                                         "reasoning_content": "thinking"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5,
                          "completion_tokens_details": {"reasoning_tokens": 1, "text_tokens": 1}}
            })))
            .expect(1)
            .mount(&server)
            .await;
        let driver = OpenAiCompatDriver::new(
            &format!("{}/compatible-mode/v1", server.uri()),
            "k",
            timeouts(),
        );
        match driver.execute("qwen3.6-flash", &request()).await.unwrap() {
            UpstreamResponse::Complete(value) => {
                assert_eq!(
                    value.pointer("/choices/0/message/reasoning_content"),
                    Some(&json!("thinking"))
                );
                assert_eq!(
                    value.pointer("/usage/completion_tokens_details/reasoning_tokens"),
                    Some(&json!(1))
                );
            }
            UpstreamResponse::Stream(_) => panic!("fixture is non-streaming"),
        }
    }

    #[tokio::test]
    async fn a_payment_error_is_quota_exhaustion() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/compatible-mode/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(402).set_body_json(json!({
                "error": {"code": "InvalidParameter", "message": "arrears"}
            })))
            .mount(&server)
            .await;
        let driver = OpenAiCompatDriver::new(
            &format!("{}/compatible-mode/v1", server.uri()),
            "k",
            timeouts(),
        );
        let err = must_fail(driver.execute("qwen3.7-max", &request()).await);
        assert_eq!(
            err.class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
    }

    #[tokio::test]
    async fn throttling_is_rate_limiting() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/compatible-mode/v1/chat/completions"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("Retry-After", "30")
                    .set_body_json(json!({"error": {"code": "Throttling",
                                                "message": "Requests rate limit exceeded"}})),
            )
            .mount(&server)
            .await;
        let driver = OpenAiCompatDriver::new(
            &format!("{}/compatible-mode/v1", server.uri()),
            "k",
            timeouts(),
        );
        let err = must_fail(driver.execute("qwen3.7-max", &request()).await);
        match err.class {
            FailureClass::RateLimited { retry_after_unix } => {
                assert!(retry_after_unix.unwrap_or(0) > now_unix());
            }
            other => panic!("expected rate limiting, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn observations_are_explicitly_unsupported() {
        let server = MockServer::start().await;
        let driver = OpenAiCompatDriver::new(&server.uri(), "k", timeouts());
        assert!(driver.fetch_observations().await.unwrap().is_none());
    }
}
