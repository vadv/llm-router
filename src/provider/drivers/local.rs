// Local LAN engines (llama.cpp, Strata): OpenAI-compatible Chat
// Completions with no quota semantics and a state monitor. The transport
// and catalog endpoint are shared with the cloud drivers; only the state
// probes and error classification are local.
//
// Control endpoints live on the API base with a terminal `/v1` removed
// (llama.cpp `/props`, `/slots`; Strata additionally serves `/v1/status`
// on the versioned path). `/slots` can wake a sleeping llama.cpp engine,
// so it is read only after `/props` proved the engine awake.

use serde_json::Value;

use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{AuthKind, ChatCompletionsTransport, TransportFailure};
use crate::routing::classify::{DriverError, FailureClass};

/// Which engine protocol the connection speaks. Both are llama.cpp
/// descendants; Strata diverges in its state endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalKind {
    LlamaCpp,
    Strata,
}

pub struct LocalEngineDriver {
    kind: LocalKind,
    transport: ChatCompletionsTransport,
    /// Control base: API base minus a terminal `/v1` path segment.
    control_base: String,
    timeouts: HttpTimeouts,
}

impl LocalEngineDriver {
    pub fn new(
        kind: LocalKind,
        base_url: &str,
        api_key: Option<&str>,
        timeouts: HttpTimeouts,
    ) -> Self {
        LocalEngineDriver {
            kind,
            transport: ChatCompletionsTransport::new(base_url, api_key, timeouts),
            control_base: control_base(base_url),
            timeouts,
        }
    }

    /// GET {base}/status: Strata's own state endpoint (engine 0.1.59,
    /// verified live). One request reports everything.
    async fn strata_status(&self) -> Result<LocalState, TransportFailure> {
        let value = self
            .transport
            .get_json(
                &format!("{}/v1/status", self.control_base),
                self.timeouts.local_state,
                AuthKind::Bearer,
            )
            .await?;
        Ok(LocalState {
            model: str_field(&value, &["model"]),
            loaded: value.get("loaded").and_then(Value::as_bool),
            slots: value
                .get("concurrency")
                .and_then(|c| c.get("serving"))
                .and_then(Value::as_u64),
            busy: value
                .get("activity")
                .and_then(|a| a.get("in_flight"))
                .and_then(Value::as_u64),
        })
    }

    /// GET {control}/props: the metadata probe both engines share. A
    /// sleeping engine is not woken by this request.
    async fn props(&self) -> Result<Value, TransportFailure> {
        self.transport
            .get_json(
                &format!("{}/props", self.control_base),
                self.timeouts.local_state,
                AuthKind::Bearer,
            )
            .await
    }

    /// GET {control}/slots: llama.cpp occupancy. Called only for an awake
    /// engine, because this endpoint wakes a sleeping one.
    async fn llamacpp_busy(&self) -> Result<u64, TransportFailure> {
        let value = self
            .transport
            .get_json(
                &format!("{}/slots", self.control_base),
                self.timeouts.local_state,
                AuthKind::Bearer,
            )
            .await?;
        value
            .as_array()
            .map(|slots| {
                slots
                    .iter()
                    .filter(|slot| slot.get("is_processing").and_then(Value::as_bool) == Some(true))
                    .count() as u64
            })
            .ok_or_else(|| TransportFailure::MalformedBody)
    }
}

impl Driver for LocalEngineDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_models()
                .await
                .map_err(|failure| classify(self.kind, failure))?;
            let models = match self.kind {
                LocalKind::Strata => parse_openai_style(&value),
                LocalKind::LlamaCpp => parse_llamacpp_models(&value),
            };
            models.map_err(|reason| DriverError {
                // A bad catalog schema is engine trouble; the last snapshot
                // stays in force.
                class: FailureClass::Transient,
                message: format!("local catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        // Local engines have no quotas: nothing to observe as balance.
        Box::pin(async { Ok(None) })
    }

    fn fetch_local_state(&self) -> BoxFuture<'_, Result<Option<LocalState>, DriverError>> {
        Box::pin(async {
            let state = match self.kind {
                LocalKind::Strata => self.strata_status().await,
                LocalKind::LlamaCpp => {
                    let props = self.props().await;
                    let props = match props {
                        Ok(value) => value,
                        Err(failure) => return Err(classify(self.kind, failure)),
                    };
                    // A sleeping engine answers /props but must not be woken
                    // by the occupancy read; busy stays unknown.
                    let sleeping = props.get("is_sleeping").and_then(Value::as_bool);
                    let busy = if sleeping == Some(true) {
                        None
                    } else {
                        // A failed occupancy read degrades to unknown,
                        // not to zero: zero would look like capacity.
                        self.llamacpp_busy().await.ok()
                    };
                    Ok(LocalState {
                        model: str_field(&props, &["model_alias"]),
                        loaded: sleeping.map(|sleeping| !sleeping),
                        slots: props.get("total_slots").and_then(Value::as_u64),
                        busy,
                    })
                }
            };
            state
                .map(Some)
                .map_err(|failure| classify(self.kind, failure))
        })
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
                .map_err(|failure| classify(self.kind, failure))
        })
    }
}

/// The API base with a terminal `/v1` path segment removed, so deployment
/// path prefixes survive (`http://h/prefix/v1` -> `http://h/prefix`).
fn control_base(base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    match trimmed.strip_suffix("/v1") {
        Some(rest) if rest.contains("://") => rest.to_owned(),
        _ => trimmed.to_owned(),
    }
}

fn str_field(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_owned)
}

/// Strata catalog (GET {base}/models): OpenAI shape with `meta.n_ctx`.
fn parse_openai_style(value: &Value) -> Result<Vec<DiscoveredModel>, String> {
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid schema".to_owned())?;
    data.iter()
        .map(|entry| {
            let upstream_id = entry
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "bad entry".to_owned())?;
            let context_tokens = entry
                .get("meta")
                .and_then(|meta| meta.get("n_ctx"))
                .and_then(Value::as_u64);
            Ok(DiscoveredModel {
                upstream_id,
                context_tokens,
            })
        })
        .collect()
}

/// llama.cpp catalog (GET {base}/models): Ollama-style `models[]` entries
/// with a `model` id (verified live). No context sizes are reported.
fn parse_llamacpp_models(value: &Value) -> Result<Vec<DiscoveredModel>, String> {
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or_else(|| "invalid schema".to_owned())?;
    models
        .iter()
        .map(|entry| {
            let upstream_id = entry
                .get("model")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "bad entry".to_owned())?;
            Ok(DiscoveredModel {
                upstream_id,
                context_tokens: None,
            })
        })
        .collect()
}

/// Local engines have no quotas, so no status means exhaustion: every
/// failure is transport trouble worth a retry, or a broken configuration.
fn classify(kind: LocalKind, failure: TransportFailure) -> DriverError {
    let name = match kind {
        LocalKind::LlamaCpp => "llamacpp",
        LocalKind::Strata => "strata",
    };
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http { status, .. } => match status.as_u16() {
            // A local engine answering 429 is out of slots right now, not
            // out of quota: plain transient pressure.
            429 => FailureClass::Transient,
            401 | 403 => FailureClass::InvalidBackend,
            400 => FailureClass::UpstreamBadRequest,
            404 | 413 | 422 => FailureClass::InvalidRequest,
            502..=504 => FailureClass::Transient,
            _ => FailureClass::Unknown,
        },
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!("{name} upstream {}: {body}", status.as_u16())
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("{name} network: {err}"),
        TransportFailure::FirstByteTimeout => format!("{name} first byte timeout"),
        TransportFailure::AttemptTimeout => format!("{name} attempt budget exhausted"),
    };
    DriverError { class, message }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn http(status: u16) -> TransportFailure {
        TransportFailure::Http {
            status: reqwest::StatusCode::from_u16(status).unwrap(),
            retry_after: None,
            body: String::new(),
        }
    }

    fn driver(kind: LocalKind, server: &MockServer, api_key: Option<&str>) -> LocalEngineDriver {
        LocalEngineDriver::new(kind, &server.uri(), api_key, HttpTimeouts::default())
    }

    #[test]
    fn control_base_strips_only_a_terminal_version_path() {
        for (base, expected) in [
            ("http://h:8080/v1", "http://h:8080"),
            ("http://h:8080/v1/", "http://h:8080"),
            ("http://h/prefix/v1", "http://h/prefix"),
            ("http://h:8080", "http://h:8080"),
            ("http://h/v1/v1", "http://h/v1"),
        ] {
            assert_eq!(control_base(base), expected, "base {base}");
        }
    }

    #[test]
    fn a_local_429_is_transient_not_quota() {
        assert_eq!(
            classify(LocalKind::LlamaCpp, http(429)).class,
            FailureClass::Transient
        );
        assert_eq!(
            classify(LocalKind::Strata, http(503)).class,
            FailureClass::Transient
        );
        assert_eq!(
            classify(LocalKind::LlamaCpp, http(401)).class,
            FailureClass::InvalidBackend
        );
        assert_eq!(
            classify(LocalKind::Strata, http(400)).class,
            FailureClass::UpstreamBadRequest
        );
        assert_eq!(
            classify(LocalKind::LlamaCpp, http(418)).class,
            FailureClass::Unknown
        );
    }

    #[test]
    fn llamacpp_catalog_parses_the_ollama_style_shape() {
        let value = json!({"models": [
            {"name": "qwen3.8-flash-next-q2", "model": "qwen3.8-flash-next-q2"}
        ]});
        let models = parse_llamacpp_models(&value).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].upstream_id, "qwen3.8-flash-next-q2");
        assert_eq!(models[0].context_tokens, None);

        assert!(parse_llamacpp_models(&json!({"data": []})).is_err());
        assert!(parse_llamacpp_models(&json!({"models": [{"size": "x"}]})).is_err());
    }

    #[test]
    fn strata_catalog_parses_meta_n_ctx() {
        let value = json!({"object": "list", "data": [
            {"id": "swift-1.5-iq3_s", "meta": {"n_ctx": 131072}}
        ]});
        let models = parse_openai_style(&value).unwrap();
        assert_eq!(models[0].upstream_id, "swift-1.5-iq3_s");
        assert_eq!(models[0].context_tokens, Some(131072));
    }

    #[tokio::test]
    async fn strata_state_comes_from_one_status_request() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/status"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "service": "strata",
                "model": "swift-1.5-iq3_s",
                "loaded": true,
                "concurrency": {"serving": 1, "requested": 1},
                "activity": {"requests": 634, "in_flight": 0}
            })))
            .mount(&server)
            .await;

        let state = driver(LocalKind::Strata, &server, None)
            .fetch_local_state()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            state,
            LocalState {
                model: Some("swift-1.5-iq3_s".into()),
                loaded: Some(true),
                slots: Some(1),
                busy: Some(0),
            }
        );
    }

    #[tokio::test]
    async fn llamacpp_state_combines_props_and_slots_and_never_wakes_a_sleeper() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/props"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model_alias": "qwen3.8-flash-next-q2",
                "is_sleeping": false,
                "total_slots": 4,
                "default_generation_settings": {"n_ctx": 131072}
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/slots"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([
                {"id": 0, "is_processing": false},
                {"id": 1, "is_processing": true},
                {"id": 2, "is_processing": true},
                {"id": 3, "is_processing": false}
            ])))
            .mount(&server)
            .await;

        let state = driver(LocalKind::LlamaCpp, &server, None)
            .fetch_local_state()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            state,
            LocalState {
                model: Some("qwen3.8-flash-next-q2".into()),
                loaded: Some(true),
                slots: Some(4),
                busy: Some(2),
            }
        );
    }

    #[tokio::test]
    async fn a_sleeping_llamacpp_reports_unknown_busy_without_touching_slots() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/props"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "model_alias": "m",
                "is_sleeping": true,
                "total_slots": 4
            })))
            .mount(&server)
            .await;
        // /slots answers 500 if hit; the test asserts it is never called.
        Mock::given(method("GET"))
            .and(path("/slots"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;

        let state = driver(LocalKind::LlamaCpp, &server, None)
            .fetch_local_state()
            .await
            .unwrap()
            .unwrap();
        assert_eq!(state.loaded, Some(false));
        assert_eq!(state.busy, None);
    }

    #[tokio::test]
    async fn an_unreachable_engine_is_a_classified_error_not_a_silent_zero() {
        // Port 9 (discard) refuses connections immediately.
        let error = LocalEngineDriver::new(
            LocalKind::LlamaCpp,
            "http://127.0.0.1:9/v1",
            None,
            HttpTimeouts::default(),
        )
        .fetch_local_state()
        .await
        .unwrap_err();
        assert_eq!(error.class, FailureClass::Transient);
    }

    #[tokio::test]
    async fn inference_passes_the_model_through_without_auth_when_no_key() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(wiremock::matchers::body_partial_json(json!({"model": "m"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "x", "choices": [{"message": {"role": "assistant", "content": "ok"}}]
            })))
            .mount(&server)
            .await;

        let request = InferenceRequest {
            body: json!({"model": "anything", "messages": []}),
            session_id: "conversation-7".into(),
        };
        let driver = LocalEngineDriver::new(
            LocalKind::LlamaCpp,
            &format!("{}/v1", server.uri()),
            None,
            HttpTimeouts::default(),
        );
        let response = driver.execute("m", &request).await.unwrap();
        match response {
            UpstreamResponse::Complete(value) => {
                assert_eq!(value["choices"][0]["message"]["content"], "ok")
            }
            UpstreamResponse::Stream(_) => panic!("expected a complete response"),
        }
    }

    #[tokio::test]
    async fn a_local_engine_with_a_key_authenticates_the_catalog() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/models"))
            .and(header("Authorization", "Bearer local-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{"id": "swift-1.5-iq3_s", "meta": {"n_ctx": 131072}}]
            })))
            .mount(&server)
            .await;

        let driver = LocalEngineDriver::new(
            LocalKind::Strata,
            &format!("{}/v1", server.uri()),
            Some("local-key"),
            HttpTimeouts::default(),
        );
        let models = driver.fetch_catalog().await.unwrap();
        assert_eq!(models[0].upstream_id, "swift-1.5-iq3_s");
    }
}
