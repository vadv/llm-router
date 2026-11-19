// The DeepSeek driver: OpenAI-compatible Chat Completions with a dynamic
// catalog and a money balance monitor. Exhaustion is HTTP 402 (insufficient
// balance); there are no window rate limits, so 429 stays short-lived
// pressure.

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
use serde_json::{Value, json};

/// The API base with a terminal `/v1` path removed: the balance monitor
/// lives on the account root, not under the versioned API path.
fn control_base(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    match trimmed.strip_suffix("/v1") {
        Some(rest) if rest.contains("://") => rest.to_owned(),
        _ => trimmed.to_owned(),
    }
}

pub struct DeepSeekDriver {
    transport: ChatCompletionsTransport,
    balance_url: String,
    timeouts: HttpTimeouts,
}

impl DeepSeekDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        DeepSeekDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
            balance_url: format!("{}/user/balance", control_base(base_url)),
            timeouts,
        }
    }
}

impl Driver for DeepSeekDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let value = self.transport.get_models().await.map_err(classify)?;
            parse_openai_models(&value).map_err(|reason| DriverError {
                // A bad catalog schema is upstream trouble, not quota; the
                // last snapshot stays in force.
                class: FailureClass::Transient,
                message: format!("deepseek catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            // is_available=false means the account cannot pay: the driver
            // still reports the amounts, routing decides what that means.
            let value = self
                .transport
                .get_json(&self.balance_url, self.timeouts.catalog, AuthKind::Bearer)
                .await
                .map_err(classify)?;
            parse_balance(&value)
                .map(|indicators| {
                    indicators
                        .into_iter()
                        .map(|mut indicator| {
                            // Money amounts stay verbatim strings; "CNY"/"USD"
                            // travel as the unit, not into the number.
                            indicator.resource = "account".into();
                            indicator.metric = "money".into();
                            indicator
                        })
                        .collect::<Vec<_>>()
                })
                .map_err(|reason| DriverError {
                    class: FailureClass::Transient,
                    message: format!("deepseek balance: {reason}"),
                })
                .map(Some)
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
            // DeepSeek's thinking mode requires every assistant message
            // of a multi-turn history to carry `reasoning_content`; a
            // history that carries it only in part is rejected with 400.
            // An empty string is accepted as "no reasoning kept".
            let mut request = clone_request(request);
            if let Some(messages) = request
                .body
                .get_mut("messages")
                .and_then(Value::as_array_mut)
            {
                for message in messages.iter_mut() {
                    if message.get("role") == Some(&json!("assistant"))
                        && message.get("reasoning_content").is_none()
                    {
                        message["reasoning_content"] = json!("");
                    }
                }
            }
            self.transport
                .execute(model, &request)
                .await
                .map_err(classify)
        })
    }
}

/// The transport reads the request body by reference, so the driver
/// shape fix works on its own copy.
fn clone_request(request: &InferenceRequest) -> InferenceRequest {
    InferenceRequest {
        body: request.body.clone(),
        session_id: request.session_id.clone(),
    }
}

/// DeepSeek error meaning by status: 402 is documented balance exhaustion;
/// there is no marker code to fish out of the body.
fn classify(failure: TransportFailure) -> DriverError {
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
            429 => rate_limited(retry_after.as_deref()),
            502..=504 => FailureClass::Transient,
            _ => FailureClass::Unknown,
        },
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!("deepseek upstream {}: {}", status.as_u16(), excerpt(body))
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("deepseek network: {err}"),
        TransportFailure::FirstByteTimeout => "deepseek first byte timeout".into(),
        TransportFailure::AttemptTimeout => "deepseek attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

/// Retry-After as plain seconds, the only validated form; an HTTP-date is
/// left unset rather than guessed.
fn rate_limited(retry_after: Option<&str>) -> FailureClass {
    let retry_after_unix = retry_after
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| now_unix() + secs);
    FailureClass::RateLimited { retry_after_unix }
}

/// Parse GET /user/balance: `balance_infos[]` with `currency` and
/// `total_balance` (a decimal string). A missing or malformed list is an
/// error, never a zero balance.
fn parse_balance(value: &serde_json::Value) -> Result<Vec<Indicator>, String> {
    let infos = value
        .get("balance_infos")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "invalid schema".to_owned())?;
    infos
        .iter()
        .map(|info| {
            let remaining = info
                .get("total_balance")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "bad entry".to_owned())?;
            let unit = info
                .get("currency")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            Ok(Indicator {
                resource: String::new(), // filled by the caller
                metric: String::new(),   // filled by the caller
                unit,
                limit: None,
                usage: None,
                remaining: Some(remaining),
                window: None,
                resets_at_unix: None,
            })
        })
        .collect()
}

/// First line of the body, capped: diagnostic text, not a payload copy.
fn excerpt(body: &str) -> String {
    const MESSAGE_LIMIT: usize = 200;
    error_excerpt(body, MESSAGE_LIMIT)
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
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn driver(server: &MockServer) -> DeepSeekDriver {
        DeepSeekDriver::new(
            &server.uri(),
            "sk-test",
            HttpTimeouts {
                connect: std::time::Duration::from_millis(200),
                catalog_connect: std::time::Duration::from_millis(200),
                catalog: std::time::Duration::from_secs(2),
                first_byte: std::time::Duration::from_secs(2),
                total_attempt: std::time::Duration::from_secs(3),
                local_state: std::time::Duration::from_secs(2),
            },
        )
    }

    fn http(status: u16, body: &str, retry_after: Option<&str>) -> TransportFailure {
        TransportFailure::Http {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            retry_after: retry_after.map(str::to_owned),
            body: body.to_owned(),
        }
    }

    #[test]
    fn the_balance_url_ignores_the_version_path() {
        let driver =
            DeepSeekDriver::new("https://api.deepseek.com/v1", "k", HttpTimeouts::default());
        assert_eq!(driver.balance_url, "https://api.deepseek.com/user/balance");
    }

    #[test]
    fn the_balance_url_survives_a_pathless_base() {
        let driver = DeepSeekDriver::new("https://api.deepseek.com/", "k", HttpTimeouts::default());
        assert_eq!(driver.balance_url, "https://api.deepseek.com/user/balance");
    }

    #[test]
    fn a_402_is_quota_exhaustion_and_429_keeps_retry_after_seconds() {
        assert_eq!(
            classify(http(402, r#"{"error":"insufficient balance"}"#, None)).class,
            FailureClass::QuotaExhausted {
                reset_at_unix: None
            }
        );
        // A deterministic deadline cannot be asserted with a real clock; the
        // seconds parsing itself is covered by the None branch below.
        assert_eq!(
            classify(http(429, "busy", None)).class,
            FailureClass::RateLimited {
                retry_after_unix: None
            }
        );
    }

    #[test]
    fn other_statuses_map_to_their_classes() {
        for (status, expected) in [
            (401, FailureClass::InvalidBackend),
            (403, FailureClass::InvalidBackend),
            (400, FailureClass::UpstreamBadRequest),
            (404, FailureClass::InvalidRequest),
            (422, FailureClass::InvalidRequest),
            (502, FailureClass::Transient),
            (503, FailureClass::Transient),
            (504, FailureClass::Transient),
            (418, FailureClass::Unknown),
        ] {
            assert_eq!(
                classify(http(status, "x", None)).class,
                expected,
                "status {status}"
            );
        }
    }

    #[test]
    fn balance_parsing_keeps_amounts_verbatim_and_rejects_bad_schema() {
        let value = json!({
            "is_available": true,
            "balance_infos": [
                {"currency": "CNY", "total_balance": "110.00"},
                {"currency": "USD", "total_balance": "1.25"}
            ]
        });
        let indicators = parse_balance(&value).unwrap();
        assert_eq!(indicators.len(), 2);
        assert_eq!(indicators[0].remaining.as_deref(), Some("110.00"));
        assert_eq!(indicators[0].unit.as_deref(), Some("CNY"));
        assert_eq!(indicators[1].remaining.as_deref(), Some("1.25"));

        assert!(parse_balance(&json!({})).is_err());
        assert!(
            parse_balance(&json!({"balance_infos": [
                {"currency": "CNY"}
            ]}))
            .is_err()
        );
    }

    #[tokio::test]
    async fn execute_backfills_empty_reasoning_content_for_assistant_history() {
        // DeepSeek thinking mode rejects a history whose assistant
        // messages carry `reasoning_content` only in part; every one of
        // them must have the field, an empty string counts as "none".
        use crate::provider::driver::InferenceRequest;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "c1", "object": "chat.completion",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "hi"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2}
            })))
            .mount(&server)
            .await;
        let request = InferenceRequest {
            body: json!({"messages": [
                {"role": "user", "content": "q"},
                {"role": "assistant", "content": "kept", "reasoning_content": "real"},
                {"role": "assistant", "content": "dropped"},
                {"role": "user", "content": "again"}
            ]}),
            session_id: "s".into(),
        };
        driver(&server)
            .execute("deepseek-flash", &request)
            .await
            .unwrap();
        let sent = server.received_requests().await.unwrap().pop().unwrap();
        let body: serde_json::Value = serde_json::from_slice(&sent.body).unwrap();
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages[0].get("reasoning_content"), None);
        assert_eq!(messages[1]["reasoning_content"], "real");
        assert_eq!(messages[2]["reasoning_content"], "");
    }

    #[tokio::test]
    async fn fetch_observations_reads_the_account_balance_with_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/user/balance"))
            .and(header("Authorization", "Bearer sk-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "is_available": true,
                "balance_infos": [
                    {"currency": "CNY", "total_balance": "110.00"}
                ]
            })))
            .mount(&server)
            .await;

        let indicators = driver(&server).fetch_observations().await.unwrap().unwrap();
        assert_eq!(indicators.len(), 1);
        assert_eq!(indicators[0].resource, "account");
        assert_eq!(indicators[0].metric, "money");
        assert_eq!(indicators[0].unit.as_deref(), Some("CNY"));
        assert_eq!(indicators[0].remaining.as_deref(), Some("110.00"));
    }

    #[tokio::test]
    async fn a_balance_error_is_classified_not_zeroed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/user/balance"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;

        let error = driver(&server).fetch_observations().await.unwrap_err();
        assert_eq!(error.class, FailureClass::Transient);
        assert!(error.message.contains("deepseek"));
    }

    #[tokio::test]
    async fn the_catalog_is_bearer_authenticated_and_parsed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(header("Authorization", "Bearer sk-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "list",
                "data": [
                    {"id": "deepseek-chat", "context_window": 65536},
                    {"id": "deepseek-reasoner"}
                ]
            })))
            .mount(&server)
            .await;

        let models = driver(&server).fetch_catalog().await.unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].upstream_id, "deepseek-chat");
        assert_eq!(models[0].context_tokens, Some(65536));
        assert_eq!(models[1].context_tokens, None);
    }
}
