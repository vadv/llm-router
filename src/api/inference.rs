// POST /v1/chat/completions: authorize, identify the conversation, let the
// router pick a member, relay the upstream response, record history.
//
// The handler never loops over providers itself and never invents error
// meanings: classification is the drivers' job.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use crate::storage::events::event_kind;
use axum::Json;
use axum::body::Body;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use futures_util::stream::BoxStream;
use serde_json::{Value, json};

use crate::history::extract::{complete_attempt, request_input};
use crate::history::observer::StreamObserver;
use crate::history::{AttemptObservation, AttemptSummary};
use crate::metamodel::MetamodelId;
use crate::model::ModelId;
use crate::provider::driver::{InferenceRequest, UpstreamResponse};
use crate::routing::RouteFailure;
use crate::routing::classify::{DriverError, FailureClass};

use super::ApiState;
use super::identity;
use super::{api_error, bearer_secret, internal_error};

/// Request ids are unique per process: unix millis plus a counter. A
/// restart cannot reuse them because time has moved on.
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

pub async fn chat_completions(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    // Authorization: one Bearer secret of any configured client key.
    let Some(secret) = bearer_secret(&headers) else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "missing or invalid API key",
        );
    };
    let Some(alias) = state.keys.authenticate(&secret) else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "missing or invalid API key",
        );
    };

    // The request must be a JSON object; the model field names the metamodel.
    if !body.is_object() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "the request body must be a JSON object",
        );
    }
    let Some(metamodel_name) = non_empty_str(&body, "model") else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "the 'model' field must be a non-empty string",
        );
    };

    // Conversation identity per the integration contract (§2.5).
    let conversation = match identity::conversation_id(&headers, &body) {
        Ok(id) => id,
        Err(e) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                &e.to_string(),
            );
        }
    };

    // The metamodel's pool, then the members usable right now: the provider
    // must exist and the model be in its catalog (snapshot or static config).
    let members = match state.metamodels.lock() {
        Ok(service) => match service.get(&MetamodelId::new(metamodel_name)) {
            Ok(Some(metamodel)) => metamodel.members().to_vec(),
            Ok(None) => {
                return api_error(
                    StatusCode::NOT_FOUND,
                    "invalid_request_error",
                    &format!("the model '{metamodel_name}' does not exist"),
                );
            }
            Err(e) => return internal_error(&e.0),
        },
        Err(_) => return internal_error("metamodel storage is unavailable"),
    };
    let usable: Vec<ModelId> = members
        .into_iter()
        .filter(|m| member_is_selectable(&state, m))
        .collect();
    if usable.is_empty() {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "api_error",
            &format!("no model of '{metamodel_name}' is available right now"),
        );
    }

    // History: a failed write must not fail inference — the request is
    // still servable, and health reports the storage problem later.
    let now = now_unix();
    let request_id = next_request_id();
    let observation = request_input(&body);
    let base = SummaryBase {
        id: request_id.clone(),
        key_alias: alias.to_owned(),
        metamodel: metamodel_name.to_owned(),
        started_at_unix: now,
        input: observation.input,
        declared_tools: observation.declared_tools,
        issues: observation.issues.0,
    };
    state.running.begin(crate::history::RunningRequest {
        id: base.id.clone(),
        key_alias: base.key_alias.clone(),
        metamodel: base.metamodel.clone(),
        started_at_unix: base.started_at_unix,
        attempts: Vec::new(),
    });
    // Closed attempts of this request; a streaming attempt joins at
    // relay end, once its bytes have said everything they will.
    let attempts: Arc<Mutex<Vec<AttemptSummary>>> = Arc::new(Mutex::new(Vec::new()));
    let mut open = OpenCall {
        state: Arc::clone(&state),
        base: base.clone(),
        attempts: Arc::clone(&attempts),
        armed: true,
    };

    // The fallback loop: selection, retries, bans, pinning.
    let pinned_before = state.router.session_binding(&conversation);
    let sink = Arc::clone(&attempts);
    let routed = state
        .router
        .execute(&conversation, &usable, now, |model| {
            let state = Arc::clone(&state);
            let attempts = Arc::clone(&sink);
            let request_id = request_id.clone();
            let body = body.clone();
            let model = model.clone();
            let conversation = conversation.clone();
            async move {
                execute_attempt(&state, &request_id, &attempts, &model, &body, &conversation).await
            }
        })
        .await;
    // From here on every path closes the call itself.
    open.armed = false;

    match routed {
        Ok((response, end)) => {
            // A session that landed on a different member than it started
            // with is the one routing fact worth an event: it means a
            // fallback moved a live conversation.
            if let (Some(before), Some(after)) = (
                pinned_before.as_ref(),
                state.router.session_binding(&conversation).as_ref(),
            ) && before != after
            {
                crate::schedule::emit(
                    &state,
                    event_kind::MODEL_SWITCH,
                    None,
                    &json!({
                        "pool": metamodel_name,
                        "from": format!("{}/{}", before.provider(), before.upstream()),
                        "to": format!("{}/{}", after.provider(), after.upstream()),
                    }),
                );
            }
            respond(state, base, attempts, response, end).await
        }
        Err(failure) => {
            if let RouteFailure::AllMembersFailed(_) = &failure {
                crate::schedule::emit(
                    &state,
                    event_kind::ALL_MODELS_FAILED,
                    None,
                    &json!({ "metamodel": metamodel_name, "members": usable.len() }),
                );
            }
            let (status, message) = route_failure(failure);
            let closed = drain_attempts(&attempts);
            write_summary(&state, base, closed, outcome_of(&status));
            api_error(status, "api_error", &message)
        }
    }
}

/// A call that is listed as running but has not yet got its answer. A
/// client that hangs up before the first byte drops the handler at its
/// await, and nothing else would end the call: it stayed "running" for as
/// long as the core ran and never reached history. While `armed`, the drop
/// closes the call as the client's cancel, as a hang-up mid-answer is.
struct OpenCall {
    state: Arc<ApiState>,
    base: SummaryBase,
    attempts: Arc<Mutex<Vec<AttemptSummary>>>,
    armed: bool,
}

impl Drop for OpenCall {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut closed = drain_attempts(&self.attempts);
        // The attempt in flight was cut short: how long it ran is known from
        // the running view, how it went is not. The view goes first: writing
        // the summary ends the call in it.
        let running = self
            .state
            .running
            .snapshot()
            .into_iter()
            .find(|request| request.id == self.base.id);
        if let Some(attempt) =
            running.and_then(|request| request.attempts.get(closed.len()).cloned())
        {
            closed.push(cut_attempt(attempt));
        }
        write_summary(&self.state, self.base.clone(), closed, "client_cancel");
    }
}

/// The attempt a hang-up cut short.
fn cut_attempt(open: crate::history::RunningAttempt) -> AttemptSummary {
    let observation = AttemptObservation::default();
    let finished_at_unix = now_unix();
    AttemptSummary {
        provider_id: open.provider_id,
        upstream_id: open.upstream_id,
        started_at_unix: open.started_at_unix,
        finished_at_unix,
        result: "client_cancel".into(),
        error: None,
        error_class: None,
        duration_ms: Some((finished_at_unix - open.started_at_unix).max(0) * 1000),
        switch_reason: None,
        input_tokens: observation.input_tokens,
        output_tokens: observation.output_tokens,
        cost: observation.cost,
        response: observation.response,
        tool_calls: observation.tool_calls,
        issues: observation.issues.0,
    }
}

/// Fixed facts of one request; attempts attach as they close.
#[derive(Clone)]
struct SummaryBase {
    id: String,
    key_alias: String,
    metamodel: String,
    started_at_unix: i64,
    input: Option<crate::history::Preview>,
    declared_tools: Option<u32>,
    issues: Vec<crate::history::ExtractIssue>,
}

/// What the relay still owes history for a streamed answer.
// shortcut: variants are few and live only at request scope; the box is
// fine until an attempt state grows a third heavyweight shape.
#[allow(clippy::large_enum_variant)]
enum AttemptEnd {
    Done,
    Streaming {
        observer: StreamObserver,
        started_at_unix: i64,
        started_at: Instant,
        provider_id: String,
        upstream_id: String,
    },
}

/// One upstream call on one model, recorded into the shared sink (or
/// handed to the relay as a live observer for a stream).
#[allow(clippy::too_many_arguments)]
async fn execute_attempt(
    state: &ApiState,
    request_id: &str,
    attempts: &Mutex<Vec<AttemptSummary>>,
    model: &ModelId,
    body: &Value,
    conversation: &str,
) -> Result<(UpstreamResponse, AttemptEnd), DriverError> {
    // The member filter proved the provider exists; the registry is frozen.
    let provider = state
        .providers
        .get(model.provider())
        .expect("member filter proved the provider exists");

    let started = now_unix();
    // Monotonic clock for the attempt duration; the wall-clock unix
    // timestamps above are for display and retention only.
    let started_at = Instant::now();
    state.running.add_attempt(
        request_id,
        crate::history::RunningAttempt {
            provider_id: model.provider().as_str().to_owned(),
            upstream_id: model.upstream().to_owned(),
            started_at_unix: started,
        },
    );

    let request = InferenceRequest {
        body: body.clone(),
        session_id: conversation.to_owned(),
    };
    let outcome = provider.driver().execute(model.upstream(), &request).await;
    let finished = now_unix();
    let duration_ms = started_at.elapsed().as_millis() as i64;
    let push = |result: &str,
                observation: AttemptObservation,
                error: Option<String>,
                error_class: Option<&'static str>| {
        let summary = AttemptSummary {
            provider_id: model.provider().as_str().to_owned(),
            upstream_id: model.upstream().to_owned(),
            started_at_unix: started,
            finished_at_unix: finished,
            result: result.to_owned(),
            error,
            error_class: error_class.map(str::to_owned),
            duration_ms: Some(duration_ms),
            switch_reason: None,
            input_tokens: observation.input_tokens,
            output_tokens: observation.output_tokens,
            cost: observation.cost,
            response: observation.response,
            tool_calls: observation.tool_calls,
            issues: observation.issues.0,
        };
        if let Ok(mut sink) = attempts.lock() {
            sink.push(summary);
        }
    };
    match outcome {
        Ok(UpstreamResponse::Complete(value)) => {
            push("ok", complete_attempt(&value), None, None);
            Ok((UpstreamResponse::Complete(value), AttemptEnd::Done))
        }
        Ok(UpstreamResponse::Stream(stream)) => Ok((
            UpstreamResponse::Stream(stream),
            AttemptEnd::Streaming {
                observer: StreamObserver::new(),
                started_at_unix: started,
                started_at,
                provider_id: model.provider().as_str().to_owned(),
                upstream_id: model.upstream().to_owned(),
            },
        )),
        Err(err) => {
            push(
                "error",
                crate::history::AttemptObservation::default(),
                Some(err.message.clone()),
                Some(err.class.as_str()),
            );
            Err(err)
        }
    }
}

/// Relay the routed response: a complete JSON answer as-is, a stream as the
/// raw bytes with the request finished when the stream ends.
async fn respond(
    state: Arc<ApiState>,
    base: SummaryBase,
    attempts: Arc<Mutex<Vec<AttemptSummary>>>,
    response: UpstreamResponse,
    end: AttemptEnd,
) -> Response {
    match response {
        UpstreamResponse::Complete(value) => {
            let closed = drain_attempts(&attempts);
            write_summary(&state, base, closed, "ok");
            (StatusCode::OK, Json(value)).into_response()
        }
        UpstreamResponse::Stream(stream) => {
            let AttemptEnd::Streaming {
                observer,
                started_at_unix,
                started_at,
                provider_id,
                upstream_id,
            } = end
            else {
                // A stream always ends as Streaming; Done cannot reach here.
                let closed = drain_attempts(&attempts);
                write_summary(&state, base, closed, "ok");
                return (StatusCode::OK, Json(Value::Null)).into_response();
            };
            let record = StreamRecord {
                state,
                base,
                closed: drain_attempts(&attempts),
                observer,
                started_at_unix,
                started_at,
                provider_id,
                upstream_id,
                finished: false,
                error: None,
            };
            let body = Body::from_stream(relay(stream, record));
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "text/event-stream")
                .body(body)
                .expect("static response parts")
        }
    }
}

/// A stream that relays upstream bytes as they arrive. When the upstream
/// stream fails after output began, the response simply ends — no silent
/// regeneration, no stitching — and the failure is
/// recorded in history.
fn relay(
    stream: BoxStream<'static, Result<Vec<u8>, DriverError>>,
    record: StreamRecord,
) -> impl futures_util::Stream<Item = Result<Bytes, std::convert::Infallible>> {
    futures_util::stream::unfold((stream, record), |(mut stream, mut record)| async move {
        match stream.next().await {
            Some(Ok(bytes)) => {
                // The observer reads usage, answer text and tool calls from
                // the same bytes the client gets; [DONE] ends the call.
                if record.observer.feed(&bytes) {
                    record.finish("ok");
                }
                Some((Ok(Bytes::from(bytes)), (stream, record)))
            }
            Some(Err(err)) => {
                // An answer already delivered stays ok: a late upstream
                // error does not take back the bytes the client got.
                record.error = Some(err.message.clone());
                record.finish("error");
                None
            }
            None => {
                record.finish("ok");
                None
            }
        }
    })
}

/// The outcome of one streamed call, written exactly once. A client that
/// hangs up after the last byte drops this stream, so the record must not
/// wait for another poll: without this guard a delivered answer stayed
/// "running" in history forever.
struct StreamRecord {
    state: Arc<ApiState>,
    base: SummaryBase,
    /// Attempts that closed before the stream began (retries, fallbacks).
    closed: Vec<AttemptSummary>,
    observer: StreamObserver,
    started_at_unix: i64,
    started_at: Instant,
    provider_id: String,
    upstream_id: String,
    finished: bool,
    error: Option<String>,
}

impl StreamRecord {
    fn finish(&mut self, outcome: &str) {
        if self.finished {
            return;
        }
        self.finished = true;
        // The attempt outcome mirrors the request outcome: bytes received
        // make it ok, a late upstream error an error, and a hangup a cancel
        // that reliability statistics must not count as a clean success.
        let result = match outcome {
            "error" => "error",
            "client_cancel" => "client_cancel",
            _ => "ok",
        };
        let observation = std::mem::take(&mut self.observer).finish();
        let last = AttemptSummary {
            provider_id: std::mem::take(&mut self.provider_id),
            upstream_id: std::mem::take(&mut self.upstream_id),
            started_at_unix: self.started_at_unix,
            finished_at_unix: now_unix(),
            result: result.to_owned(),
            error: self.error.take(),
            // A late in-stream error carries no recognized class: the
            // classifier only sees complete responses. NULL stays NULL.
            error_class: None,
            duration_ms: Some(self.started_at.elapsed().as_millis() as i64),
            switch_reason: None,
            input_tokens: observation.input_tokens,
            output_tokens: observation.output_tokens,
            cost: observation.cost,
            response: observation.response,
            tool_calls: observation.tool_calls,
            issues: observation.issues.0,
        };
        let mut closed = std::mem::take(&mut self.closed);
        closed.push(last);
        write_summary(
            &self.state,
            std::mem::replace(
                &mut self.base,
                SummaryBase {
                    id: String::new(),
                    key_alias: String::new(),
                    metamodel: String::new(),
                    started_at_unix: 0,
                    input: None,
                    declared_tools: None,
                    issues: Vec::new(),
                },
            ),
            closed,
            outcome,
        );
    }
}

impl Drop for StreamRecord {
    fn drop(&mut self) {
        // The answer had not ended when the connection went away.
        self.finish("client_cancel");
    }
}

/// The attempt was already closed as ok when headers arrived; the relay
/// rewrites it once the stream ends, with the usage the bytes reported.
/// A usage object is small. A larger one is dropped instead of stored:
/// A pool member is selectable when its provider is configured and the
/// model is known to it: a catalog snapshot row or a static config entry.
/// A catalog read failure skips the member — a broken catalog must not
/// route to a model whose existence cannot be confirmed.
fn member_is_selectable(state: &ApiState, model: &ModelId) -> bool {
    let Some(provider) = state.providers.get(model.provider()) else {
        return false;
    };
    if provider
        .static_models()
        .iter()
        .any(|m| m.upstream_id == model.upstream())
    {
        return true;
    }
    match state.models.lock() {
        Ok(models) => models
            .find(model.provider().as_str(), model.upstream())
            .map(|found| found.is_some())
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn route_failure(failure: RouteFailure) -> (StatusCode, String) {
    match failure {
        RouteFailure::InvalidRequest(err) => (StatusCode::BAD_REQUEST, err.message),
        RouteFailure::AllMembersFailed(err) if err.class == FailureClass::UpstreamBadRequest => {
            (StatusCode::BAD_REQUEST, err.message)
        }
        RouteFailure::AllMembersFailed(err) => (StatusCode::BAD_GATEWAY, err.message),
        RouteFailure::NoAvailableMember => (
            StatusCode::SERVICE_UNAVAILABLE,
            "no usable model remains".into(),
        ),
        RouteFailure::BanStorage(err) => (StatusCode::INTERNAL_SERVER_ERROR, err.0),
    }
}

fn outcome_of(status: &StatusCode) -> &'static str {
    if status.is_client_error() || status.is_server_error() {
        "error"
    } else {
        "ok"
    }
}

/// Take the closed attempts out of the shared sink.
fn drain_attempts(sink: &Mutex<Vec<AttemptSummary>>) -> Vec<AttemptSummary> {
    sink.lock()
        .map(|mut sink| std::mem::take(&mut *sink))
        .unwrap_or_default()
}

/// Queue the completed request summary and close its running view. A
/// dropped summary is degradation, not a failed request: health reports
/// it while inference keeps serving.
fn write_summary(
    state: &ApiState,
    base: SummaryBase,
    attempts: Vec<AttemptSummary>,
    outcome: &str,
) {
    state.running.end(&base.id);
    let summary = crate::history::RequestSummary {
        id: base.id,
        key_alias: base.key_alias,
        metamodel: base.metamodel,
        started_at_unix: base.started_at_unix,
        finished_at_unix: now_unix(),
        outcome: outcome.to_owned(),
        input: base.input,
        declared_tools: base.declared_tools,
        issues: base.issues,
        attempts,
    };
    if state.history_writer.enqueue(summary).is_err()
        && let Ok(mut slot) = state.history_writes.lock()
    {
        *slot = Some("history queue budget exceeded".to_owned());
    }
}

fn non_empty_str<'a>(body: &'a Value, field: &str) -> Option<&'a str> {
    body.get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
}

fn next_request_id() -> String {
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    // Fixed widths make ids sort lexicographically in insertion order, which
    // the history cursor (before_id) relies on.
    format!("req-{:012}-{:06}", now_unix(), n)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the epoch")
        .as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use serde_json::json;
    use wiremock;

    use crate::api::auth::KeyAuthenticator;
    use crate::config::ClientKey;
    use crate::metamodel::{Metamodel, MetamodelId, MetamodelService};
    use crate::model::{ModelId, ProviderId};
    use crate::provider::ProviderRegistry;
    use crate::routing::Router;
    use crate::storage::bans::BanStore;
    use crate::storage::catalog::ModelStore;
    use crate::storage::pools::PoolStore;

    fn state() -> Arc<ApiState> {
        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let (history, history_writer) = crate::api::tests_support::history_pair("state");
        Arc::new(ApiState {
            started_at_unix: 1_700_000_000,
            keys: KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "secret-one".into(),
            }]),
            providers: ProviderRegistry::build(&[], crate::config::HttpTimeouts::default())
                .unwrap(),
            router: Router::new(
                BanStore::new(conn()).unwrap(),
                crate::config::BanPolicy::default(),
                crate::config::RetryPolicy::default(),
            ),
            metamodels: Mutex::new(MetamodelService::new(PoolStore::new(conn()).unwrap())),
            models: Mutex::new(ModelStore::new(conn()).unwrap()),
            history: Mutex::new(history),
            history_writer,
            running: crate::history::RunningRegistry::default(),
            balances: Mutex::new(crate::storage::balances::BalanceStore::new(conn()).unwrap()),
            catalog_refresh: Mutex::new(std::collections::HashMap::new()),
            refresh_running: std::sync::atomic::AtomicBool::new(false),
            history_writes: std::sync::Arc::new(Mutex::new(None)),
            chat: crate::api::ChatTools::for_tests(),
            events: std::sync::Arc::new(
                crate::storage::events::EventStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            knowledge: std::sync::Arc::new(
                crate::storage::knowledge::KnowledgeStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            knowledge_cfg: None,
            research: Mutex::new(None),
        })
    }

    /// State whose `prov` connection is a ZAI driver pointed at a wiremock
    /// server, with static models `m-a` (priority) and `m-b` in pool `pool`.
    /// Retries are off: one 5xx answer moves the request to the next member.
    fn upstream_state(server_uri: &str) -> Arc<ApiState> {
        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let static_models = Vec::new();
        let provider = crate::config::ProviderConfig {
            provider_id: "prov".into(),
            driver: crate::config::DriverKind::Zai,
            base_url: server_uri.into(),
            api_key: Some("zai-key".into()),
            static_models,
        };
        let (history, history_writer) = crate::api::tests_support::history_pair("upstream");
        let st = Arc::new(ApiState {
            started_at_unix: 1_700_000_000,
            keys: KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "secret-one".into(),
            }]),
            providers: crate::provider::ProviderRegistry::build(
                &[provider],
                crate::config::HttpTimeouts::default(),
            )
            .unwrap(),
            router: Router::new(
                BanStore::new(conn()).unwrap(),
                crate::config::BanPolicy::default(),
                crate::config::RetryPolicy {
                    max_retries: 0,
                    base_delay: std::time::Duration::ZERO,
                },
            ),
            metamodels: Mutex::new(MetamodelService::new(PoolStore::new(conn()).unwrap())),
            models: Mutex::new(ModelStore::new(conn()).unwrap()),
            history: Mutex::new(history),
            history_writer,
            running: crate::history::RunningRegistry::default(),
            balances: Mutex::new(crate::storage::balances::BalanceStore::new(conn()).unwrap()),
            catalog_refresh: Mutex::new(std::collections::HashMap::new()),
            refresh_running: std::sync::atomic::AtomicBool::new(false),
            history_writes: std::sync::Arc::new(Mutex::new(None)),
            chat: crate::api::ChatTools::for_tests(),
            events: std::sync::Arc::new(
                crate::storage::events::EventStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            knowledge: std::sync::Arc::new(
                crate::storage::knowledge::KnowledgeStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            knowledge_cfg: None,
            research: Mutex::new(None),
        });
        let members = vec![
            ModelId::new(ProviderId::new("prov".to_string()), "m-a"),
            ModelId::new(ProviderId::new("prov".to_string()), "m-b"),
        ];
        st.metamodels
            .lock()
            .unwrap()
            .create(Metamodel::new(MetamodelId::new("pool"), members).unwrap())
            .unwrap();
        // A dynamic-catalog driver refuses static models; seed the catalog
        // store instead so both members count as selectable.
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![
                    crate::storage::catalog::NewModel {
                        upstream_id: "m-a".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                    crate::storage::catalog::NewModel {
                        upstream_id: "m-b".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                ],
            )
            .unwrap();
        st
    }

    /// One successful non-streaming-shaped SSE answer from the upstream.
    fn sse_ok() -> wiremock::ResponseTemplate {
        wiremock::ResponseTemplate::new(200)
            .insert_header("content-type", "text/event-stream")
            .set_body_string("data: {\"choices\":[]}\n\ndata: [DONE]\n\n")
    }

    #[tokio::test]
    async fn a_fallback_to_another_member_emits_model_switch() {
        let server = wiremock::MockServer::start().await;
        let st = upstream_state(&server.uri());
        // First call: the top member answers, the session pins to it.
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::body_partial_json(
                json!({"model": "m-a"}),
            ))
            .respond_with(sse_ok())
            .mount(&server)
            .await;
        let (status, body) = post_with_headers(
            &st,
            json!({"model": "pool", "stream": true, "messages": []}),
            &[("x-session-id", "conv-1")],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "first call: {body:?}");
        assert!(st.events.list(10).unwrap().is_empty(), "no event yet");

        // The pinned member starts failing; the conversation moves to m-b.
        server.reset().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::body_partial_json(
                json!({"model": "m-a"}),
            ))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::body_partial_json(
                json!({"model": "m-b"}),
            ))
            .respond_with(sse_ok())
            .mount(&server)
            .await;
        let (status, body) = post_with_headers(
            &st,
            json!({"model": "pool", "stream": true, "messages": []}),
            &[("x-session-id", "conv-1")],
        )
        .await;
        assert_eq!(status, StatusCode::OK, "second call: {body:?}");

        let events = st.events.list(10).unwrap();
        assert_eq!(events.len(), 1, "one switch, nothing else");
        assert_eq!(events[0].kind, "model_switch");
        let detail: serde_json::Value =
            serde_json::from_str(events[0].detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["pool"], "pool");
        assert_eq!(detail["from"], "prov/m-a");
        assert_eq!(detail["to"], "prov/m-b");
    }

    #[tokio::test]
    async fn an_upstream_400_tries_the_next_member_before_answering() {
        for (stream, next, expected) in [
            (true, sse_ok(), StatusCode::OK),
            (
                false,
                wiremock::ResponseTemplate::new(200).set_body_json(json!({
                    "choices": [{"message": {"role": "assistant", "content": "second answer"}}]
                })),
                StatusCode::OK,
            ),
            (
                false,
                wiremock::ResponseTemplate::new(400).set_body_string("second rejection"),
                StatusCode::BAD_REQUEST,
            ),
        ] {
            let server = wiremock::MockServer::start().await;
            let st = upstream_state(&server.uri());
            for (model, reply) in [
                (
                    "m-a",
                    wiremock::ResponseTemplate::new(400).set_body_string("first rejection"),
                ),
                ("m-b", next),
            ] {
                wiremock::Mock::given(wiremock::matchers::method("POST"))
                    .and(wiremock::matchers::body_partial_json(
                        json!({"model": model}),
                    ))
                    .respond_with(reply)
                    .expect(1)
                    .mount(&server)
                    .await;
            }
            let (status, body) = post(
                &st,
                json!({"model": "pool", "stream": stream, "messages": [{"role": "user", "content": "hi"}]}),
            )
            .await;
            assert_eq!(status, expected, "{body}");
            if !stream && status == StatusCode::OK {
                assert_eq!(body["choices"][0]["message"]["content"], "second answer");
            }
            if status == StatusCode::BAD_REQUEST {
                assert!(body.to_string().contains("second rejection"), "{body}");
            }
        }
    }

    #[tokio::test]
    async fn an_exhausted_pool_emits_all_models_failed() {
        let server = wiremock::MockServer::start().await;
        let st = upstream_state(&server.uri());
        for model in ["m-a", "m-b"] {
            wiremock::Mock::given(wiremock::matchers::method("POST"))
                .and(wiremock::matchers::body_partial_json(
                    json!({"model": model}),
                ))
                .respond_with(wiremock::ResponseTemplate::new(500))
                .mount(&server)
                .await;
        }
        let (status, _) = post(
            &st,
            json!({"model": "pool", "stream": true, "messages": []}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);

        let events = st.events.list(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "all_models_failed");
        let detail: serde_json::Value =
            serde_json::from_str(events[0].detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["metamodel"], "pool");
        assert_eq!(detail["members"], 2);

        // The failed attempts carry the router's own failure class and a
        // measured duration, not just the redacted message.
        // History is written by the background batcher: wait for the
        // record to land instead of reading immediately.
        let mut record = None;
        for _ in 0..300 {
            if let Ok(history) = st.history.lock()
                && let Ok(page) = history.list(&crate::storage::history::RequestFilter {
                    limit: 10,
                    ..Default::default()
                })
                && let Some(found) = page
                    .into_iter()
                    .find(|r| r.outcome.as_deref() == Some("error"))
            {
                record = Some(found);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let record = record.expect("history written");
        assert_eq!(record.outcome.as_deref(), Some("error"));
        assert_eq!(record.attempts.len(), 2);
        for attempt in &record.attempts {
            // A bare 500 carries no Z.AI marker: the driver keeps it
            // Unknown instead of inventing a cause.
            assert_eq!(attempt.error_class.as_deref(), Some("unknown"));
            assert!(attempt.duration_ms.unwrap_or(0) >= 0);
        }
    }

    fn create_metamodel(st: &ApiState, name: &str) {
        let model = ModelId::new(
            ProviderId::new("p".to_string()),
            "upstream-model".to_string(),
        );
        st.metamodels
            .lock()
            .unwrap()
            .create(Metamodel::new(MetamodelId::new(name), vec![model]).unwrap())
            .unwrap();
    }

    /// Serve this state on an ephemeral port and return the base URL.
    async fn serve(st: &Arc<ApiState>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = super::super::routes(Arc::clone(st));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{addr}")
    }

    async fn post(st: &Arc<ApiState>, body: Value) -> (StatusCode, serde_json::Value) {
        post_with_headers(st, body, &[]).await
    }

    async fn post_with_headers(
        st: &Arc<ApiState>,
        body: Value,
        extra_headers: &[(&str, &str)],
    ) -> (StatusCode, serde_json::Value) {
        let base = serve(st).await;
        let mut request = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .header("authorization", "Bearer secret-one")
            .json(&body);
        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }
        let response = request.send().await.unwrap();
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn a_missing_bearer_key_is_401() {
        let base = serve(&state()).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .json(&json!({"model": "m"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_unknown_secret_is_401_with_no_secret_in_the_body() {
        let st = state();
        let base = serve(&st).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .header("authorization", "Bearer wrong-secret")
            .json(&json!({"model": "m"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
        let body = response.text().await.unwrap();
        assert!(!body.contains("wrong-secret"));
    }

    #[tokio::test]
    async fn a_body_without_model_or_object_shape_is_400() {
        let st = state();
        let (status, body) = post(&st, json!({"messages": []})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("'model' field")
        );

        let (status, _) = post(&st, json!([1, 2])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn an_invalid_session_header_is_400_without_echoing_the_value() {
        let st = state();
        let (status, body) = post_with_headers(
            &st,
            json!({"model": "m", "messages": []}),
            &[("x-session-id", "not a valid id")],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!body.to_string().contains("not a valid id"));
    }

    #[tokio::test]
    async fn an_unknown_metamodel_is_404() {
        let st = state();
        let (status, body) = post(&st, json!({"model": "ghost", "messages": []})).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert!(body["error"]["message"].as_str().unwrap().contains("ghost"));
    }

    #[tokio::test]
    async fn a_metamodel_whose_provider_is_gone_is_503() {
        let st = state();
        create_metamodel(&st, "m");
        let (status, body) = post(&st, json!({"model": "m", "messages": []})).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("no model")
        );
    }

    /// One streamed call over a synthetic upstream: no network, no driver.
    fn stream_of(
        chunks: Vec<Result<Vec<u8>, DriverError>>,
    ) -> BoxStream<'static, Result<Vec<u8>, DriverError>> {
        futures_util::stream::iter(chunks).boxed()
    }

    /// One relayed call over a synthetic stream, as the handler starts it:
    /// a running view plus the summary base the writer will persist.
    fn relay_call(
        st: &Arc<ApiState>,
        id: &str,
        chunks: Vec<Result<Vec<u8>, DriverError>>,
    ) -> std::pin::Pin<
        Box<impl futures_util::Stream<Item = Result<axum::body::Bytes, std::convert::Infallible>>>,
    > {
        let record = StreamRecord {
            state: Arc::clone(st),
            base: SummaryBase {
                id: id.into(),
                key_alias: "test".into(),
                metamodel: "m".into(),
                started_at_unix: 1_000,
                input: None,
                declared_tools: None,
                issues: Vec::new(),
            },
            closed: Vec::new(),
            observer: StreamObserver::new(),
            started_at_unix: 1_000,
            started_at: std::time::Instant::now(),
            provider_id: "openrouter".into(),
            upstream_id: "m".into(),
            finished: false,
            error: None,
        };
        Box::pin(relay(stream_of(chunks), record))
    }

    /// The persisted outcome once the writer caught up: None means the
    /// record never landed, which is the actual failure.
    fn outcome_of_call(st: &Arc<ApiState>, id: &str) -> Option<String> {
        crate::api::tests_support::wait_history(st, id).and_then(|record| record.outcome)
    }

    /// The one call in the log, once the writer caught up with it.
    fn the_call(st: &Arc<ApiState>) -> crate::storage::history::StoredHistoryRequest {
        for _ in 0..300 {
            if let Ok(history) = st.history.lock()
                && let Ok(page) = history.list(&crate::storage::history::RequestFilter {
                    limit: 10,
                    ..Default::default()
                })
                && let Some(found) = page.into_iter().next()
            {
                return found;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("the call never reached the log");
    }

    #[tokio::test]
    async fn a_client_that_hangs_up_before_the_first_byte_is_not_left_running() {
        let server = wiremock::MockServer::start().await;
        let st = upstream_state(&server.uri());
        // The upstream holds its answer back for longer than the client waits.
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_delay(std::time::Duration::from_secs(30)),
            )
            .mount(&server)
            .await;
        let base = serve(&st).await;
        let impatient = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(400))
            .build()
            .unwrap();
        let given_up = impatient
            .post(format!("{base}/v1/chat/completions"))
            .header("authorization", "Bearer secret-one")
            .json(&json!({"model": "pool", "messages": [{"role": "user", "content": "hello"}]}))
            .send()
            .await;
        assert!(given_up.is_err(), "the client has given up");

        for _ in 0..300 {
            if st.running.snapshot().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(
            st.running.snapshot().is_empty(),
            "a call whose client hung up is still listed as running"
        );
        // It is recorded like a hang-up mid-answer, with the attempt it was on.
        let record = the_call(&st);
        assert_eq!(record.outcome.as_deref(), Some("client_cancel"));
        assert_eq!(record.attempts.len(), 1);
        assert_eq!(record.attempts[0].result.as_deref(), Some("client_cancel"));
        assert_eq!(record.attempts[0].upstream_id, "m-a");
    }

    #[tokio::test]
    async fn a_stream_read_to_its_end_records_ok() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s1",
            vec![
                Ok(b"data: {\"choices\":[]}\n\n".to_vec()),
                Ok(b"data: [DONE]\n\n".to_vec()),
            ],
        );
        while relayed.next().await.is_some() {}
        let record = crate::api::tests_support::wait_history(&st, "s1").expect("record written");
        assert_eq!(record.outcome.as_deref(), Some("ok"));
        assert_eq!(record.attempts.len(), 1);
        assert_eq!(record.attempts[0].result.as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn a_client_that_hangs_up_after_the_answer_is_not_left_running() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s2",
            vec![
                Ok(b"data: [DONE]\n\n".to_vec()),
                // Never polled: the client is already gone.
                Ok(b"data: trailing\n\n".to_vec()),
            ],
        );
        assert!(relayed.next().await.is_some());
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s2").as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn a_client_that_hangs_up_mid_answer_records_client_cancel() {
        let st = state();
        let mut relayed = relay_call(&st, "s3", vec![Ok(b"data: {\"choices\":[]}\n\n".to_vec())]);
        assert!(relayed.next().await.is_some());
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s3").as_deref(), Some("client_cancel"));
    }

    #[tokio::test]
    async fn an_answer_marker_split_across_chunks_still_finishes_the_call() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s4",
            vec![Ok(b"data: [DO".to_vec()), Ok(b"NE]\n\n".to_vec())],
        );
        assert!(relayed.next().await.is_some());
        assert!(relayed.next().await.is_some());
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s4").as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn an_anthropic_style_stop_marker_finishes_the_call() {
        let st = state();
        let mut relayed = relay_call(&st, "s5", vec![Ok(b"event: message_stop\n\n".to_vec())]);
        assert!(relayed.next().await.is_some());
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s5").as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn marker_text_inside_an_answer_does_not_finish_the_call() {
        let st = state();
        let mut relayed = relay_call(&st, "s9", vec![Ok(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"the marker is [DONE], not the end\"}}]}\n\nevent: within_text_message_stop_like\n\n"
                .to_vec(),
        )]);
        assert!(relayed.next().await.is_some());
        // The hang-up is what ends the call: the marker inside the answer
        // text must not have finalized it as ok.
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s9").as_deref(), Some("client_cancel"));
    }
    #[tokio::test]
    async fn a_marker_split_over_three_chunks_still_finishes_the_call() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s10",
            vec![
                Ok(b"data: [D".to_vec()),
                Ok(b"O".to_vec()),
                Ok(b"NE]\n\n".to_vec()),
            ],
        );
        assert!(relayed.next().await.is_some());
        assert!(relayed.next().await.is_some());
        assert!(relayed.next().await.is_some());
        drop(relayed);
        assert_eq!(outcome_of_call(&st, "s10").as_deref(), Some("ok"));
    }
    #[tokio::test]
    async fn a_cancel_without_usage_rewrites_the_attempt() {
        let st = state();
        let mut relayed = relay_call(&st, "s11", vec![Ok(b"data: {\"choices\":[]}\n\n".to_vec())]);
        assert!(relayed.next().await.is_some());
        drop(relayed);
        let record = crate::api::tests_support::wait_history(&st, "s11").expect("record written");
        // The request was cut short: the attempt mirrors the cancel so
        // reliability statistics keep it out of clean successes.
        assert_eq!(record.outcome.as_deref(), Some("client_cancel"));
        assert_eq!(record.attempts[0].result.as_deref(), Some("client_cancel"));
        assert_eq!(record.attempts[0].input_tokens, None);
    }
    #[tokio::test]
    async fn an_upstream_failure_mid_stream_records_error() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s6",
            vec![
                Ok(b"data: {\"choices\":[]}\n\n".to_vec()),
                Err(DriverError {
                    class: crate::routing::classify::FailureClass::Transient,
                    message: "upstream went away".into(),
                }),
            ],
        );
        while relayed.next().await.is_some() {}
        let record = crate::api::tests_support::wait_history(&st, "s6").expect("record written");
        assert_eq!(record.outcome.as_deref(), Some("error"));
        assert_eq!(record.attempts[0].result.as_deref(), Some("error"));
    }

    #[tokio::test]
    async fn a_stream_that_reports_usage_reaches_the_spend_aggregate() {
        let st = state();
        let mut relayed = relay_call(&st, "s7", vec![
            Ok(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n".to_vec()),
            Ok(
                b"data: {\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":22,\"cost\":0.003}}\n\n"
                    .to_vec(),
            ),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
        while relayed.next().await.is_some() {}
        let record = crate::api::tests_support::wait_history(&st, "s7").expect("record written");
        assert_eq!(record.attempts.len(), 1);
        assert_eq!(record.attempts[0].result.as_deref(), Some("ok"));
        assert_eq!(record.attempts[0].input_tokens, Some(11));
        assert_eq!(record.attempts[0].output_tokens, Some(22));
        // The aggregate reads the same row: cost is the upstream's own number.
        let page = st
            .history
            .lock()
            .unwrap()
            .usage_buckets(&crate::storage::history::UsageQuery {
                filter: Default::default(),
                bucket_seconds: 3_600,
                group_by: crate::storage::history::UsageGroup::Provider,
                limit: 100,
            })
            .unwrap();
        assert_eq!(page.buckets.len(), 1);
        assert_eq!(page.buckets[0].stats.cost, Some(0.003));
        assert_eq!(page.buckets[0].stats.cost_reports, 1);
        assert_eq!(page.buckets[0].stats.input_tokens, Some(11));
    }

    #[tokio::test]
    async fn a_hang_up_after_the_usage_chunk_keeps_the_reported_amounts() {
        let st = state();
        let mut relayed = relay_call(
            &st,
            "s8",
            vec![Ok(
                b"data: {\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":5}}\n\n".to_vec(),
            )],
        );
        assert!(relayed.next().await.is_some());
        drop(relayed);
        let record = crate::api::tests_support::wait_history(&st, "s8").expect("record written");
        assert_eq!(record.outcome.as_deref(), Some("client_cancel"));
        assert_eq!(record.attempts[0].input_tokens, Some(4));
        assert_eq!(record.attempts[0].output_tokens, Some(5));
        // No cost was reported, so the aggregate keeps it unknown.
        assert_eq!(record.attempts[0].cost, None);
    }
}
