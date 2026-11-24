// GET /v1/models — the OpenAI-style model list. Metamodels are the
// client-facing models; providers and pool members are never exposed.

use std::collections::HashMap;
use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use super::{ApiState, api_error, bearer_secret, internal_error};

use crate::metamodel::Metamodel;
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
        let (max_output, pricing) = card_facts(&state, metamodel);
        if let Some(tokens) = max_output {
            model["max_output_tokens"] = json!(tokens);
        }
        if let Some(pricing) = pricing {
            model["pricing"] = pricing;
        }
        data.push(model);
    }

    (
        StatusCode::OK,
        Json(json!({ "object": "list", "data": data })),
    )
        .into_response()
}

/// What the members' cards say about a pool, read as `context_length` is:
/// the smallest limit among the members that have one. A member without a
/// card does not lower the output limit. A price is given only when every
/// member has one and they are all the same: a fallback may cost otherwise,
/// and a wrong price is worse than none.
fn card_facts(state: &ApiState, metamodel: &Metamodel) -> (Option<u64>, Option<Value>) {
    // Dollars per million tokens: input, output and, when known, cached input.
    type Price = (f64, f64, Option<f64>);
    let mut max_output: Option<u64> = None;
    // None once a member turns out to have no price of its own.
    let mut prices: Option<Vec<Price>> = Some(Vec::new());
    let mut cards: HashMap<String, Option<Value>> = HashMap::new();
    for member in metamodel.members() {
        let key = crate::model::knowledge_key(member.upstream());
        if !cards.contains_key(&key) {
            let card = state
                .knowledge
                .get(&key)
                .ok()
                .flatten()
                .and_then(|stored| serde_json::from_str(&stored.card_json).ok());
            cards.insert(key.clone(), card);
        }
        let card = cards[&key].as_ref();
        if let Some(tokens) = card
            .and_then(|card| card.get("max_output_tokens"))
            .and_then(Value::as_u64)
        {
            max_output = Some(max_output.map_or(tokens, |known| known.min(tokens)));
        }
        match (&mut prices, card.and_then(price_per_million)) {
            (Some(list), Some(price)) => list.push(price),
            _ => prices = None,
        }
    }
    let pricing = prices.and_then(|list| {
        let first = list.first()?;
        list.iter().all(|price| price == first).then(|| {
            let mut pricing = json!({
                "input": first.0,
                "output": first.1,
                "unit": "per_1m_tokens",
            });
            if let Some(cached) = first.2 {
                pricing["cache_read"] = json!(cached);
            }
            pricing
        })
    });
    (max_output, pricing)
}

/// A card's price when it is in USD and names both an input and an output
/// price.
fn price_per_million(card: &Value) -> Option<(f64, f64, Option<f64>)> {
    let pricing = card.get("pricing")?;
    if pricing.get("currency").and_then(Value::as_str) != Some("USD") {
        return None;
    }
    Some((
        pricing.get("input_per_1m")?.as_f64()?,
        pricing.get("output_per_1m")?.as_f64()?,
        pricing.get("cached_input_per_1m").and_then(Value::as_f64),
    ))
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

    /// A card as the core stores it, with the two facts the list reads.
    fn card(st: &Arc<ApiState>, key: &str, max_output_tokens: u64, pricing: Value) {
        st.knowledge
            .upsert(&crate::storage::knowledge::NewCard {
                key: key.into(),
                card_json: json!({
                    "description": "a model",
                    "sources": ["https://example.test/model"],
                    "max_output_tokens": max_output_tokens,
                    "pricing": pricing,
                })
                .to_string(),
                collected_at_unix: 1,
                generator: "test".into(),
            })
            .unwrap();
    }

    fn usd(input: f64, cached_input: Option<f64>, output: f64) -> Value {
        json!({
            "currency": "USD",
            "input_per_1m": input,
            "cached_input_per_1m": cached_input,
            "output_per_1m": output,
        })
    }

    /// The listed entry of one pool.
    fn entry(body: &Value, name: &str) -> Value {
        body["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["id"] == name)
            .cloned()
            .unwrap_or_else(|| panic!("{name} is not listed"))
    }

    #[tokio::test]
    async fn max_output_tokens_is_the_minimum_of_known_limits() {
        let st = state(vec![]);
        card(&st, "big", 200_000, usd(1.4, Some(0.26), 0.016));
        card(&st, "small", 32_768, usd(0.0, Some(0.0), 0.0));
        create_metamodel(&st, "pool", &[("p", "big"), ("p", "small"), ("p", "ghost")]);
        create_metamodel(&st, "blind", &[("p", "ghost")]);
        let (_, body) = get_models(&st, Some("secret-one")).await;
        // A member without a card does not lower the limit, as with the context.
        assert_eq!(entry(&body, "pool")["max_output_tokens"], 32_768);
        assert!(entry(&body, "blind").get("max_output_tokens").is_none());
        // One member too many without a price: the pool names none.
        assert!(entry(&body, "pool").get("pricing").is_none());
    }

    #[tokio::test]
    async fn pricing_is_given_only_when_every_member_costs_the_same() {
        let st = state(vec![]);
        card(&st, "big", 1, usd(1.4, Some(0.26), 0.016));
        card(&st, "small", 1, usd(0.0, None, 0.0));
        card(
            &st,
            "euro",
            1,
            json!({ "currency": "EUR", "input_per_1m": 1.0, "cached_input_per_1m": null, "output_per_1m": 2.0 }),
        );
        // One model behind two spellings of its name: one card.
        create_metamodel(&st, "same", &[("p", "vendor/big"), ("p", "big:free")]);
        create_metamodel(&st, "mixed", &[("p", "big"), ("p", "small")]);
        create_metamodel(&st, "unknown", &[("p", "big"), ("p", "ghost")]);
        create_metamodel(&st, "euro", &[("p", "euro")]);
        let (_, body) = get_models(&st, Some("secret-one")).await;
        assert_eq!(
            entry(&body, "same")["pricing"],
            json!({ "input": 1.4, "output": 0.016, "cache_read": 0.26, "unit": "per_1m_tokens" })
        );
        assert_eq!(entry(&body, "same")["max_output_tokens"], 1);
        for name in ["mixed", "unknown", "euro"] {
            assert!(entry(&body, name).get("pricing").is_none(), "{name}");
        }
        // Free is a price too, when all of the pool is free.
        create_metamodel(&st, "free", &[("p", "small")]);
        let (_, body) = get_models(&st, Some("secret-one")).await;
        assert_eq!(
            entry(&body, "free")["pricing"],
            json!({ "input": 0.0, "output": 0.0, "unit": "per_1m_tokens" })
        );
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
