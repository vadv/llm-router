// Shared HTTP transport for OpenAI-compatible /chat/completions.
//
// Responsibilities, and only these: substitute the upstream model id and
// credentials, pass the rest of the request through verbatim, relay the
// response (streaming or complete) without buffering it whole, and report
// raw failures for the driver to classify. It performs no retries of its
// own — one call here is one attempt in the history.

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::config::HttpTimeouts;
use crate::provider::driver::{DiscoveredModel, InferenceRequest, UpstreamResponse};
use crate::routing::classify::{DriverError, FailureClass};

/// Raw transport failure, meaning-free on purpose: the driver decides what
/// the status and body mean. No credentials ever appear here.
#[derive(Debug)]
pub enum TransportFailure {
    /// The request body is not a JSON object, so the model id cannot be
    /// substituted. The driver classifies it as the client's fault.
    MalformedBody,
    /// No HTTP response arrived: connect, DNS, TLS — or the 600 s attempt
    /// budget ran out before headers arrived.
    Network(reqwest::Error),
    /// Headers did not arrive within the first-byte window (60 s default).
    FirstByteTimeout,
    /// The per-attempt total budget (600 s default) ran out, possibly
    /// mid-stream.
    AttemptTimeout,
    /// The upstream answered with an HTTP error. `body` is truncated to
    /// `BODY_LIMIT` bytes for classification; `retry_after` is the raw
    /// header value whose units the driver must interpret.
    Http {
        status: reqwest::StatusCode,
        retry_after: Option<String>,
        body: String,
    },
}

/// Classification-relevant body cap. The full body is never needed.
const BODY_LIMIT: usize = 4096;

/// One connection's Chat Completions endpoint. `base_url` includes the
/// version path (e.g. `https://api.example.com/v1`).
pub struct ChatCompletionsTransport {
    http: reqwest::Client,
    /// Separate connect budget for data-plane GETs (catalog, balances):
    /// 5 s instead of the inference 10 s (config.rs `catalog_connect`).
    catalog_http: reqwest::Client,
    pub(crate) base_url: String,
    /// None: local engines with no key; the Authorization header is then
    /// not sent at all, not sent empty.
    api_key: Option<String>,
    pub(crate) timeouts: HttpTimeouts,
}

/// How a data-plane GET presents its credentials: the OpenAI Bearer
/// convention, or the `x-api-key` convention some services use for
/// monitor endpoints. No secret ever crosses to the other kind of call.
#[derive(Clone, Copy)]
pub enum AuthKind {
    Bearer,
    XApiKey,
}

impl ChatCompletionsTransport {
    pub fn new(base_url: &str, api_key: Option<&str>, timeouts: HttpTimeouts) -> Self {
        let http = reqwest::Client::builder()
            .connect_timeout(timeouts.connect)
            // One transport never shares its credentials with another
            // connection: dispatch is explicit below, redirects refused.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client with only timeouts configured");
        let catalog_http = reqwest::Client::builder()
            .connect_timeout(timeouts.catalog_connect)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client with only timeouts configured");
        ChatCompletionsTransport {
            http,
            catalog_http,
            base_url: base_url.to_owned(),
            api_key: api_key.map(str::to_owned),
            timeouts,
        }
    }

    /// GET {base}/models: the OpenAI-compatible catalog endpoint shared by
    /// the cloud drivers. The body returns verbatim as JSON; each driver
    /// parses its own entry shapes — the transport has no catalog semantics.
    pub async fn get_models(&self) -> Result<Value, TransportFailure> {
        self.get_json(
            &format!("{}/models", self.base_url),
            self.timeouts.catalog,
            AuthKind::Bearer,
        )
        .await
    }

    /// One authenticated GET to a data-plane URL (catalog, balance monitor,
    /// engine state). `timeout` is the whole-request budget chosen by the
    /// caller (catalog, balance, or local-state); the connect budget stays
    /// the shared short one. Credentials stay bound to this connection's
    /// URLs; redirects are refused, so the key is never sent to an address
    /// from a response.
    pub async fn get_json(
        &self,
        url: &str,
        timeout: std::time::Duration,
        auth: AuthKind,
    ) -> Result<Value, TransportFailure> {
        self.get_json_with_headers(url, timeout, auth, &[]).await
    }

    /// [`get_json`] plus per-request headers for upstreams whose data-plane
    /// GETs carry more than credentials (WorkBuddy demands a specific
    /// User-Agent and an anonymous user id next to the Bearer key).
    pub async fn get_json_with_headers(
        &self,
        url: &str,
        timeout: std::time::Duration,
        auth: AuthKind,
        extra_headers: &[(&str, &str)],
    ) -> Result<Value, TransportFailure> {
        let mut request = self.catalog_http.get(url).timeout(timeout);
        if let Some(key) = &self.api_key {
            request = match auth {
                AuthKind::Bearer => request.bearer_auth(key),
                AuthKind::XApiKey => request.header("x-api-key", key),
            };
        }
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.map_err(classify_send_error)?;

        if !response.status().is_success() {
            let status = response.status();
            let body = bounded_body(response, BODY_LIMIT).await;
            return Err(TransportFailure::Http {
                status,
                retry_after: None,
                body,
            });
        }

        response
            .json::<Value>()
            .await
            .map_err(TransportFailure::Network)
    }

    /// One authenticated POST with a JSON body (WorkBuddy's billing meter
    /// reads credit balances this way). Same boundary rules as the GETs:
    /// bounded body, no redirects, credentials bound to this connection.
    pub async fn post_json_with_headers(
        &self,
        url: &str,
        timeout: std::time::Duration,
        auth: AuthKind,
        extra_headers: &[(&str, &str)],
        body: &Value,
    ) -> Result<Value, TransportFailure> {
        let mut request = self.catalog_http.post(url).timeout(timeout).json(body);
        if let Some(key) = &self.api_key {
            request = match auth {
                AuthKind::Bearer => request.bearer_auth(key),
                AuthKind::XApiKey => request.header("x-api-key", key),
            };
        }
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.map_err(classify_send_error)?;
        if !response.status().is_success() {
            let status = response.status();
            let body = bounded_body(response, BODY_LIMIT).await;
            return Err(TransportFailure::Http {
                status,
                retry_after: None,
                body,
            });
        }
        response
            .json::<Value>()
            .await
            .map_err(TransportFailure::Network)
    }

    /// Execute one attempt. The upstream model id is substituted into the
    /// body's `model` field; every other field passes through verbatim.
    pub async fn execute(
        &self,
        model: &str,
        request: &InferenceRequest,
    ) -> Result<UpstreamResponse, TransportFailure> {
        self.execute_with_headers(model, request, &[]).await
    }

    /// [`execute`] plus per-request headers for drivers whose upstream
    /// demands more than Bearer auth (OpenCode Go's session affinity).
    pub async fn execute_with_headers(
        &self,
        model: &str,
        request: &InferenceRequest,
        extra_headers: &[(&str, &str)],
    ) -> Result<UpstreamResponse, TransportFailure> {
        let Some(body) = request.body.as_object() else {
            return Err(TransportFailure::MalformedBody);
        };
        let mut body = body.clone();
        body.insert("model".into(), json!(model));
        // `developer` is OpenAI's renamed `system`; strict upstreams (Kimi)
        // reject the new name, and the rename is lossless where it is known.
        if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages.iter_mut() {
                if message.get("role") == Some(&json!("developer")) {
                    message["role"] = json!("system");
                }
            }
        }

        let mut send = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .json(&body)
            .timeout(self.timeouts.total_attempt);
        if let Some(key) = &self.api_key {
            send = send.bearer_auth(key);
        }
        for (name, value) in extra_headers {
            send = send.header(*name, *value);
        }
        let send = send.send();

        let response = tokio::time::timeout(self.timeouts.first_byte, send)
            .await
            .map_err(|_| TransportFailure::FirstByteTimeout)?
            .map_err(classify_send_error)?;

        if !response.status().is_success() {
            let status = response.status();
            let retry_after = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let body = bounded_body(response, BODY_LIMIT).await;
            return Err(TransportFailure::Http {
                status,
                retry_after,
                body,
            });
        }

        if body.get("stream") == Some(&json!(true)) {
            let stream = response
                .bytes_stream()
                .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
                .map(|chunk| {
                    chunk.map_err(|err| DriverError {
                        // A stream that already began is over for this attempt:
                        // no retry is possible regardless of class, and the
                        // handler (not the class) enforces that.
                        class: FailureClass::Transient,
                        message: format!("upstream stream failed: {err}"),
                    })
                });
            Ok(UpstreamResponse::Stream(Box::pin(stream)))
        } else {
            let value = response
                .json::<Value>()
                .await
                .map_err(TransportFailure::Network)?;
            Ok(UpstreamResponse::Complete(value))
        }
    }
}

/// A send-phase failure without an HTTP response is a network problem; a
/// reqwest timeout there means the attempt budget ran out, not first byte.
fn classify_send_error(err: reqwest::Error) -> TransportFailure {
    // A connect timeout sets both is_timeout and is_connect; it is a
    // network failure (retryable elsewhere), not a spent attempt budget.
    if err.is_timeout() && !err.is_connect() {
        TransportFailure::AttemptTimeout
    } else {
        TransportFailure::Network(err)
    }
}

/// Parse GET {base}/models for OpenAI-compatible upstreams: `data[]`
/// entries are objects with an `id` (DeepSeek, llama.cpp, Strata) or plain
/// strings (Z.AI's second documented shape). Context size comes from
/// `context_window` (DeepSeek), `context_length`, `limit.context` (OpenCode
/// Go) or `meta.n_ctx` (local engines) when reported; Z.AI reports none. A
/// bad schema is an error, never a claim that the upstream has no models.
pub fn parse_openai_models(value: &Value) -> Result<Vec<DiscoveredModel>, String> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid schema".to_owned())?;
    data.iter()
        .map(|entry| {
            let upstream_id = match entry {
                Value::String(id) => id.clone(),
                Value::Object(object) => object
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| "bad entry".to_owned())?,
                _ => return Err("bad entry".to_owned()),
            };
            let context_tokens = entry
                .get("context_window")
                .and_then(Value::as_u64)
                .or_else(|| entry.get("context_length").and_then(Value::as_u64))
                .or_else(|| entry.pointer("/limit/context").and_then(Value::as_u64))
                .or_else(|| {
                    entry
                        .get("meta")
                        .and_then(Value::as_object)
                        .and_then(|meta| meta.get("n_ctx"))
                        .and_then(Value::as_u64)
                });
            Ok(DiscoveredModel {
                upstream_id,
                context_tokens,
            })
        })
        .collect()
}

/// Read at most `limit` bytes of the response body: an upstream error body
/// is untrusted input and must not be collected whole into RAM.
async fn bounded_body(response: reqwest::Response, limit: usize) -> String {
    let mut stream = response.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                buf.extend_from_slice(&bytes);
                if buf.len() >= limit {
                    buf.truncate(limit);
                    break;
                }
            }
            // A body that cannot be read is reported as an empty body:
            // classification works with what arrived.
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::driver::InferenceRequest;
    use futures_util::StreamExt;
    use std::time::Duration;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn timeouts() -> HttpTimeouts {
        HttpTimeouts {
            first_byte: Duration::from_millis(60_000),
            total_attempt: Duration::from_secs(600),
            ..HttpTimeouts::default()
        }
    }

    fn transport(server: &MockServer) -> ChatCompletionsTransport {
        ChatCompletionsTransport::new(&server.uri(), Some("test-key"), timeouts())
    }

    fn request(stream: bool) -> InferenceRequest {
        InferenceRequest {
            session_id: "conversation-7".into(),
            body: json!({
                "model": "client-facing-model",
                "messages": [{"role": "user", "content": "hi"}],
                "unknown_future_field": {"nested": [1, 2]},
                "stream": stream,
            }),
        }
    }

    #[tokio::test]
    async fn a_developer_role_is_renamed_to_system_for_strict_upstreams() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({
                "messages": [{"role": "system", "content": "be brief"}],
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
            })))
            .mount(&server)
            .await;

        let mut request = request(false);
        request.body["messages"] = json!([
            {"role": "developer", "content": "be brief"},
            {"role": "user", "content": "hi"},
        ]);
        let response = transport(&server)
            .execute("upstream-id", &request)
            .await
            .unwrap();
        assert!(matches!(response, UpstreamResponse::Complete(_)));
    }

    #[tokio::test]
    async fn non_streaming_success_substitutes_the_model_and_passes_the_rest_through() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .and(body_partial_json(json!({
                "model": "upstream-id",
                "messages": [{"role": "user", "content": "hi"}],
                "unknown_future_field": {"nested": [1, 2]},
                "stream": false,
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "resp-1",
                "choices": [{"message": {"role": "assistant", "content": "hello"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            })))
            .mount(&server)
            .await;

        let response = transport(&server)
            .execute("upstream-id", &request(false))
            .await
            .unwrap();
        match response {
            UpstreamResponse::Complete(value) => {
                assert_eq!(value["choices"][0]["message"]["content"], "hello");
                assert_eq!(value["usage"]["prompt_tokens"], 3);
            }
            UpstreamResponse::Stream(_) => panic!("non-streaming request"),
        }
    }

    #[tokio::test]
    async fn streaming_success_relays_raw_bytes() {
        let server = MockServer::start().await;
        let sse = "data: {\"delta\":\"he\"}\n\ndata: {\"delta\":\"llo\"}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(body_partial_json(json!({"stream": true})))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .mount(&server)
            .await;

        let response = transport(&server)
            .execute("upstream-id", &request(true))
            .await
            .unwrap();
        match response {
            UpstreamResponse::Stream(mut stream) => {
                let mut relayed = Vec::new();
                while let Some(chunk) = stream.next().await {
                    relayed.extend_from_slice(&chunk.unwrap());
                }
                assert_eq!(String::from_utf8_lossy(&relayed), sse);
            }
            UpstreamResponse::Complete(_) => panic!("streaming request"),
        }
    }

    #[tokio::test]
    async fn an_http_error_carries_status_retry_after_and_truncated_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(429)
                    .insert_header("retry-after", "7")
                    .set_body_json(json!({"error": {"message": "rate limited"}})),
            )
            .mount(&server)
            .await;

        let failure = transport(&server)
            .execute("upstream-id", &request(false))
            .await
            .err()
            .expect("expected failure");
        match failure {
            TransportFailure::Http {
                status,
                retry_after,
                body,
            } => {
                assert_eq!(status, reqwest::StatusCode::TOO_MANY_REQUESTS);
                assert_eq!(retry_after.as_deref(), Some("7"));
                assert!(body.contains("rate limited"));
            }
            other => panic!("expected Http, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_oversized_error_body_is_truncated_to_the_limit() {
        let server = MockServer::start().await;
        let huge = "x".repeat(50_000);
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(500).set_body_string(huge))
            .mount(&server)
            .await;

        let failure = transport(&server)
            .execute("upstream-id", &request(false))
            .await
            .err()
            .expect("expected failure");
        match failure {
            TransportFailure::Http { body, .. } => assert_eq!(body.len(), BODY_LIMIT),
            other => panic!("expected Http, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_slow_first_byte_is_reported_as_first_byte_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(2)))
            .mount(&server)
            .await;

        let mut timeouts = timeouts();
        timeouts.first_byte = Duration::from_millis(50);
        let transport = ChatCompletionsTransport::new(&server.uri(), Some("test-key"), timeouts);
        let failure = transport
            .execute("upstream-id", &request(false))
            .await
            .err()
            .expect("expected failure");
        assert!(matches!(failure, TransportFailure::FirstByteTimeout));
    }

    #[tokio::test]
    async fn the_attempt_budget_is_reported_as_attempt_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(2)))
            .mount(&server)
            .await;

        let mut timeouts = timeouts();
        timeouts.total_attempt = Duration::from_millis(50);
        let transport = ChatCompletionsTransport::new(&server.uri(), Some("test-key"), timeouts);
        let failure = transport
            .execute("upstream-id", &request(false))
            .await
            .err()
            .expect("expected failure");
        assert!(matches!(failure, TransportFailure::AttemptTimeout));
    }

    #[tokio::test]
    async fn a_non_object_body_is_rejected_before_any_network_call() {
        let failure = transport(&MockServer::start().await)
            .execute(
                "upstream-id",
                &InferenceRequest {
                    body: json!(["not", "an", "object"]),
                    session_id: "conversation-7".into(),
                },
            )
            .await
            .err()
            .expect("expected failure");
        assert!(matches!(failure, TransportFailure::MalformedBody));
    }

    #[tokio::test]
    async fn an_unreachable_host_is_a_network_failure() {
        // TEST-NET-1: guaranteed unroutable address, fast connect timeout.
        let mut timeouts = timeouts();
        timeouts.connect = Duration::from_millis(100);
        let transport =
            ChatCompletionsTransport::new("http://192.0.2.1:9", Some("test-key"), timeouts);
        let failure = transport
            .execute("upstream-id", &request(false))
            .await
            .err()
            .expect("expected failure");
        assert!(matches!(failure, TransportFailure::Network(_)));
    }
}
