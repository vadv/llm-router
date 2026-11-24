// HTTP surface: incoming key authentication, conversation identity, the
// inference endpoint, and health. Handlers own transport, auth, and request
// parsing — never the member fallback loop.

pub mod auth;
pub mod health;
pub mod identity;
pub mod inference;
pub mod memory;
pub mod models;
#[cfg(test)]
pub mod tests_support;
pub mod web;

use std::sync::{Arc, Mutex};

use axum::Json;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;

use std::collections::HashMap;

use crate::metamodel::MetamodelService;
use crate::model::ProviderId;
use crate::provider::ProviderRegistry;
use crate::routing::Router;
use crate::schedule::RefreshStatus;
use crate::storage::bans::BanStore;
use crate::storage::catalog::ModelStore;
use auth::KeyAuthenticator;
pub mod management;

/// Everything a request handler may touch. The SQLite-backed pieces sit
/// behind short-lived locks: a lock is taken for one query and released —
/// never held across a network await or a generation.
pub struct ApiState {
    /// Process start, the `created` timestamp of advertised models.
    pub(crate) started_at_unix: i64,
    pub(crate) keys: KeyAuthenticator,
    pub(crate) providers: ProviderRegistry,
    pub(crate) router: Router<BanStore>,
    pub(crate) metamodels: Mutex<MetamodelService>,
    pub(crate) models: Mutex<ModelStore>,
    /// Completed request history: reads for the management API, purges
    /// on schedule. Writes happen only on the writer thread below.
    pub(crate) history: Mutex<crate::storage::history::HistoryStore>,
    /// Completed summaries queue in here; SQLite never blocks inference.
    pub(crate) history_writer: crate::history::writer::HistoryWriter,
    /// Requests being served right now; RAM only, never touches SQLite.
    pub(crate) running: crate::history::RunningRegistry,
    /// System event log: bans, catalog refreshes, balance poll failures.
    pub(crate) events: std::sync::Arc<crate::storage::events::EventStore>,
    /// Researched model cards; one per knowledge key, shared across providers.
    pub(crate) knowledge: std::sync::Arc<crate::storage::knowledge::KnowledgeStore>,
    /// Collector settings; None = the knowledge endpoints answer "not
    /// configured" instead of guessing a provider.
    pub(crate) knowledge_cfg: Option<crate::config::KnowledgeConfig>,
    /// The last "research every card" job; it runs on its own task, so a
    /// restart forgets it and the dashboard reads its progress without a lock
    /// on the worker.
    pub(crate) research: Mutex<Option<Arc<crate::research::ResearchProgress>>>,
    /// Balance observations; no driver reports any yet.
    pub(crate) balances: Mutex<crate::storage::balances::BalanceStore>,
    /// Last catalog-refresh outcome per connection; RAM only, restart resets.
    pub(crate) catalog_refresh: Mutex<HashMap<ProviderId, RefreshStatus>>,
    /// Last history-write error; None = writing works. Health reports the
    /// process as degraded while inference continues serving.
    pub(crate) history_writes: std::sync::Arc<Mutex<Option<String>>>,
    /// True while a manual or scheduled refresh pass is in flight, so a
    /// manual trigger cannot start a second concurrent pass.
    pub(crate) refresh_running: std::sync::atomic::AtomicBool,
    /// Backing services for the chat function tools: web search/read and
    /// the owner-scoped memory store.
    pub(crate) chat: ChatTools,
}

/// Chat function-tool services. Grouped so the many test states add one
/// line instead of three.
pub(crate) struct ChatTools {
    /// None = no provider configured: the web routes answer
    /// "provider_unavailable" instead of guessing a provider.
    pub(crate) web_search: Option<crate::web_search::WebSearchService>,
    pub(crate) memory: Mutex<crate::storage::memory::MemoryStore>,
    pub(crate) memory_limits: crate::config::MemoryConfig,
}

impl ChatTools {
    /// Real wiring from config; memory gets its own database file.
    pub(crate) fn build(
        config: &crate::config::Config,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let memory = crate::storage::memory::MemoryStore::new(crate::storage::open_file(
            std::path::Path::new(&config.data_dir),
            crate::storage::DbRole::Memory,
        )?)?;
        Ok(Self {
            web_search: config
                .web_search
                .as_ref()
                .map(crate::web_search::service_from_config),
            memory: Mutex::new(memory),
            memory_limits: config.memory.unwrap_or_default(),
        })
    }

    /// No providers, in-memory store, default bounds: for test states.
    #[cfg(test)]
    pub(crate) fn for_tests() -> Self {
        Self {
            web_search: None,
            memory: Mutex::new(
                crate::storage::memory::MemoryStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            memory_limits: crate::config::MemoryConfig::default(),
        }
    }
}

/// All HTTP routes over one shared state.
pub fn routes(state: Arc<ApiState>) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health::health))
        .route("/v1/models", get(models::list_models))
        .route(
            "/v1/chat/completions",
            axum::routing::post(inference::chat_completions),
        )
        .route("/v1/chat/search", post(web::search))
        .route("/v1/chat/read-source", post(web::read_source))
        .route("/v1/chat/memory/recall", post(memory::recall))
        .route("/v1/chat/memory/save", post(memory::save))
        .route("/v1/chat/memory/edit", post(memory::edit))
        .route("/v1/chat/memory/delete", post(memory::delete))
        .route("/v1/management/pools", get(management::list_pools))
        .route(
            "/v1/management/pools/{name}",
            get(management::get_pool)
                .put(management::put_pool)
                .delete(management::delete_pool),
        )
        .route("/v1/management/providers", get(management::list_providers))
        .route("/v1/management/models", get(management::list_catalog))
        .route(
            "/v1/management/models/knowledge/summaries",
            post(management::knowledge_summaries),
        )
        .route(
            "/v1/management/providers/{provider_id}/models",
            get(management::get_provider_models),
        )
        .route(
            "/v1/management/observations",
            get(management::latest_observations),
        )
        .route("/v1/management/requests", get(management::list_requests))
        .route(
            "/v1/management/requests/activity",
            get(management::request_activity),
        )
        .route("/v1/management/running", get(management::list_running))
        .route("/v1/management/usage", get(management::usage_buckets))
        .route("/v1/management/usage/spend", get(management::usage_spend))
        .route("/v1/management/bans", get(management::list_bans))
        .route("/v1/management/refresh", post(management::post_refresh))
        .route(
            "/v1/management/models/knowledge",
            get(management::get_model_knowledge).post(management::post_model_knowledge),
        )
        .route(
            "/v1/management/models/knowledge/research",
            get(management::get_model_research)
                .post(management::post_model_research)
                .delete(management::delete_model_research),
        )
        .route("/v1/management/events", get(management::list_events))
        .with_state(state)
}

/// Authorization: one Bearer secret of any configured client key.
pub(crate) fn bearer_secret(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(axum::http::header::AUTHORIZATION)?
        .to_str()
        .ok()?;
    let secret = value.strip_prefix("Bearer ")?;
    if secret.is_empty() {
        return None;
    }
    Some(secret.to_owned())
}

pub(crate) fn internal_error(message: &str) -> Response {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, "api_error", message)
}

/// OpenAI-shaped error body; the message never carries credentials.
pub(crate) fn api_error(status: StatusCode, kind: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "type": kind, "message": message } })),
    )
        .into_response()
}
