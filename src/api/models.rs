// GET /v1/models — the OpenAI-style model list. Metamodels are the
// client-facing models; providers and pool members are never exposed.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::{ApiState, api_error, bearer_secret, internal_error};

use crate::model::{CatalogError, ModelCatalog, ModelId, ProviderModel};

pub async fn list_models(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    // Authorization: one Bearer secret of any configured client key.
    let Some(secret) = bearer_secret(&headers) else {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "missing or invalid API key",
        );
    };
    if state.keys.authenticate(&secret).is_none() {
        return api_error(
            StatusCode::UNAUTHORIZED,
            "invalid_api_key",
            "missing or invalid API key",
        );
    }

    // A client plans before routing, so every configured metamodel is
    // listed — including ones whose members are banned right now.
    let metamodels = match state.metamodels.lock() {
        Ok(service) => service.list(),
        Err(_) => return internal_error("metamodel storage is unavailable"),
    };
    let metamodels = match metamodels {
        Ok(list) => list,
        Err(e) => return internal_error(&e.to_string()),
    };

    // Sorted ids keep the list deterministic across restarts for clients
    // and tests alike (pools have no inherent order between each other).
    let mut ids: Vec<String> = metamodels
        .iter()
        .map(|m| m.id().as_str().to_owned())
        .collect();
    ids.sort();

    let catalog = CatalogWithStatic {
        providers: &state.providers,
        models: &state.models,
    };
    let mut data = Vec::with_capacity(metamodels.len());
    for metamodel in &metamodels {
        let context = match metamodel.context_tokens(&catalog) {
            Ok(context) => context,
            Err(e) => return internal_error(&e.to_string()),
        };
        // None means unknown, not an unlimited context: the field is
        // omitted rather than zeroed.
        let mut model = json!({
            "id": metamodel.id().as_str(),
            "object": "model",
            "created": state.started_at_unix,
            "owned_by": "llm-router",
        });
        if let Some(tokens) = context {
            model["context_length"] = json!(tokens);
        }
        data.push(model);
    }

    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": data })),
    )
        .into_response()
}

/// The read-side catalog: the SQLite snapshot plus static config entries.
/// Consumers apply the domain rule (minimum of known context windows) over
/// both sources uniformly.
struct CatalogWithStatic<'a> {
    providers: &'a crate::provider::ProviderRegistry,
    models: &'a std::sync::Mutex<crate::storage::catalog::ModelStore>,
}

impl ModelCatalog for CatalogWithStatic<'_> {
    fn find(&self, id: &ModelId) -> Result<Option<ProviderModel>, CatalogError> {
        let Some(provider) = self.providers.get(id.provider()) else {
            return Ok(None);
        };
        if let Some(static_model) = provider
            .static_models()
            .iter()
            .find(|m| m.upstream_id == id.upstream())
        {
            return Ok(Some(ProviderModel {
                id: id.clone(),
                context_tokens: static_model.context_tokens,
                // Config, not observation: no observation time exists for a
                // static entry. Consumers here read only the context window.
                observed_at_unix: 0,
            }));
        }
        let models = self
            .models
            .lock()
            .map_err(|_| CatalogError("catalog is unavailable".into()))?;
        models
            .find(id.provider().as_str(), id.upstream())
            .map(|found| {
                found.map(|m| ProviderModel {
                    id: id.clone(),
                    context_tokens: m.context_tokens,
                    observed_at_unix: m.observed_at_unix,
                })
            })
            .map_err(|e| CatalogError(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use serde_json::Value;

    use crate::metamodel::{Metamodel, MetamodelId, MetamodelService};

    use crate::api::auth::KeyAuthenticator;
    use crate::config::{ClientKey, HttpTimeouts, ProviderConfig};

    use crate::model::ProviderId;
    use crate::provider::ProviderRegistry;
    use crate::routing::Router;
    use crate::storage::bans::BanStore;
    use crate::storage::catalog::{ModelStore, NewModel};
    use crate::storage::pools::PoolStore;

    fn state(snapshot: Vec<NewModel>) -> Arc<ApiState> {
        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let providers = ProviderRegistry::build(
            &[ProviderConfig {
                provider_id: "p".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: "http://upstream".into(),
                api_key: Some("upstream-key".into()),
                static_models: Vec::new(),
            }],
            HttpTimeouts::default(),
        )
        .unwrap();
        let (history, history_writer) = crate::api::tests_support::history_pair("models");
        let mut models = ModelStore::new(conn()).unwrap();
        if !snapshot.is_empty() {
            models.replace_snapshot("p", snapshot).unwrap();
        }
        Arc::new(ApiState {
            started_at_unix: 1_700_000_000,
            keys: KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "secret-one".into(),
            }]),
            providers,
            router: Router::new(
                BanStore::new(conn()).unwrap(),
                crate::config::BanPolicy::default(),
                crate::config::RetryPolicy::default(),
            ),
            metamodels: Mutex::new(MetamodelService::new(PoolStore::new(conn()).unwrap())),
            models: Mutex::new(models),
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

    fn create_metamodel(st: &ApiState, name: &str, members: &[(&str, &str)]) {
        let members: Vec<ModelId> = members
            .iter()
            .map(|(p, m)| ModelId::new(ProviderId::new(p.to_string()), m.to_string()))
            .collect();
        st.metamodels
            .lock()
            .unwrap()
            .create(Metamodel::new(MetamodelId::new(name), members).unwrap())
            .unwrap();
    }

    /// Serve this state on an ephemeral port and GET /v1/models.
    async fn get_models(st: &Arc<ApiState>, secret: Option<&str>) -> (u16, Value) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = super::super::routes(Arc::clone(st));
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut request = reqwest::Client::new().get(format!("http://{addr}/v1/models"));
        if let Some(secret) = secret {
            request = request.header("authorization", format!("Bearer {secret}"));
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let body = response.json().await.unwrap_or(Value::Null);
        (status, body)
    }

    #[tokio::test]
    async fn the_list_is_sorted_and_openai_shaped() {
        let st = state(vec![]);
        create_metamodel(&st, "b-pool", &[("p", "m1")]);
        create_metamodel(&st, "a-pool", &[("p", "m2")]);
        let (status, body) = get_models(&st, Some("secret-one")).await;
        assert_eq!(status, 200);
        assert_eq!(body["object"], "list");
        let data = body["data"].as_array().unwrap();
        let ids: Vec<&str> = data.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["a-pool", "b-pool"]);
        assert_eq!(data[0]["object"], "model");
        assert_eq!(data[0]["owned_by"], "llm-router");
        assert_eq!(data[0]["created"], 1_700_000_000);
    }

    #[tokio::test]
    async fn context_length_is_the_minimum_of_known_windows() {
        let st = state(vec![
            NewModel {
                upstream_id: "big".into(),
                context_tokens: Some(200_000),
                observed_at_unix: 1,
            },
            NewModel {
                upstream_id: "small".into(),
                context_tokens: Some(8_000),
                observed_at_unix: 1,
            },
        ]);
        create_metamodel(&st, "pool", &[("p", "big"), ("p", "small")]);
        let (_, body) = get_models(&st, Some("secret-one")).await;
        assert_eq!(body["data"][0]["context_length"], 8_000);
    }

    #[tokio::test]
    async fn context_length_is_omitted_when_nothing_is_known() {
        let st = state(vec![]);
        create_metamodel(&st, "pool", &[("p", "ghost")]);
        let (_, body) = get_models(&st, Some("secret-one")).await;
        assert!(body["data"][0].get("context_length").is_none());
    }

    #[tokio::test]
    async fn a_missing_or_wrong_key_is_401() {
        let st = state(vec![]);
        let (status, _) = get_models(&st, None).await;
        assert_eq!(status, 401);
        let (status, _) = get_models(&st, Some("wrong-secret")).await;
        assert_eq!(status, 401);
    }

    #[tokio::test]
    async fn an_empty_configuration_yields_an_empty_list() {
        let st = state(vec![]);
        let (status, body) = get_models(&st, Some("secret-one")).await;
        assert_eq!(status, 200);
        assert_eq!(body["data"].as_array().unwrap().len(), 0);
    }
}
