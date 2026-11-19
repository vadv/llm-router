// Management API: pools, catalog, observations, history.
// The same client keys as inference serve; all keys are equal. Handlers are
// transport and parsing only — pool semantics live in MetamodelService,
// storage in the SQLite adapters.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use crate::api::{ApiState, api_error, bearer_secret};
use crate::metamodel::{Metamodel, MetamodelId};
use crate::model::{ModelId, ProviderId};
use crate::storage::events::event_kind;

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn ok_json(value: serde_json::Value) -> Response {
    Json(value).into_response()
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn bad_request(message: &str) -> Response {
    error(StatusCode::BAD_REQUEST, message)
}

fn not_found(message: &str) -> Response {
    error(StatusCode::NOT_FOUND, message)
}

fn internal(message: &str) -> Response {
    error(StatusCode::INTERNAL_SERVER_ERROR, message)
}

/// Authorization shared by every management handler: any configured client
/// key works, all keys are equal. Some response = reject with it.
pub(crate) fn authorize(state: &ApiState, headers: &HeaderMap) -> Option<Response> {
    match bearer_secret(headers).and_then(|secret| state.keys.authenticate(&secret)) {
        Some(_) => None,
        None => Some(api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "missing or invalid API key",
        )),
    }
}

/// List pools with their ordered members.
pub async fn list_pools(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let pools = {
        let metamodels = state.metamodels.lock().unwrap();
        match metamodels.list() {
            Ok(pools) => pools,
            Err(e) => return internal(&e.0),
        }
    };
    // Derived context is the minimum of member windows; read the live catalog
    // under its own short lock.
    let contexts = {
        let models = state.models.lock().unwrap();
        pools
            .iter()
            .map(|pool| pool.context_tokens(&*models))
            .collect::<Result<Vec<_>, _>>()
    };
    let contexts = match contexts {
        Ok(c) => c,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "pools": pools
            .iter()
            .zip(contexts)
            .map(|(pool, context)| pool_json(pool, context))
            .collect::<Vec<_>>()
    }))
}

/// Read one pool.
pub async fn get_pool(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let pool = {
        let metamodels = state.metamodels.lock().unwrap();
        match metamodels.get(&MetamodelId::new(name)) {
            Ok(pool) => pool,
            Err(e) => return internal(&e.0),
        }
    };
    match pool {
        None => not_found("no such pool"),
        Some(pool) => {
            let context = {
                let models = state.models.lock().unwrap();
                pool.context_tokens(&*models)
            };
            match context {
                Ok(context) => ok_json(pool_json(&pool, context)),
                Err(e) => internal(&e.0),
            }
        }
    }
}

fn pool_json(pool: &Metamodel, context_tokens: Option<u64>) -> serde_json::Value {
    json!({
        "name": pool.id().as_str(),
        "members": pool.members().iter().map(member_json).collect::<Vec<_>>(),
        "context_tokens": context_tokens,
    })
}

fn member_json(member: &ModelId) -> serde_json::Value {
    json!({
        "provider_id": member.provider().as_str(),
        "upstream_id": member.upstream(),
    })
}

#[derive(Deserialize)]
pub struct PoolBody {
    pub members: Vec<MemberBody>,
}

#[derive(Deserialize)]
pub struct MemberBody {
    provider_id: String,
    upstream_id: String,
}

/// Active bans only: expired rows stay in the store for the scheduler
/// sweep, but listing them to the UI would say "banned" about models the
/// router already routes again. No manual unban by design: a ban ends
/// when its term does.
pub async fn list_bans(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let now = now_unix();
    let bans = match state.router.bans().all_bans() {
        Ok(bans) => bans,
        Err(e) => return internal(&e.0),
    };
    let bans: Vec<serde_json::Value> = bans
        .iter()
        .filter(|ban| ban.expires_at_unix > now)
        .map(|ban| {
            json!({
                "provider_id": ban.provider_id,
                "upstream_id": ban.upstream_id,
                "reason": ban.reason,
                "expires_at_unix": ban.expires_at_unix,
            })
        })
        .collect();
    ok_json(json!({ "bans": bans }))
}

#[derive(Deserialize, Default)]
pub struct RefreshBody {
    what: Option<String>,
}

/// Trigger a refresh pass now instead of waiting for the next schedule
/// tick. A pass already in flight is neither joined nor duplicated: the
/// caller gets 202 with the current status again. The pass runs in the
/// background; errors surface in the status and the event log, not in
/// this response.
pub async fn post_refresh(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    body: Option<Json<RefreshBody>>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let what = body
        .and_then(|Json(body)| body.what)
        .unwrap_or_else(|| "all".into());
    if !matches!(what.as_str(), "all" | "catalog" | "balances") {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_what",
            "what must be one of: all, catalog, balances",
        );
    }
    // swap returns the previous value: false means no pass was running
    // and this call starts one; true means keep the existing pass.
    if !state
        .refresh_running
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        let state = Arc::clone(&state);
        let what = what.to_string();
        tokio::spawn(async move {
            if what != "balances" {
                crate::schedule::refresh_catalogs(&state).await;
            }
            if what != "catalog" {
                crate::schedule::refresh_observations(&state).await;
            }
            state
                .refresh_running
                .store(false, std::sync::atomic::Ordering::SeqCst);
        });
    }
    let refresh = state.catalog_refresh.lock().unwrap().clone();
    let statuses: serde_json::Value = refresh
        .iter()
        .map(|(id, status)| (id.as_str().to_string(), refresh_json(status)))
        .collect();
    (StatusCode::ACCEPTED, Json(json!({ "refresh": statuses }))).into_response()
}

/// Create a pool, or replace the members of an existing one. The member
/// order is the user's priority order; the catalog does not have to know
/// the models yet.
pub async fn put_pool(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Json(body): Json<PoolBody>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    // The pool name doubles as the client-facing `model`, so its shape is
    // part of the contract, not a free-form label.
    if !valid_pool_name(&name) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_name",
            "pool name must be 1-64 chars of a-z, 0-9, '-', '_', '.'",
        );
    }
    if body.members.is_empty() {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_pool",
            "a pool needs at least one member",
        );
    }
    let members = match parse_members(&state, &body.members) {
        Ok(members) => members,
        Err(reject) => return *reject,
    };
    let mut metamodels = state.metamodels.lock().unwrap();
    let existing = match metamodels.get(&MetamodelId::new(name.clone())) {
        Ok(existing) => existing,
        Err(e) => return internal(&e.0),
    };
    if existing.is_some()
        && headers
            .get("if-none-match")
            .is_some_and(|value| value == "*")
    {
        return error(
            StatusCode::PRECONDITION_FAILED,
            "a pool with this name already exists",
        );
    }
    match existing {
        None => {
            let metamodel = match Metamodel::new(MetamodelId::new(name), members) {
                Ok(metamodel) => metamodel,
                Err(e) => return bad_request(&format!("duplicate member {}", e.0.upstream())),
            };
            match metamodels.create(metamodel) {
                Ok(()) => StatusCode::CREATED.into_response(),
                Err(e) if e.0.contains("already exists") => {
                    error(StatusCode::CONFLICT, "a pool with this name already exists")
                }
                Err(e) => internal(&e.0),
            }
        }
        Some(_) => match metamodels.replace_members(&MetamodelId::new(name), members) {
            Ok(()) => StatusCode::OK.into_response(),
            Err(e) => internal(&e.0),
        },
    }
}

/// A pool name reaches clients as the `model` they send, so it must be
/// plain lowercase tokens, not an arbitrary label.
fn valid_pool_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.')
        })
}

/// Members reference configured connections; a typo in `provider_id`
/// or `upstream_id` would otherwise silently never resolve. Err = the
/// rejection response. When a dynamic provider's catalog has not arrived
/// yet the member passes: the model may appear on the next refresh.
fn parse_members(
    state: &Arc<ApiState>,
    body: &[MemberBody],
) -> Result<Vec<ModelId>, Box<Response>> {
    body.iter()
        .map(|m| {
            let provider = ProviderId::new(m.provider_id.clone());
            let Some(provider_conn) = state.providers.get(&provider) else {
                return Err(Box::new(bad_request(&format!(
                    "unknown provider '{}'",
                    m.provider_id
                ))));
            };
            let known = if !provider_conn.static_models().is_empty() {
                provider_conn
                    .static_models()
                    .iter()
                    .any(|s| s.upstream_id == m.upstream_id)
            } else {
                match state.models.lock() {
                    Ok(models) => match models.list(&m.provider_id) {
                        // An empty snapshot means "no catalog yet": skip.
                        Ok(snapshot) => {
                            snapshot.is_empty()
                                || snapshot.iter().any(|s| s.upstream_id == m.upstream_id)
                        }
                        // A catalog read failure must not reject the pool.
                        Err(_) => true,
                    },
                    Err(_) => true,
                }
            };
            if !known {
                return Err(Box::new(api_error(
                    StatusCode::BAD_REQUEST,
                    "unknown_model",
                    &format!("unknown model '{}' of '{}'", m.upstream_id, m.provider_id),
                )));
            }
            Ok(ModelId::new(provider, m.upstream_id.clone()))
        })
        .collect()
}

/// Remove a pool. Missing is already gone: the outcome is the same.
pub async fn delete_pool(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let result = state
        .metamodels
        .lock()
        .unwrap()
        .delete(&MetamodelId::new(name));
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(&e.0),
    }
}

/// Connections with their catalog source and last refresh outcome.
/// GET /v1/management/models — the full live catalog, every upstream
/// model of every provider with its knowledge key, so the dashboard can
/// group the same model behind different providers and aliases.
pub async fn list_catalog(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let models = match state.models.lock() {
        Ok(store) => store.list_all(),
        Err(_) => return internal("catalog storage is unavailable"),
    };
    let models = match models {
        Ok(m) => m,
        Err(e) => return internal(&e.0),
    };
    let models: Vec<serde_json::Value> = models
        .into_iter()
        .map(|m| {
            json!({
                "provider_id": m.provider_id,
                "upstream_id": m.upstream_id,
                "context_tokens": m.context_tokens,
                "knowledge_key": crate::model::knowledge_key(&m.upstream_id),
                "observed_at_unix": m.observed_at_unix,
            })
        })
        .collect();
    ok_json(json!({ "models": models }))
}

pub async fn list_providers(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let refresh = state.catalog_refresh.lock().unwrap().clone();
    let providers: Vec<serde_json::Value> = state
        .providers
        .connections()
        .into_iter()
        .map(|(id, provider)| {
            json!({
                "provider_id": id.as_str(),
                "reported_cost_unit": provider.reported_cost_unit(),
                "catalog": "dynamic",
                "last_refresh": refresh.get(&id).map(refresh_json),
                // Local engines only: the last reported state, unknown
                // fields as null. Absent means nothing collected yet.
                "local_state": state.providers.local_state(&id).map(local_state_json),
            })
        })
        .collect();
    ok_json(json!({ "providers": providers }))
}

fn local_state_json(state: crate::provider::driver::LocalState) -> serde_json::Value {
    json!({
        "model": state.model,
        "loaded": state.loaded,
        "slots": state.slots,
        "busy": state.busy,
    })
}

fn refresh_json(status: &crate::schedule::RefreshStatus) -> serde_json::Value {
    json!({
        "last_success_unix": status.last_success_unix,
        "last_error": status.last_error,
    })
}

/// One connection's current catalog snapshot.
pub async fn get_provider_models(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Path(provider_id): Path<String>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let id = ProviderId::new(provider_id.clone());
    if state.providers.get(&id).is_none() {
        return not_found("no such provider");
    }
    let models = match state.models.lock().unwrap().list(&provider_id) {
        Ok(models) => models,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "models": models.iter().map(|m| json!({
            "upstream_id": m.upstream_id,
            "context_tokens": m.context_tokens,
            "observed_at_unix": m.observed_at_unix,
        })).collect::<Vec<_>>()
    }))
}

#[derive(Deserialize)]
pub struct ObservationQuery {
    provider_id: Option<String>,
    resource: Option<String>,
    metric: Option<String>,
    window: Option<String>,
    unit: Option<String>,
    since_unix: Option<String>,
    limit: Option<String>,
}

/// The latest observation of each indicator of every connection, or of
/// one connection with `provider_id`. An empty list means nothing
/// observed yet, not a zero balance. With `since_unix`, `limit`, `resource`,
/// `metric` or `window` present the answer becomes a timeline (then
/// `provider_id` is required): points oldest-first, bounded by `limit`
/// (default 200, max 500). `resource`, `metric`, `window` and `unit` select
/// one series before the limit cuts it; an empty `window` or `unit` selects
/// the series that report no window or no unit.
pub async fn latest_observations(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<ObservationQuery>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let series_selected = params.resource.is_some()
        || params.metric.is_some()
        || params.window.is_some()
        || params.unit.is_some();
    let history_mode = params.since_unix.is_some() || params.limit.is_some() || series_selected;
    if !history_mode {
        // An empty `?provider_id=` means the same as no parameter.
        let provider = params
            .provider_id
            .as_deref()
            .filter(|value| !value.is_empty());
        let observations = match state.balances.lock().unwrap().latest(provider) {
            Ok(observations) => observations,
            Err(e) => return internal(&e.0),
        };
        return ok_json(json!({
            "observations": observations.iter().map(observation_json).collect::<Vec<_>>()
        }));
    }
    let Some(provider) = params
        .provider_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "history mode requires provider_id",
        );
    };
    let parse = |value: Option<&str>, name: &str| -> Result<Option<i64>, String> {
        match value {
            None | Some("") => Ok(None),
            Some(text) => text
                .parse::<i64>()
                .map(Some)
                .map_err(|_| format!("{name} must be an integer")),
        }
    };
    let since_unix = match parse(params.since_unix.as_deref(), "since_unix") {
        Ok(value) => value,
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "invalid_query", &msg),
    };
    let limit = match parse(params.limit.as_deref(), "limit") {
        Ok(None) => 200,
        Ok(Some(limit)) => limit.clamp(1, 500),
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "invalid_query", &msg),
    };
    // An empty resource or metric means the same as no parameter; an empty
    // window or unit is meaningful and selects the series without one.
    let series_value = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let resource = series_value(&params.resource);
    let metric = series_value(&params.metric);
    let filter = crate::storage::balances::HistoryFilter {
        provider_id: Some(provider),
        resource: resource.as_deref(),
        metric: metric.as_deref(),
        window: params.window.as_deref(),
        unit: params.unit.as_deref(),
        since_unix,
        to_unix: None,
    };
    let observations = match state.balances.lock().unwrap().history(&filter, limit) {
        Ok(observations) => observations,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "observations": observations.iter().map(observation_json).collect::<Vec<_>>()
    }))
}

fn observation_json(o: &crate::storage::balances::Observation) -> serde_json::Value {
    json!({
        "provider_id": o.provider_id,
        "resource": o.resource,
        "metric": o.metric,
        "unit": o.unit,
        "limit": o.limit,
        "usage": o.usage,
        "remaining": o.remaining,
        "window": o.window,
        "resets_at_unix": o.resets_at_unix,
        "observed_at_unix": o.observed_at_unix,
    })
}

/// History query parameters. Parsed manually so that invalid values
/// answer `400 invalid_query` instead of axum's generic deserialization
/// error, and an empty string means "any".
#[derive(Deserialize)]
pub struct HistoryQuery {
    limit: Option<String>,
    before_id: Option<String>,
    since_unix: Option<String>,
    to_unix: Option<String>,
    #[serde(flatten)]
    selection: HistorySelection,
}

#[derive(Deserialize)]
pub struct HistorySelection {
    family: Option<String>,
    attempt_window: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    metamodel: Option<String>,
    key_alias: Option<String>,
    outcome: Option<String>,
}

impl HistorySelection {
    fn filter(self) -> crate::storage::history::RequestFilter {
        let present = |v: Option<String>| v.filter(|s| !s.is_empty());
        crate::storage::history::RequestFilter {
            provider: present(self.provider),
            family: present(self.family),
            attempt_window: self.attempt_window.as_deref() == Some("1"),
            model: present(self.model),
            metamodel: present(self.metamodel),
            key_alias: present(self.key_alias),
            outcome: present(self.outcome),
            ..Default::default()
        }
    }
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    period: Option<String>,
    since_unix: Option<String>,
    to_unix: Option<String>,
    #[serde(flatten)]
    selection: HistorySelection,
}

pub async fn request_activity(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<ActivityQuery>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let (span, step) = match params.period.as_deref().unwrap_or("24h") {
        "1h" => (Some(3600), Some(60)),
        "24h" => (Some(86400), Some(900)),
        "7d" => (Some(7 * 86400), Some(3600)),
        "all" => (None, None),
        _ => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "invalid_query",
                "unknown activity period",
            );
        }
    };
    let now = now_unix();
    let mut filter = params.selection.filter();
    let step = if params.since_unix.is_some() || params.to_unix.is_some() {
        let bound = |s: Option<String>| {
            s?.parse::<i64>()
                .ok()
                .filter(|n| (0..=253_402_300_799).contains(n))
        };
        match (bound(params.since_unix), bound(params.to_unix)) {
            (Some(from), Some(to))
                if from < to && params.period.is_none() && !filter.attempt_window =>
            {
                filter.since_unix = Some(from);
                filter.to_unix = Some(to);
                Some(crate::storage::history::activity_step(to - from))
            }
            _ => {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_query",
                    "use a period or an ordered pair of request start times",
                );
            }
        }
    } else {
        filter.since_unix = span.map(|s: i64| now + 1 - s);
        filter.to_unix = Some(now + 1);
        step
    };
    match state
        .history
        .lock()
        .unwrap()
        .request_activity(&filter, step, now)
    {
        Ok(activity) => ok_json(json!(activity)),
        Err(_) => internal("could not read request activity"),
    }
}

/// Recent inference history with per-attempt outcomes. `limit` defaults to
/// 50 and is capped, so a client cannot ask the proxy to serialize the
/// whole database in one response. `before_id` pages with a stable cursor;
/// `since_unix`, `metamodel`, `key_alias` and `outcome` filter exact
/// matches.
pub async fn list_requests(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<HistoryQuery>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let parse = |value: Option<&str>, name: &str| -> Result<Option<i64>, String> {
        match value {
            None | Some("") => Ok(None),
            Some(text) => text
                .parse::<i64>()
                .map(Some)
                .map_err(|_| format!("{name} must be an integer")),
        }
    };
    let limit = match parse(params.limit.as_deref(), "limit") {
        Ok(None) => 50,
        Ok(Some(limit)) => limit.clamp(1, 500),
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "invalid_query", &msg),
    };
    let since_unix = match parse(params.since_unix.as_deref(), "since_unix") {
        Ok(value) => value,
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "invalid_query", &msg),
    };
    let to_unix = match parse(params.to_unix.as_deref(), "to_unix") {
        Ok(value) => value,
        Err(msg) => return api_error(StatusCode::BAD_REQUEST, "invalid_query", &msg),
    };
    if since_unix.zip(to_unix).is_some_and(|(a, b)| a >= b) {
        return api_error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "time window must have a positive length",
        );
    }
    let filter = crate::storage::history::RequestFilter {
        limit,
        before_id: params.before_id.filter(|s| !s.is_empty()),
        since_unix,
        to_unix,
        ..params.selection.filter()
    };
    let records = match state.history.lock().unwrap().list(&filter) {
        Ok(records) => records,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "requests": records.iter().map(request_json).collect::<Vec<_>>()
    }))
}

fn request_json(record: &crate::storage::history::StoredHistoryRequest) -> serde_json::Value {
    json!({
        "id": record.id,
        "metamodel": record.metamodel,
        "key_alias": record.key_alias,
        "started_at_unix": record.started_at_unix,
        "finished_at_unix": record.finished_at_unix,
        "outcome": record.outcome,
        "input_preview": record.input_preview,
        "input_truncated": record.input_truncated,
        "declared_tools": record.declared_tools,
        "issues": record.issues,
        "attempts": record.attempts.iter().map(|a| json!({
            "provider_id": a.provider_id,
            "upstream_id": a.upstream_id,
            "started_at_unix": a.started_at_unix,
            "finished_at_unix": a.finished_at_unix,
            "result": a.result,
            "error": a.error,
            "error_class": a.error_class,
            "duration_ms": a.duration_ms,
            "switch_reason": a.switch_reason,
            "input_tokens": a.input_tokens,
            "output_tokens": a.output_tokens,
            "cost": a.cost,
            "response_preview": a.response_preview,
            "response_truncated": a.response_truncated,
            "tool_count": a.tool_count,
            "tool_names": a.tool_names,
            "tool_names_truncated": a.tool_names_truncated,
            "tool_list_truncated": a.tool_list_truncated,
            "issues": a.issues,
        })).collect::<Vec<_>>(),
    })
}

/// Requests being served right now: a RAM view, nothing from SQLite.
pub async fn list_running(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let running = state.running.snapshot();
    ok_json(json!({
        "running": running.iter().map(|r| json!({
            "id": r.id,
            "key_alias": r.key_alias,
            "metamodel": r.metamodel,
            "started_at_unix": r.started_at_unix,
            "attempts": r.attempts.iter().map(|a| json!({
                "provider_id": a.provider_id,
                "upstream_id": a.upstream_id,
                "started_at_unix": a.started_at_unix,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    }))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    limit: Option<u32>,
}

/// Usage query parameters. Parsed manually, like history, so a bad value
/// answers `400 invalid_query` and an empty string means the default.
#[derive(Deserialize)]
pub struct UsageQueryParams {
    family: Option<String>,
    split_provider: Option<String>,
    since_unix: Option<String>,
    to_unix: Option<String>,
    model: Option<String>,
    key: Option<String>,
    pool: Option<String>,
    bucket: Option<String>,
    group_by: Option<String>,
    limit: Option<String>,
    provider: Option<String>,
}

impl UsageQueryParams {
    fn bounds(&self) -> Result<(Option<i64>, Option<i64>), &'static str> {
        let parse = |s: &Option<String>| {
            s.as_deref()
                .filter(|s| !s.is_empty())
                .map(str::parse::<i64>)
                .transpose()
        };
        let since = parse(&self.since_unix).map_err(|_| "since_unix must be an integer")?;
        let to = parse(&self.to_unix).map_err(|_| "to_unix must be an integer")?;
        if matches!((since, to), (Some(a), Some(b)) if a >= b) {
            return Err("to_unix must be after since_unix");
        }
        Ok((since, to))
    }
}

/// The spend reference stays provider-wide when a user filters a report.
pub async fn usage_spend(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<UsageQueryParams>,
) -> Response {
    use crate::history::spend::calibrate;
    use crate::storage::balances::HistoryFilter;

    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let bad = |msg: &str| api_error(StatusCode::BAD_REQUEST, "invalid_query", msg);
    let provider = params
        .provider
        .as_deref()
        .filter(|text| !text.is_empty())
        .map(str::to_owned);
    let (since_unix, to_unix) = match params.bounds() {
        Ok(bounds) => bounds,
        Err(message) => return bad(message),
    };
    let observations = state.balances.lock().unwrap().history(
        &HistoryFilter {
            provider_id: provider.as_deref(),
            since_unix,
            to_unix,
            ..Default::default()
        },
        10_001,
    );
    let observations = match observations {
        Ok(rows) => rows,
        Err(e) => return internal(&e.0),
    };

    // One series = provider/resource/metric/unit/window; group the
    // time-ordered rows into series (a stable sort keeps readings in
    // chronological order inside each) and calibrate each against the
    // tokens its provider burned between the same readings.
    let mut observations = observations;
    let truncated = observations.len() > 10_000;
    if truncated {
        observations.remove(0);
    }
    observations.sort_by(|a, b| {
        (&a.provider_id, &a.resource, &a.metric, &a.unit, &a.window).cmp(&(
            &b.provider_id,
            &b.resource,
            &b.metric,
            &b.unit,
            &b.window,
        ))
    });
    let mut series: Vec<Vec<crate::storage::balances::Observation>> = Vec::new();
    for observation in observations {
        let same_series = |a: &crate::storage::balances::Observation,
                           b: &crate::storage::balances::Observation| {
            a.provider_id == b.provider_id
                && a.resource == b.resource
                && a.metric == b.metric
                && a.unit == b.unit
                && a.window == b.window
        };
        match series.last_mut() {
            Some(last) if same_series(&last[0], &observation) => last.push(observation),
            _ => series.push(vec![observation]),
        }
    }
    let history = state.history.lock().unwrap();
    // Calibrate every series once; a storage failure must not read as
    // free tokens, so an unreadable interval joins no calibration
    // (spec §7.3).
    // Quota series sampled together share the same token count.
    let mut token_cache = std::collections::HashMap::new();
    let calibrated: Vec<(
        &Vec<crate::storage::balances::Observation>,
        crate::history::spend::SpendEstimate,
    )> = series
        .iter()
        .map(|rows| {
            (
                rows,
                calibrate(rows, |provider, from, to| {
                    *token_cache
                        .entry((rows[0].provider_id.as_str(), from, to))
                        .or_insert_with(|| history.tokens_between(provider, from, to).ok())
                }),
            )
        })
        .collect();
    drop(history);
    // Prefer a usable balance to a quota. Keep the first series on a tie.
    let mut primary = std::collections::HashMap::new();
    for (index, (rows, estimate)) in calibrated.iter().enumerate() {
        let score = (
            estimate.per_1000.is_some(),
            matches!(rows[0].metric.as_str(), "money" | "credits"),
            estimate.intervals,
        );
        primary
            .entry(rows[0].provider_id.as_str())
            .and_modify(|best: &mut (_, _)| {
                if score > best.0 {
                    *best = (score, index);
                }
            })
            .or_insert((score, index));
    }
    let reports: Vec<serde_json::Value> = calibrated
        .iter()
        .enumerate()
        .map(|(index, (rows, estimate))| {
            let is_primary = primary[rows[0].provider_id.as_str()].1 == index;
            json!({
                "provider": rows[0].provider_id,
                "resource": rows[0].resource,
                "metric": rows[0].metric,
                "unit": rows[0].unit,
                "window": rows[0].window,
                "observations": rows.len(),
                "first_observed_unix": rows[0].observed_at_unix,
                "last_observed_unix": rows[rows.len() - 1].observed_at_unix,
                "intervals": estimate.intervals,
                "spent": estimate.spent,
                "tokens": estimate.tokens,
                "per_1000": if is_primary { estimate.per_1000 } else { None },
                "primary_series": is_primary,
                "method": "k = spent / tokens over observation intervals; tokens counted per attempt finish time (usage buckets count by attempt start); assumes all account spend passed through this proxy",
            })
        })
        .collect();
    ok_json(json!({ "series": reports, "truncated": truncated }))
}

pub async fn usage_buckets(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<UsageQueryParams>,
) -> Response {
    use crate::storage::history::{UsageGroup, UsageQuery};

    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let bad = |msg: &str| api_error(StatusCode::BAD_REQUEST, "invalid_query", msg);
    let text = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .unwrap_or("")
            .to_owned()
    };
    let (since_unix, to_unix) = match params.bounds() {
        Ok(bounds) => bounds,
        Err(message) => return bad(message),
    };
    let bucket_seconds = match text(&params.bucket).as_str() {
        "" | "hour" => 3_600,
        "minute" => 60,
        "day" => 86_400,
        _ => return bad("bucket must be minute, hour or day"),
    };
    let group_by = match text(&params.group_by).as_str() {
        "" | "provider" => UsageGroup::Provider,
        "model" => UsageGroup::Model,
        "family" => UsageGroup::Family,
        "metamodel" => UsageGroup::Metamodel,
        "key" => UsageGroup::Key,
        _ => return bad("group_by must be provider, model, family, metamodel or key"),
    };
    let limit = match text(&params.limit).as_str() {
        "" => 500,
        value => match value.parse::<i64>() {
            Ok(limit) => limit.clamp(1, 2_000),
            Err(_) => return bad("limit must be an integer"),
        },
    };
    let selected = |value: Option<String>| value.filter(|s| !s.is_empty());
    let query = UsageQuery {
        filter: crate::storage::history::UsageFilter {
            family: selected(params.family),
            split_provider: params.split_provider.as_deref() == Some("1"),
            since_unix,
            to_unix,
            provider: selected(params.provider),
            model: selected(params.model),
            key: selected(params.key),
            pool: selected(params.pool),
        },
        bucket_seconds,
        group_by,
        limit,
    };
    let page = match state.history.lock().unwrap().usage_buckets(&query) {
        Ok(page) => page,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "bucket_seconds": bucket_seconds,
        "truncated": page.truncated,
        "calls": page.totals.requests,
        "unpriced_by_provider": page.unpriced_by_provider,
        "unpriced_providers_truncated": page.unpriced_providers_truncated,
        "totals": page.totals,
        "buckets": page.buckets,
    }))
}

/// System event log, newest first: bans, catalog refreshes, balance poll
/// failures. `limit` defaults to 50 and is capped, like request history.
pub async fn list_events(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<EventsQuery>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let limit = params.limit.unwrap_or(50).min(500) as i64;
    let events = match state.events.list(limit) {
        Ok(events) => events,
        Err(e) => return internal(&e.0),
    };
    ok_json(json!({
        "events": events.iter().map(|e| json!({
            "id": e.id,
            "ts_unix": e.ts_unix,
            "kind": e.kind,
            "provider_id": e.provider_id,
            // Detail is our own JSON text; a parse failure renders as null
            // instead of breaking the whole feed.
            "detail": e.detail.as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok()),
        })).collect::<Vec<_>>()
    }))
}

// --- Model knowledge base (researched cards, one per knowledge key) ---

#[derive(serde::Deserialize)]
pub struct KnowledgeQuery {
    upstream_id: String,
}

/// Read a batch of local cards. A JSON body avoids URL limits on long model IDs.
pub async fn knowledge_summaries(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(keys): Json<Vec<String>>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    if keys.len() > 128 {
        return bad_request("at most 128 model keys per batch");
    }
    match state.knowledge.summaries(&keys) {
        Ok(cards) => ok_json(json!({ "cards": cards })),
        Err(_) => internal("could not read model summaries"),
    }
}

#[derive(serde::Deserialize)]
pub struct KnowledgePost {
    provider_id: String,
    upstream_id: String,
    #[serde(default)]
    force: bool,
}

/// Every catalog entry whose knowledge key shares the card: the same
/// model behind different providers and spellings (`hy4-flash-free` vs
/// `hy4flash-free`).
fn knowledge_entries(state: &ApiState, key: &str) -> Result<Vec<serde_json::Value>, String> {
    let models = state.models.lock().unwrap().list_all().map_err(|e| e.0)?;
    Ok(models
        .into_iter()
        .filter(|m| {
            let model_key = crate::model::knowledge_key(&m.upstream_id);
            model_key == key || model_key.replace('-', "") == key.replace('-', "")
        })
        .map(|m| json!({"provider_id": m.provider_id, "upstream_id": m.upstream_id}))
        .collect())
}

/// The card of one model, whether it is still fresh, and every catalog
/// entry sharing it.
pub async fn get_model_knowledge(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<KnowledgeQuery>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let key = crate::model::knowledge_key(&params.upstream_id);
    let stored = match state.knowledge.get(&key) {
        Ok(s) => s,
        Err(e) => return internal(&e.0),
    };
    let max_age_secs: u64 = state
        .knowledge_cfg
        .as_ref()
        .map(|c| c.max_age.as_secs())
        .unwrap_or(30 * 86_400);
    let fresh = stored
        .as_ref()
        .map(|c| now_unix() - c.collected_at_unix < max_age_secs as i64)
        .unwrap_or(false);
    let entries = match knowledge_entries(&state, &key) {
        Ok(e) => e,
        Err(e) => return internal(&e),
    };
    ok_json(json!({
        "key": key,
        "card": stored.as_ref().and_then(|c| serde_json::from_str::<serde_json::Value>(&c.card_json).ok()),
        "collected_at_unix": stored.as_ref().map(|c| c.collected_at_unix),
        "fresh": fresh,
        "max_age_secs": max_age_secs,
        "catalog_entries": entries,
    }))
}

/// Collect (or re-collect) the card of one model through the configured
/// researcher. Skips the upstream call when the stored card is fresh,
/// unless `force`.
pub async fn post_model_knowledge(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(params): Json<KnowledgePost>,
) -> Response {
    if let Some(reject) = authorize(&state, &headers) {
        return reject;
    }
    let Some(cfg) = state.knowledge_cfg.clone() else {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "knowledge collector is not configured",
        );
    };
    let catalog_hit = state
        .models
        .lock()
        .unwrap()
        .find(&params.provider_id, &params.upstream_id)
        .ok()
        .flatten();
    if catalog_hit.is_none() {
        return not_found("model not found in catalog");
    }

    let key = crate::model::knowledge_key(&params.upstream_id);
    let max_age_secs = cfg.max_age.as_secs() as i64;
    if !params.force {
        let fresh = state
            .knowledge
            .get(&key)
            .ok()
            .flatten()
            .map(|c| now_unix() - c.collected_at_unix < max_age_secs)
            .unwrap_or(false);
        if fresh {
            return ok_json(json!({"key": key, "collected": false, "reason": "fresh"}));
        }
    }

    let provider = state
        .providers
        .get(&crate::model::ProviderId::new(cfg.provider_id.clone()));
    let Some(provider) = provider else {
        return internal("knowledge provider disappeared from the registry");
    };
    let collected = crate::provider::knowledge::research_card(
        provider.driver(),
        &cfg.model,
        &params.upstream_id,
        &params.provider_id,
    )
    .await;
    let collected = match collected {
        Ok(c) => c,
        Err(e) => {
            crate::schedule::emit(
                &state,
                event_kind::KNOWLEDGE_ERROR,
                None,
                &json!({ "key": key, "upstream_id": params.upstream_id, "error": e.0 }),
            );
            return error(StatusCode::BAD_GATEWAY, &e.0);
        }
    };
    let collected_at_unix = now_unix();
    if let Err(e) = state.knowledge.upsert(&crate::storage::knowledge::NewCard {
        key: key.clone(),
        card_json: collected.card_json.clone(),
        collected_at_unix,
        generator: format!("{}/{}+websearch", cfg.provider_id, cfg.model),
    }) {
        return internal(&e.0);
    }
    crate::schedule::emit(
        &state,
        event_kind::KNOWLEDGE_CARD,
        None,
        &json!({
            "key": key,
            "upstream_id": params.upstream_id,
            "provider_id": params.provider_id,
            "generator": format!("{}/{}", cfg.provider_id, cfg.model),
        }),
    );
    let entries = match knowledge_entries(&state, &key) {
        Ok(e) => e,
        Err(e) => return internal(&e),
    };
    ok_json(json!({
        "key": key,
        "collected": true,
        "collected_at_unix": collected_at_unix,
        "card": serde_json::from_str(&collected.card_json).unwrap_or(serde_json::Value::Null),
        "repairs": collected.repairs,
        "catalog_entries": entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use serde_json::json;

    fn state() -> Arc<ApiState> {
        Arc::new(crate::api::tests_support::test_state())
    }

    async fn serve(st: &Arc<ApiState>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = crate::api::routes(Arc::clone(st));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{addr}")
    }

    fn auth() -> reqwest::Client {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", "Bearer secret-one".parse().unwrap());
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap()
    }

    fn knowledge_state(cfg: Option<crate::config::KnowledgeConfig>) -> Arc<ApiState> {
        let mut st = crate::api::tests_support::test_state();
        st.knowledge_cfg = cfg;
        Arc::new(st)
    }

    fn cfg() -> crate::config::KnowledgeConfig {
        crate::config::KnowledgeConfig {
            provider_id: "prov".into(),
            model: "researcher".into(),
            max_age: std::time::Duration::from_secs(30 * 86_400),
        }
    }

    #[tokio::test]
    async fn knowledge_get_shows_shared_key_across_providers() {
        let st = state();
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![
                    crate::storage::catalog::NewModel {
                        upstream_id: "z-ai/glm-5.3".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                    crate::storage::catalog::NewModel {
                        upstream_id: "glm-5.3:free".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                    crate::storage::catalog::NewModel {
                        upstream_id: "hy4".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                ],
            )
            .unwrap();
        let base = serve(&st).await;
        let resp = auth()
            .get(format!(
                "{base}/v1/management/models/knowledge?upstream_id=z-ai%2Fglm-5.3"
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(v["key"], "glm-5-3");
        assert!(v["card"].is_null());
        assert!(!v["fresh"].as_bool().unwrap());
        let entries = v["catalog_entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[tokio::test]
    async fn knowledge_summaries_are_authorized_bounded_and_read_only() {
        let st = state();
        for key in ["test-model", "testmodel"] {
            st.knowledge.upsert(&crate::storage::knowledge::NewCard {
                key: key.into(), card_json: json!({"canonical_name":key, "ratings":[{"source":"Lab","metric":"Score","value":0}], "modality":"Text and image input; text output", "use_cases":["Code review","Chat"], "strengths":["not in index"]}).to_string(),
                collected_at_unix: 1, generator: "fixture".into(),
            }).unwrap();
        }
        let url = format!(
            "{}/v1/management/models/knowledge/summaries",
            serve(&st).await
        );
        assert_eq!(
            reqwest::Client::new()
                .post(&url)
                .json(&["testmodel"])
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            auth()
                .post(&url)
                .json(&vec!["x"; 129])
                .send()
                .await
                .unwrap()
                .status(),
            400
        );
        let page = auth()
            .post(url)
            .json(&["missing", "testmodel", "te-stmodel"])
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let cards = page["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 2);
        let exact = cards.iter().find(|r| r["key"] == "testmodel").unwrap();
        assert_eq!(exact["canonical_name"], "testmodel");
        assert_eq!(exact["ratings"][0]["value"], 0);
        assert!(exact.get("strengths").is_none());
        assert_eq!(exact["primary_use"], "Code review");
        assert_eq!(exact["modality"], "Text and image input; text output");
        assert!(exact.get("use_cases").is_none());
        assert!(
            cards
                .iter()
                .any(|r| r["key"] == "te-stmodel" && r["canonical_name"] == "test-model")
        );
    }

    #[tokio::test]
    async fn knowledge_post_requires_configuration_and_catalog_entry() {
        let st = knowledge_state(None);
        let base = serve(&st).await;
        let resp = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({"provider_id": "prov", "upstream_id": "m1"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 503);

        let st = knowledge_state(Some(cfg()));
        let base = serve(&st).await;
        let resp = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({"provider_id": "prov", "upstream_id": "missing"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn knowledge_post_emits_card_and_error_events() {
        let server = wiremock::MockServer::start().await;
        let mut st = crate::api::tests_support::test_state();
        st.knowledge_cfg = Some(cfg());
        // Point the researcher connection at the mock server.
        st.providers = crate::provider::ProviderRegistry::build(
            &[crate::config::ProviderConfig {
                provider_id: "prov".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("k".into()),
                static_models: Vec::new(),
            }],
            crate::config::HttpTimeouts::default(),
        )
        .unwrap();
        let st = Arc::new(st);
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![crate::storage::catalog::NewModel {
                    upstream_id: "glm-5.3".into(),
                    context_tokens: None,
                    observed_at_unix: 1,
                }],
            )
            .unwrap();
        let base = serve(&st).await;

        // Success: the researcher returns a minimal valid card.
        let card = "{\"description\":\"d\",\"sources\":[\"u\"]}";
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/chat/completions"))
            .respond_with(wiremock::ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"content": card}}]
            })))
            .mount(&server)
            .await;
        let v: serde_json::Value = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({"provider_id": "prov", "upstream_id": "glm-5.3"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(v["collected"], true);
        let events = st.events.list(10).unwrap();
        assert_eq!(events[0].kind, "knowledge_card");

        // Failure: the researcher goes dark, the error becomes an event.
        server.reset().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/chat/completions"))
            .respond_with(wiremock::ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let resp = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({
                "provider_id": "prov",
                "upstream_id": "glm-5.3",
                "force": true
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 502);
        let events = st.events.list(10).unwrap();
        assert_eq!(events[0].kind, "knowledge_error");
        let detail: serde_json::Value =
            serde_json::from_str(events[0].detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["key"], "glm-5-3");
        assert_eq!(
            events.get(1).map(|e| e.kind.as_str()),
            Some("knowledge_card")
        );
    }

    #[tokio::test]
    async fn knowledge_post_skips_fresh_cards_and_collects_stale() {
        let st = knowledge_state(Some(cfg()));
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![crate::storage::catalog::NewModel {
                    upstream_id: "glm-5.3".into(),
                    context_tokens: None,
                    observed_at_unix: 1,
                }],
            )
            .unwrap();
        st.knowledge
            .upsert(&crate::storage::knowledge::NewCard {
                key: "glm-5-3".into(),
                card_json: "{\"description\":\"d\",\"sources\":[\"u\"]}".into(),
                collected_at_unix: now_unix(),
                generator: "test".into(),
            })
            .unwrap();
        let base = serve(&st).await;

        // Fresh card: no upstream call, the stored card stays.
        let v: serde_json::Value = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({"provider_id": "prov", "upstream_id": "glm-5.3"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(v["collected"], false);
        assert_eq!(v["reason"], "fresh");

        // Stale card: collection runs; the researcher provider is
        // unreachable in tests, so the outcome is an honest 502.
        st.knowledge
            .upsert(&crate::storage::knowledge::NewCard {
                key: "glm-5-3".into(),
                card_json: "{}".into(),
                collected_at_unix: now_unix() - 31 * 86_400,
                generator: "test".into(),
            })
            .unwrap();
        let resp = auth()
            .post(format!("{base}/v1/management/models/knowledge"))
            .json(&json!({"provider_id": "prov", "upstream_id": "glm-5.3"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 502);
    }

    #[tokio::test]
    async fn catalog_lists_all_upstream_models_with_knowledge_keys() {
        let st = state();
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![
                    crate::storage::catalog::NewModel {
                        upstream_id: "z-ai/glm-5.3".into(),
                        context_tokens: Some(200_000),
                        observed_at_unix: 1,
                    },
                    crate::storage::catalog::NewModel {
                        upstream_id: "glm-5.3:free".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    },
                ],
            )
            .unwrap();
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "other",
                vec![crate::storage::catalog::NewModel {
                    upstream_id: "k2".into(),
                    context_tokens: None,
                    observed_at_unix: 1,
                }],
            )
            .unwrap();
        let base = serve(&st).await;

        let resp = auth()
            .get(format!("{base}/v1/management/models"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let v: serde_json::Value = resp.json().await.unwrap();
        let models = v["models"].as_array().unwrap();
        assert_eq!(models.len(), 3);
        let mut glm = 0;
        let mut k2 = 0;
        for m in models {
            match m["knowledge_key"].as_str().unwrap() {
                "glm-5-3" => glm += 1,
                "k2" => k2 += 1,
                other => panic!("unexpected key {other}"),
            }
        }
        assert_eq!((glm, k2), (2, 1));

        // The catalog is management-only: client keys without the
        // management secret must not see it.
        let resp = reqwest::Client::new()
            .get(format!("{base}/v1/management/models"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
    }

    #[tokio::test]
    async fn pool_lifecycle_via_http() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();

        let created = client
            .put(format!("{base}/v1/management/pools/main"))
            .header("if-none-match", "*")
            .json(&json!({
                "members": [
                    {"provider_id": "prov", "upstream_id": "m1"},
                    {"provider_id": "prov", "upstream_id": "m2"},
                ]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(created.status(), reqwest::StatusCode::CREATED);

        let collision = client
            .put(format!("{base}/v1/management/pools/main"))
            .header("if-none-match", "*")
            .json(&json!({"members": [{"provider_id": "prov", "upstream_id": "m2"}]}))
            .send()
            .await
            .unwrap();
        assert_eq!(collision.status(), reqwest::StatusCode::PRECONDITION_FAILED);

        let list = client
            .get(format!("{base}/v1/management/pools"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(
            list["pools"][0]["members"][1]["upstream_id"], "m2",
            "order must follow the request"
        );

        // Replace reorders and reuses the same pool.
        client
            .put(format!("{base}/v1/management/pools/main"))
            .json(&json!({
                "members": [{"provider_id": "prov", "upstream_id": "m2"}]
            }))
            .send()
            .await
            .unwrap();
        let one = client
            .get(format!("{base}/v1/management/pools/main"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(one["members"].as_array().unwrap().len(), 1);

        let deleted = client
            .delete(format!("{base}/v1/management/pools/main"))
            .send()
            .await
            .unwrap();
        assert_eq!(deleted.status(), reqwest::StatusCode::NO_CONTENT);
        let missing = client
            .get(format!("{base}/v1/management/pools/main"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), reqwest::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_member_provider_is_rejected() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .put(format!("{base}/v1/management/pools/main"))
            .json(&json!({
                "members": [{"provider_id": "nope", "upstream_id": "m1"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn pool_name_shape_is_enforced() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        let body = json!({
            "members": [{"provider_id": "prov", "upstream_id": "m1"}]
        });
        let long = "a".repeat(65);
        for name in ["Bad-Name", &long, "с пробелом", "pro!"] {
            let response = client
                .put(format!("{base}/v1/management/pools/{name}"))
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::BAD_REQUEST,
                "name: {name}"
            );
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["error"]["type"], "invalid_name", "name: {name}");
        }
        // Lowercase with allowed separators is fine.
        let ok = client
            .put(format!("{base}/v1/management/pools/code-bed.1"))
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), reqwest::StatusCode::CREATED);
    }

    #[tokio::test]
    async fn empty_pool_body_is_rejected() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .put(format!("{base}/v1/management/pools/main"))
            .json(&json!({ "members": [] }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "invalid_pool");
    }

    #[tokio::test]
    async fn member_outside_fetched_catalog_is_rejected() {
        let st = state();
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "prov",
                    vec![crate::storage::catalog::NewModel {
                        upstream_id: "m1".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    }],
                )
                .unwrap();
        }
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .put(format!("{base}/v1/management/pools/main"))
            .json(&json!({
                "members": [{"provider_id": "prov", "upstream_id": "typo-model"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "unknown_model");

        // The catalogued model still goes through.
        let ok = client
            .put(format!("{base}/v1/management/pools/ok-pool"))
            .json(&json!({
                "members": [{"provider_id": "prov", "upstream_id": "m1"}]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), reqwest::StatusCode::CREATED);
    }

    #[tokio::test]
    async fn management_requires_key() {
        let st = state();
        let base = serve(&st).await;
        let response = reqwest::get(format!("{base}/v1/management/pools"))
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn providers_and_empty_history() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();

        let providers = client
            .get(format!("{base}/v1/management/providers"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(providers["providers"][0]["provider_id"], "prov");
        assert_eq!(providers["providers"][0]["catalog"], "dynamic");

        let requests = client
            .get(format!("{base}/v1/management/requests"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert!(requests["requests"].as_array().unwrap().is_empty());

        let observations = client
            .get(format!("{base}/v1/management/observations"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert!(observations["observations"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn history_lists_requests_with_attempts() {
        let st = state();
        {
            let summary = crate::history::RequestSummary {
                id: "req-1".into(),
                key_alias: "test".into(),
                metamodel: "mm".into(),
                started_at_unix: 1_000,
                finished_at_unix: 1_003,
                outcome: "ok".into(),
                input: Some(crate::history::preview("{\"model\":\"mm\"}")),
                declared_tools: None,
                issues: Vec::new(),
                attempts: vec![crate::history::AttemptSummary {
                    provider_id: "prov".into(),
                    upstream_id: "m1".into(),
                    started_at_unix: 1_001,
                    finished_at_unix: 1_002,
                    result: "ok".into(),
                    error: None,
                    error_class: None,
                    duration_ms: None,
                    switch_reason: None,
                    input_tokens: Some(10),
                    output_tokens: Some(20),
                    cost: None,
                    response: Some(crate::history::preview("hello")),
                    tool_calls: Default::default(),
                    issues: Vec::new(),
                }],
            };
            st.history
                .lock()
                .unwrap()
                .insert_summaries(&[summary])
                .unwrap();
        }
        let base = serve(&st).await;
        let client = auth();
        let requests = client
            .get(format!("{base}/v1/management/requests"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let entry = &requests["requests"][0];
        assert_eq!(entry["id"], "req-1");
        assert_eq!(entry["input_preview"], "{\"model\":\"mm\"}");
        assert_eq!(entry["attempts"][0]["upstream_id"], "m1");
        assert_eq!(entry["attempts"][0]["output_tokens"], 20);
        assert_eq!(entry["attempts"][0]["response_preview"], "hello");
    }

    #[tokio::test]
    async fn usage_spend_attributes_series_tokens_over_http() {
        use crate::storage::balances::Observation;
        let st = state();
        {
            let mut summary = crate::history::RequestSummary {
                id: "req-1".into(),
                key_alias: "cli".into(),
                metamodel: "coder".into(),
                started_at_unix: 1_400,
                finished_at_unix: 1_500,
                outcome: "ok".into(),
                input: None,
                declared_tools: None,
                issues: Vec::new(),
                attempts: vec![crate::history::AttemptSummary {
                    provider_id: "prov".into(),
                    upstream_id: "m1".into(),
                    started_at_unix: 1_400,
                    finished_at_unix: 1_500,
                    result: "ok".into(),
                    error: None,
                    error_class: None,
                    duration_ms: None,
                    switch_reason: None,
                    input_tokens: Some(30),
                    output_tokens: Some(20),
                    cost: None,
                    response: None,
                    tool_calls: Default::default(),
                    issues: Vec::new(),
                }],
            };
            // Tokens outside any observation interval must not count.
            summary.attempts[0].input_tokens = Some(30);
            st.history
                .lock()
                .unwrap()
                .insert_summaries(&[summary])
                .unwrap();
            for (remaining, at) in [("100", 1_000), ("90", 2_000)] {
                st.balances
                    .lock()
                    .unwrap()
                    .append(&Observation {
                        provider_id: "prov".into(),
                        resource: "coding-plan".into(),
                        metric: "credits".into(),
                        unit: Some("credit".into()),
                        limit: None,
                        usage: None,
                        remaining: Some(remaining.into()),
                        window: Some("5h".into()),
                        resets_at_unix: None,
                        observed_at_unix: at,
                    })
                    .unwrap();
            }
        }
        let base = serve(&st).await;
        let body = auth()
            .get(format!("{base}/v1/management/usage/spend"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let series = body["series"].as_array().unwrap();
        assert_eq!(series.len(), 1);
        let report = &series[0];
        assert_eq!(report["provider"], "prov");
        assert_eq!(report["intervals"], 1);
        assert_eq!(report["spent"], 10.0);
        assert_eq!(report["tokens"], 50);
        // 10 credits per 50 tokens = 200 credits per 1000 tokens.
        assert_eq!(report["per_1000"], 200.0);
        assert!(report["method"].as_str().unwrap().contains("proxy"));
    }

    #[tokio::test]
    async fn usage_spend_calibrates_each_connection_once_regardless_of_driver() {
        use crate::storage::balances::Observation;
        let mut raw = crate::api::tests_support::test_state();
        // One cost-reporting connection (openrouter) and one balance
        // connection with two series sharing one token stream.
        raw.providers = crate::provider::ProviderRegistry::build(
            &[
                crate::config::ProviderConfig {
                    provider_id: "prov".into(),
                    driver: crate::config::DriverKind::Zai,
                    base_url: "https://example.invalid/v1".into(),
                    api_key: Some("k".into()),
                    static_models: Vec::new(),
                },
                crate::config::ProviderConfig {
                    provider_id: "openr".into(),
                    driver: crate::config::DriverKind::OpenRouter,
                    base_url: "https://example.invalid/v1".into(),
                    api_key: Some("k".into()),
                    static_models: Vec::new(),
                },
            ],
            crate::config::HttpTimeouts::default(),
        )
        .unwrap();
        let st = Arc::new(raw);
        {
            let summary = crate::history::RequestSummary {
                id: "req-1".into(),
                key_alias: "cli".into(),
                metamodel: "coder".into(),
                started_at_unix: 1_400,
                finished_at_unix: 1_500,
                outcome: "ok".into(),
                input: None,
                declared_tools: None,
                issues: Vec::new(),
                attempts: vec![crate::history::AttemptSummary {
                    provider_id: "prov".into(),
                    upstream_id: "m1".into(),
                    started_at_unix: 1_400,
                    finished_at_unix: 1_500,
                    result: "ok".into(),
                    error: None,
                    error_class: None,
                    duration_ms: None,
                    switch_reason: None,
                    input_tokens: Some(30),
                    output_tokens: Some(20),
                    cost: None,
                    response: None,
                    tool_calls: Default::default(),
                    issues: Vec::new(),
                }],
            };
            let mut other = summary.clone();
            other.id = "other".into();
            other.attempts[0].provider_id = "openr".into();
            st.history
                .lock()
                .unwrap()
                .insert_summaries(&[summary, other])
                .unwrap();
            for (resource, window, remaining, at) in [
                ("plan", "5h", "100", 1_000),
                ("plan", "5h", "90", 2_000),
                ("plan", "month", "1000", 1_000),
                ("plan", "month", "995", 2_000),
            ] {
                st.balances
                    .lock()
                    .unwrap()
                    .append(&Observation {
                        provider_id: "prov".into(),
                        resource: resource.into(),
                        metric: "credits".into(),
                        unit: Some("credit".into()),
                        limit: None,
                        usage: None,
                        remaining: Some(remaining.into()),
                        window: Some(window.into()),
                        resets_at_unix: None,
                        observed_at_unix: at,
                    })
                    .unwrap();
            }
            for (remaining, at) in [("100", 1_000), ("90", 2_000)] {
                st.balances
                    .lock()
                    .unwrap()
                    .append(&Observation {
                        provider_id: "openr".into(),
                        resource: "credits".into(),
                        metric: "credits".into(),
                        unit: Some("credit".into()),
                        limit: None,
                        usage: None,
                        remaining: Some(remaining.into()),
                        window: Some("month".into()),
                        resets_at_unix: None,
                        observed_at_unix: at,
                    })
                    .unwrap();
            }
        }
        let base = serve(&st).await;
        let body = auth()
            .get(format!("{base}/v1/management/usage/spend"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let series = body["series"].as_array().unwrap();
        assert_eq!(series.len(), 3);
        let openr = series
            .iter()
            .find(|report| report["provider"] == "openr")
            .unwrap();
        assert_eq!(openr["per_1000"].as_f64(), Some(200.0));
        let mut prov = series.iter().filter(|report| report["provider"] == "prov");
        // Both series see the same token stream; only one may carry k.
        let primary = prov
            .clone()
            .find(|report| report["primary_series"] == true)
            .unwrap();
        assert_eq!(primary["per_1000"], 200.0);
        let sibling = prov
            .find(|report| report["primary_series"] == false)
            .unwrap();
        assert_eq!(sibling["per_1000"], serde_json::Value::Null);
    }

    #[tokio::test]
    async fn usage_buckets_over_http() {
        let st = state();
        {
            // One call that failed over: two attempts, one request.
            let summary = crate::history::RequestSummary {
                id: "req-1".into(),
                key_alias: "cli".into(),
                metamodel: "coder".into(),
                started_at_unix: 3_600,
                finished_at_unix: 3_604,
                outcome: "ok".into(),
                input: None,
                declared_tools: None,
                issues: Vec::new(),
                attempts: vec![
                    crate::history::AttemptSummary {
                        provider_id: "prov".into(),
                        upstream_id: "m1".into(),
                        started_at_unix: 3_600,
                        finished_at_unix: 3_601,
                        result: "error".into(),
                        error: None,
                        error_class: None,
                        duration_ms: None,
                        switch_reason: None,
                        input_tokens: None,
                        output_tokens: None,
                        cost: None,
                        response: None,
                        tool_calls: Default::default(),
                        issues: Vec::new(),
                    },
                    crate::history::AttemptSummary {
                        provider_id: "prov".into(),
                        upstream_id: "m2".into(),
                        started_at_unix: 3_602,
                        finished_at_unix: 3_603,
                        result: "ok".into(),
                        error: None,
                        error_class: None,
                        duration_ms: None,
                        switch_reason: None,
                        input_tokens: Some(10),
                        output_tokens: Some(20),
                        cost: Some(0.125),
                        response: None,
                        tool_calls: Default::default(),
                        issues: Vec::new(),
                    },
                ],
            };
            st.history
                .lock()
                .unwrap()
                .insert_summaries(&[summary])
                .unwrap();
        }
        let base = serve(&st).await;
        let client = auth();
        let body = client
            .get(format!("{base}/v1/management/usage?group_by=model"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(body["bucket_seconds"], 3_600);
        assert_eq!(body["truncated"], false);
        // One client call failed over: two attempts, still one call.
        assert_eq!(body["calls"], 1);
        let buckets = body["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        let failed = &buckets[0];
        assert_eq!(failed["group"], "prov/m1");
        assert_eq!(failed["errors"], 1);
        // Nothing reported: null, not a fake zero.
        assert!(failed["input_tokens"].is_null());
        assert!(failed["cost"].is_null());
        assert_eq!(failed["unknown_tokens"], 1);
        let ok = &buckets[1];
        assert_eq!(ok["group"], "prov/m2");
        assert_eq!(ok["requests"], 1);
        assert_eq!(ok["attempts"], 1);
        assert_eq!(ok["input_tokens"], 10);
        assert_eq!(ok["output_tokens"], 20);
        assert_eq!(ok["cost"], 0.125);
        assert_eq!(ok["cost_reports"], 1);

        // A page cut affects the chart, not the full selection.
        for (query, attempts, calls) in [
            ("group_by=model&limit=1", 2, 1),
            (
                "provider=prov&model=m2&key=cli&pool=coder&since_unix=3602&to_unix=3603",
                1,
                1,
            ),
            ("provider=missing", 0, 0),
            ("model=m3", 0, 0),
            ("pool=missing", 0, 0),
            ("key=missing", 0, 0),
            ("to_unix=3600", 0, 0),
        ] {
            let page = client
                .get(format!("{base}/v1/management/usage?{query}"))
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap();
            assert_eq!(page["totals"]["attempts"], attempts, "{query}");
            assert_eq!(page["calls"], calls, "{query}");
            assert_eq!(
                page["buckets"].as_array().unwrap().len(),
                usize::from(attempts > 0)
            );
            if attempts == 2 {
                assert_eq!(page["truncated"], true);
                assert_eq!(page["totals"]["input_reports"], 1);
                assert_eq!(page["totals"]["ok"], 1);
                assert_eq!(page["totals"]["output_tokens"], 20);
            }
        }

        // Grouping by key and daily buckets reaches the same totals.
        let daily = client
            .get(format!(
                "{base}/v1/management/usage?group_by=key&bucket=day"
            ))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(daily["bucket_seconds"], 86_400);
        let day = &daily["buckets"][0];
        assert_eq!(day["group"], "cli");
        assert_eq!(day["bucket_unix"], 0);
        assert_eq!(day["requests"], 1);
        assert_eq!(day["attempts"], 2);
        assert_eq!(day["input_tokens"], 10);

        // The attempt carries the reported cost for the detail view.
        let requests = client
            .get(format!("{base}/v1/management/requests"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(requests["requests"][0]["attempts"][1]["cost"], 0.125);
    }

    #[tokio::test]
    async fn usage_rejects_invalid_query_values() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        for bad in [
            "bucket=week",
            "group_by=nope",
            "to_unix=nope",
            "since_unix=30&to_unix=30",
            "since_unix=not-a-number",
            "limit=abc",
        ] {
            let response = client
                .get(format!("{base}/v1/management/usage?{bad}"))
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "query: {bad}");
            assert_eq!(body["error"]["type"], "invalid_query", "query: {bad}");
        }
        // Spend is as private as history: no key, no answer.
        let anonymous = reqwest::Client::new()
            .get(format!("{base}/v1/management/usage"))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn history_rejects_invalid_query_values() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        for bad in [
            "limit=abc",
            "limit=1e3",
            "since_unix=not-a-number",
            "before_id=&limit=xyz",
            "to_unix=no",
            "since_unix=50&to_unix=50",
        ] {
            let response = client
                .get(format!("{base}/v1/management/requests?{bad}"))
                .send()
                .await
                .unwrap();
            let status = response.status();
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "query: {bad}");
            assert_eq!(body["error"]["type"], "invalid_query", "query: {bad}");
        }
    }

    #[tokio::test]
    async fn activity_requires_auth_and_validates_the_period() {
        let base = serve(&state()).await;
        let url = format!("{base}/v1/management/requests/activity");
        assert_eq!(
            reqwest::get(&url).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            auth()
                .get(format!("{url}?period=year"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        let result: serde_json::Value = auth()
            .get(format!("{url}?period=1h"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(result["step_secs"], 60);
        assert_eq!(
            result["to_unix"].as_i64().unwrap() - result["from_unix"].as_i64().unwrap(),
            3600
        );
        assert_eq!(result["buckets"], json!([]));
        for query in [
            "since_unix=4",
            "to_unix=10",
            "since_unix=3&to_unix=3",
            "since_unix=no&to_unix=40",
            "since_unix=0&to_unix=9223372036854775807",
            "period=all&since_unix=0&to_unix=60",
        ] {
            assert_eq!(
                auth()
                    .get(format!("{url}?{query}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[tokio::test]
    async fn history_pages_and_filters_over_http() {
        let st = state();
        {
            let summaries: Vec<crate::history::RequestSummary> = (0..5)
                .map(|i| crate::history::RequestSummary {
                    id: format!("req-000000001737-{:06}", i),
                    key_alias: "phone".into(),
                    metamodel: "chat".into(),
                    started_at_unix: 1_000 + i,
                    finished_at_unix: 1_500 + i,
                    outcome: if i % 2 == 0 {
                        "ok".into()
                    } else {
                        "failed".into()
                    },
                    input: None,
                    declared_tools: None,
                    issues: Vec::new(),
                    attempts: Vec::new(),
                })
                .collect();
            st.history
                .lock()
                .unwrap()
                .insert_summaries(&summaries)
                .unwrap();
        }
        let base = serve(&st).await;
        let client = auth();
        let activity: serde_json::Value = client
            .get(format!("{base}/v1/management/requests/activity?period=all&outcome=ok&key_alias=phone&metamodel=chat"))
            .send().await.unwrap().json().await.unwrap();
        assert_eq!(activity["buckets"][0]["total"], 3);
        assert_eq!(activity["from_unix"], 1000);
        assert_eq!(activity["to_unix"], 1005);
        let bounded: serde_json::Value = client
            .get(format!(
                "{base}/v1/management/requests/activity?since_unix=999&to_unix=1004&outcome=ok"
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(bounded["from_unix"], 999);
        assert_eq!(bounded["to_unix"], 1004);
        assert_eq!(bounded["buckets"][0]["total"], 2);
        let slice: serde_json::Value = client
            .get(format!(
                "{base}/v1/management/requests?since_unix=1000&to_unix=1004&outcome=ok"
            ))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(slice["requests"].as_array().unwrap().len(), 2);
        let page = client
            .get(format!("{base}/v1/management/requests?limit=2"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let ids: Vec<&str> = page["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec!["req-000000001737-000004", "req-000000001737-000003"]
        );

        let next = client
            .get(format!(
                "{base}/v1/management/requests?limit=2&before_id=req-000000001737-000003"
            ))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let ids: Vec<&str> = next["requests"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec!["req-000000001737-000002", "req-000000001737-000001"]
        );

        let failed = client
            .get(format!("{base}/v1/management/requests?outcome=failed"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(failed["requests"].as_array().unwrap().len(), 2);

        let recent = client
            .get(format!("{base}/v1/management/requests?since_unix=1002"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(recent["requests"].as_array().unwrap().len(), 3);

        let empty_filter = client
            .get(format!("{base}/v1/management/requests?outcome="))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(empty_filter["requests"].as_array().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn refresh_requires_key_and_valid_what() {
        let st = state();
        let base = serve(&st).await;
        let no_key = reqwest::Client::new();
        let anonymous = no_key
            .post(format!("{base}/v1/management/refresh"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), reqwest::StatusCode::UNAUTHORIZED);

        let client = auth();
        let bad = client
            .post(format!("{base}/v1/management/refresh"))
            .json(&json!({ "what": "everything" }))
            .send()
            .await
            .unwrap();
        assert_eq!(bad.status(), reqwest::StatusCode::BAD_REQUEST);
        let body: serde_json::Value = bad.json().await.unwrap();
        assert_eq!(body["error"]["type"], "invalid_what");
    }

    #[tokio::test]
    async fn refresh_pass_is_not_duplicated_while_running() {
        let st = state();
        // A pass is already in flight: the handler must not spawn another
        // and must still answer 202 with the current status.
        st.refresh_running
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .post(format!("{base}/v1/management/refresh"))
            .json(&json!({ "what": "catalog" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        // No pass ran for the request: nothing was scheduled by us, and the
        // flag we set stays untouched until our own writer resets it.
        let events = st.events.list(10).unwrap();
        assert!(events.is_empty(), "no refresh may run: {events:?}");
        st.refresh_running
            .store(false, std::sync::atomic::Ordering::SeqCst);
    }

    #[tokio::test]
    async fn refresh_runs_a_pass_and_reports_status() {
        let st = state();
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .post(format!("{base}/v1/management/refresh"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        // The pass runs in the background over an unreachable host; wait
        // for it to land in the status map (or fail the test on timeout).
        let mut reported = false;
        for _ in 0..200 {
            let reported_now = {
                let status = st.catalog_refresh.lock().unwrap();
                status
                    .get(&crate::model::ProviderId::new("prov"))
                    .map(|s| s.last_error.is_some() || s.last_success_unix.is_some())
                    .unwrap_or(false)
            };
            if reported_now {
                reported = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(reported, "manual refresh never reported a status");
        assert!(!st.refresh_running.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn observations_history_mode_over_http() {
        let st = state();
        {
            let balances = st.balances.lock().unwrap();
            for at in [100, 200, 300] {
                balances
                    .append(&crate::storage::balances::Observation {
                        provider_id: "prov".into(),
                        resource: "credits".into(),
                        metric: "balance".into(),
                        unit: None,
                        limit: None,
                        usage: None,
                        remaining: Some(at.to_string()),
                        window: None,
                        resets_at_unix: None,
                        observed_at_unix: at,
                    })
                    .unwrap();
            }
        }
        let base = serve(&st).await;
        let client = auth();
        // No parameters: one latest point per indicator, as before.
        let latest = client
            .get(format!(
                "{base}/v1/management/observations?provider_id=prov"
            ))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(latest["observations"].as_array().unwrap().len(), 1);

        let timeline = client
            .get(format!(
                "{base}/v1/management/observations?provider_id=prov&since_unix=150"
            ))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let points = timeline["observations"].as_array().unwrap();
        let times: Vec<i64> = points
            .iter()
            .map(|o| o["observed_at_unix"].as_i64().unwrap())
            .collect();
        assert_eq!(times, vec![200, 300]);

        for bad in ["since_unix=abc", "limit=x", ""] {
            let url = if bad.is_empty() {
                format!("{base}/v1/management/observations?limit=5")
            } else {
                format!("{base}/v1/management/observations?{bad}")
            };
            let response = client.get(url).send().await.unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::BAD_REQUEST,
                "query: {bad}"
            );
        }
    }

    #[tokio::test]
    async fn observations_history_selects_one_series_over_http() {
        let st = state();
        {
            let balances = st.balances.lock().unwrap();
            // Two windows of one connection plus an all-time credit series.
            // The limit must cut each series on its own.
            for at in [100, 200, 300] {
                for (resource, metric, window) in [
                    ("coding-plan", "tokens", Some("5h")),
                    ("coding-plan", "tokens", Some("week")),
                    ("account", "money", None),
                ] {
                    balances
                        .append(&crate::storage::balances::Observation {
                            provider_id: "prov".into(),
                            resource: resource.into(),
                            metric: metric.into(),
                            unit: None,
                            limit: None,
                            usage: Some(at.to_string()),
                            remaining: None,
                            window: window.map(str::to_owned),
                            resets_at_unix: None,
                            observed_at_unix: at,
                        })
                        .unwrap();
                }
            }
        }
        let base = serve(&st).await;
        let client = auth();
        let get = |query: String| {
            let client = client.clone();
            let base = base.clone();
            async move {
                client
                    .get(format!("{base}/v1/management/observations?{query}"))
                    .send()
                    .await
                    .unwrap()
                    .json::<serde_json::Value>()
                    .await
                    .unwrap()["observations"]
                    .as_array()
                    .unwrap()
                    .clone()
            }
        };

        let weekly =
            get("provider_id=prov&resource=coding-plan&metric=tokens&window=week&limit=3".into())
                .await;
        let times: Vec<i64> = weekly
            .iter()
            .map(|o| o["observed_at_unix"].as_i64().unwrap())
            .collect();
        assert_eq!(times, vec![100, 200, 300]);
        assert!(weekly.iter().all(|o| o["window"] == "week"));

        // An empty window selects the series that report no window.
        let account = get("provider_id=prov&window=&limit=10".into()).await;
        assert_eq!(account.len(), 3);
        assert!(account.iter().all(|o| o["window"].is_null()));

        // A series filter alone switches to history mode, and an unknown
        // series is empty rather than a fallback to every series.
        let unknown = get("provider_id=prov&window=month".into()).await;
        assert!(unknown.is_empty());
        // History mode still needs a connection.
        let response = client
            .get(format!("{base}/v1/management/observations?window=week"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn observations_without_provider_cover_all_connections() {
        let st = state();
        {
            let balances = st.balances.lock().unwrap();
            for provider in ["zai", "openrouter"] {
                balances
                    .append(&crate::storage::balances::Observation {
                        provider_id: provider.into(),
                        resource: "credits".into(),
                        metric: "money".into(),
                        unit: Some("USD".into()),
                        limit: None,
                        usage: None,
                        remaining: Some("1".into()),
                        window: None,
                        resets_at_unix: None,
                        observed_at_unix: 100,
                    })
                    .unwrap();
            }
        }
        let base = serve(&st).await;
        let client = auth();

        for url in [
            format!("{base}/v1/management/observations"),
            format!("{base}/v1/management/observations?provider_id="),
        ] {
            let latest = client
                .get(url)
                .send()
                .await
                .unwrap()
                .json::<serde_json::Value>()
                .await
                .unwrap();
            let observations = latest["observations"].as_array().unwrap();
            assert_eq!(observations.len(), 2);
            let providers: Vec<&str> = observations
                .iter()
                .map(|o| o["provider_id"].as_str().unwrap())
                .collect();
            assert_eq!(providers, ["openrouter", "zai"]);
        }
    }

    #[tokio::test]
    async fn bans_are_listed_until_expiry() {
        let st = state();
        {
            let bans = st.router.bans();
            bans.record("prov", "m1", "timeout", now_unix() + 60)
                .unwrap();
            bans.record("prov", "m2", "gone", now_unix() - 60).unwrap();
        }
        let base = serve(&st).await;
        let client = auth();
        let response = client
            .get(format!("{base}/v1/management/bans"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        let bans = response["bans"].as_array().unwrap();
        assert_eq!(bans.len(), 1, "the expired ban must not be listed");
        assert_eq!(bans[0]["upstream_id"], "m1");
        assert_eq!(bans[0]["reason"], "timeout");
    }

    #[tokio::test]
    async fn events_requires_auth_and_lists_newest_first() {
        let st = state();
        st.events
            .record(
                100,
                "ban_recorded",
                Some("prov"),
                &json!({"reason": "quota"}),
            )
            .unwrap();
        st.events
            .record(
                200,
                "catalog_error",
                Some("prov"),
                &json!({"error": "timeout"}),
            )
            .unwrap();
        let base = serve(&st).await;
        let anon = reqwest::Client::new();
        let rejected = anon
            .get(format!("{base}/v1/management/events"))
            .send()
            .await
            .unwrap();
        assert_eq!(rejected.status(), reqwest::StatusCode::UNAUTHORIZED);
        let client = auth();
        let feed = client
            .get(format!("{base}/v1/management/events?limit=1"))
            .send()
            .await
            .unwrap()
            .json::<serde_json::Value>()
            .await
            .unwrap();
        assert_eq!(feed["events"].as_array().unwrap().len(), 1);
        assert_eq!(feed["events"][0]["kind"], "catalog_error");
        assert_eq!(feed["events"][0]["detail"]["error"], "timeout");
    }
}
