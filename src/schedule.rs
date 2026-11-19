// Periodic data collection: background refresh of the
// dynamic model catalog. A failed poll never wipes the last snapshot, and
// no lock is held across network calls.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::api::ApiState;
use crate::config::StaticModel;
use crate::provider::ProviderRegistry;
use crate::provider::driver::CatalogMode;
use crate::storage::catalog::{ModelStore, NewModel};
use crate::storage::events::event_kind;
use serde_json::json;

/// Outcome of the most recent catalog refresh for one connection. Kept in
/// RAM for management reads; not persisted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RefreshStatus {
    pub last_success_unix: Option<i64>,
    pub last_error: Option<String>,
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        // A clock before the epoch breaks ids and history anyway; the
        // observation timestamp is the least of the damage.
        .unwrap_or(0)
}

/// Write the config-declared catalog for one connection without a dynamic
/// catalog endpoint. Called once at startup: YAML changes need a restart.
pub fn seed_static_catalog(
    provider_id: &str,
    models: &[StaticModel],
    observed_at_unix: i64,
    store: &mut ModelStore,
) -> Result<(), crate::storage::StorageError> {
    let snapshot = models
        .iter()
        .map(|m| NewModel {
            upstream_id: m.upstream_id.clone(),
            context_tokens: m.context_tokens,
            observed_at_unix,
        })
        .collect();
    store.replace_snapshot(provider_id, snapshot)
}

/// Seed every static-catalog connection into the model store.
pub fn seed_all_static_catalogs(
    registry: &ProviderRegistry,
    store: &mut ModelStore,
) -> Result<(), crate::storage::StorageError> {
    let observed_at_unix = now_unix();
    for (id, provider) in registry.connections() {
        if provider.driver().catalog_mode() == CatalogMode::Dynamic {
            continue;
        }
        seed_static_catalog(
            id.as_str(),
            provider.static_models(),
            observed_at_unix,
            store,
        )?;
    }
    Ok(())
}

/// Refresh the dynamic catalog of every connection. Network calls run with
/// no lock held; the catalog mutex is taken only for the snapshot write,
/// and a failed poll leaves the previous snapshot in force.
pub async fn refresh_catalogs(state: &ApiState) {
    for (id, provider) in state.providers.connections() {
        if provider.driver().catalog_mode() != CatalogMode::Dynamic {
            continue;
        }
        let result = provider.driver().fetch_catalog().await;
        let observed_at_unix = now_unix();
        // Locks are taken only after the await: never across the network.
        let stored = match result {
            Ok(discovered) => state
                .models
                .lock()
                .unwrap()
                .replace_snapshot(
                    id.as_str(),
                    discovered
                        .into_iter()
                        .map(|m| NewModel {
                            upstream_id: m.upstream_id,
                            context_tokens: m.context_tokens,
                            observed_at_unix,
                        })
                        .collect(),
                )
                .map_err(|e| format!("store: {e}")),
            Err(e) => Err(e.message),
        };
        let mut statuses = state.catalog_refresh.lock().unwrap();
        let entry = statuses.entry(id.clone()).or_default();
        match stored {
            Ok(()) => {
                entry.last_success_unix = Some(observed_at_unix);
                entry.last_error = None;
            }
            Err(message) => {
                entry.last_error = Some(message.clone());
                emit(
                    state,
                    event_kind::CATALOG_ERROR,
                    Some(id.as_str()),
                    &json!({ "error": message }),
                );
            }
        }
    }
}

/// Run the refresh loop in the background at the configured interval. The
/// initial refresh already ran before the listener was bound. Every tick
/// also sweeps expired bans into the event log and enforces retention.
pub fn spawn(state: Arc<ApiState>, interval: Duration, retention: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(interval);
        tick.tick().await; // completes immediately; the first real refresh follows
        let mut ban_sweep = BanSweep::default();
        loop {
            refresh_catalogs(&state).await;
            refresh_observations(&state).await;
            ban_sweep.tick(&state);
            purge_retention(&state, retention);
            tick.tick().await;
        }
    });
}

/// Collect one round of balance indicators and local engine states. Both
/// come from the drivers themselves; a driver that reports none (or fails)
/// simply stores nothing for this round — an error never deletes the last
/// observation.
pub async fn refresh_observations(state: &ApiState) {
    for (id, provider) in state.providers.connections() {
        match provider.driver().fetch_observations().await {
            Ok(Some(indicators)) => {
                let observed_at_unix = now_unix();
                // The lock is taken only after the await: never across the
                // network. A storage error is skipped, not turned into zeroes.
                let store = state.balances.lock().unwrap();
                for indicator in indicators {
                    let _ = store.append(&crate::storage::balances::Observation {
                        provider_id: id.as_str().to_owned(),
                        resource: indicator.resource,
                        metric: indicator.metric,
                        unit: indicator.unit,
                        limit: indicator.limit,
                        usage: indicator.usage,
                        remaining: indicator.remaining,
                        window: indicator.window,
                        resets_at_unix: indicator.resets_at_unix,
                        observed_at_unix,
                    });
                }
            }
            // No indicators is a supported state, not an event.
            Ok(None) => {}
            Err(e) => emit(
                state,
                event_kind::BALANCE_ERROR,
                Some(id.as_str()),
                &json!({ "error": e.message }),
            ),
        }
        if let Ok(Some(local)) = provider.driver().fetch_local_state().await {
            state.providers.update_local_state(&id, local);
        }
    }
}

/// Append one system event; a failing event write must not fail the
/// operation that caused it.
pub(crate) fn emit(
    state: &ApiState,
    kind: &str,
    provider_id: Option<&str>,
    detail: &serde_json::Value,
) {
    let now = now_unix();
    if let Err(e) = state.events.record(now, kind, provider_id, detail) {
        eprintln!("[events] {e}");
    }
}

/// Notices bans that lapsed since the previous tick and emits
/// `ban_expired`. The first tick after a restart seeds silently: a ban that
/// expired while the process was down must not get a fabricated
/// "expired now" event.
#[derive(Default)]
struct BanSweep {
    seen_expired: Option<HashSet<(String, String)>>,
}
impl BanSweep {
    fn tick(&mut self, state: &ApiState) {
        let all = match state.router.bans().all_bans() {
            Ok(all) => all,
            Err(e) => return eprintln!("[events] {e}"),
        };
        let now = now_unix();
        let expired: HashSet<(String, String)> = all
            .iter()
            .filter(|b| b.expires_at_unix <= now)
            .map(|b| (b.provider_id.clone(), b.upstream_id.clone()))
            .collect();
        let seen = self.seen_expired.get_or_insert_with(|| expired.clone());
        for (provider_id, upstream_id) in expired.difference(seen) {
            emit(
                state,
                event_kind::BAN_EXPIRED,
                Some(provider_id),
                &json!({ "upstream_id": upstream_id }),
            );
        }
        *seen = expired;
    }
}

/// Enforce the history retention window: requests, attempts and system
/// events older than `retention` are deleted. Runs every tick — the DELETE
/// normally removes nothing and touches only timestamp columns.
fn purge_retention(state: &ApiState, retention: Duration) {
    let cutoff = now_unix() - retention.as_secs() as i64;
    let purged_requests = match state.history.lock() {
        Ok(mut history) => history.purge_older_than(cutoff).unwrap_or_else(|e| {
            eprintln!("[retention] {e}");
            0
        }),
        Err(_) => 0,
    };
    let purged_events = state.events.purge_older_than(cutoff).unwrap_or_else(|e| {
        eprintln!("[retention] {e}");
        0
    });
    let purged_balances = state
        .balances
        .lock()
        .unwrap()
        .purge_older_than(cutoff)
        .unwrap_or_else(|e| {
            eprintln!("[retention] {e}");
            0
        });
    if purged_requests + purged_events + purged_balances > 0 {
        emit(
            state,
            event_kind::RETENTION_PURGED,
            None,
            &json!({
                "requests": purged_requests,
                "events": purged_events,
                "balances": purged_balances,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderId;

    #[tokio::test]
    async fn observations_and_local_state_land_in_their_stores() {
        use crate::config::{ClientKey, DriverKind, HttpTimeouts, ProviderConfig};
        use crate::metamodel::MetamodelService;
        use crate::routing::Router;
        use crate::storage::bans::BanStore;
        use crate::storage::pools::PoolStore;
        use std::sync::Mutex;

        let server = wiremock::MockServer::start().await;
        // DeepSeek balance endpoint (ZAI reports no indicators, so only this
        // one connection contributes observations).
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/user/balance"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "is_available": true,
                    "balance_infos": [
                        {"currency": "CNY", "total_balance": "110.00"},
                        {"currency": "USD", "total_balance": "12.50"}
                    ]
                })),
            )
            .mount(&server)
            .await;
        // Strata status endpoint for the local engine.
        let strata = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/status"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "model": "strata-32b",
                    "loaded": true,
                    "concurrency": {"serving": 7}
                })),
            )
            .mount(&strata)
            .await;

        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let providers = ProviderRegistry::build(
            &[
                ProviderConfig {
                    provider_id: "deepseek".into(),
                    driver: DriverKind::Deepseek,
                    base_url: format!("{}/v1", server.uri()),
                    api_key: Some("deepseek-key".into()),
                    static_models: Vec::new(),
                },
                ProviderConfig {
                    provider_id: "strata".into(),
                    driver: DriverKind::Strata,
                    base_url: format!("{}/v1", strata.uri()),
                    api_key: None,
                    static_models: Vec::new(),
                },
            ],
            HttpTimeouts::default(),
        )
        .unwrap();
        let (history, history_writer) = crate::api::tests_support::history_pair("schedule");
        let state = Arc::new(ApiState {
            started_at_unix: 1,
            keys: crate::api::auth::KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "s".into(),
            }]),
            providers,
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
        });

        refresh_observations(&state).await;

        let balances = state
            .balances
            .lock()
            .unwrap()
            .latest(Some("deepseek"))
            .unwrap();
        assert_eq!(balances.len(), 2);
        let cny = balances
            .iter()
            .find(|o| o.unit.as_deref() == Some("CNY"))
            .expect("CNY balance observation");
        assert_eq!(cny.remaining, Some("110.00".to_owned()));
        assert!(cny.observed_at_unix > 0);

        let local = state
            .providers
            .local_state(&ProviderId::new("strata"))
            .expect("local state was collected");
        assert_eq!(local.model.as_deref(), Some("strata-32b"));
        assert_eq!(local.loaded, Some(true));
        assert_eq!(local.slots, Some(7));
    }

    #[tokio::test]
    async fn a_failing_state_probe_collects_nothing() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/v1/status"))
            .respond_with(wiremock::ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let state = state_with_local(
            crate::config::DriverKind::Strata,
            &format!("{}/v1", server.uri()),
        )
        .await;

        refresh_observations(&state).await;

        // A failed probe must not invent a state of zeroes or a panic.
        assert!(
            state
                .providers
                .local_state(&ProviderId::new("local"))
                .is_none()
        );
    }

    /// A local-engine registry for observation tests.
    async fn state_with_local(kind: crate::config::DriverKind, base_url: &str) -> Arc<ApiState> {
        use crate::config::{ClientKey, HttpTimeouts, ProviderConfig};
        use crate::metamodel::MetamodelService;
        use crate::routing::Router;
        use crate::storage::bans::BanStore;
        use crate::storage::pools::PoolStore;
        use std::sync::Mutex;

        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let providers = ProviderRegistry::build(
            &[ProviderConfig {
                provider_id: "local".into(),
                driver: kind,
                base_url: base_url.to_owned(),
                api_key: None,
                static_models: Vec::new(),
            }],
            HttpTimeouts::default(),
        )
        .unwrap();
        let (history, history_writer) = crate::api::tests_support::history_pair("schedule");
        Arc::new(ApiState {
            started_at_unix: 1,
            keys: crate::api::auth::KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "s".into(),
            }]),
            providers,
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
        })
    }

    #[tokio::test]
    async fn refresh_stores_snapshot_and_reports_success() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "data": [{"id": "glm-5.3"}]
                })),
            )
            .mount(&server)
            .await;
        let state = state_with_zai(&server).await;

        refresh_catalogs(&state).await;

        let stored = state.models.lock().unwrap().list("main").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].upstream_id, "glm-5.3");
        let status = state
            .catalog_refresh
            .lock()
            .unwrap()
            .get(&ProviderId::new("main"))
            .cloned()
            .unwrap();
        assert!(status.last_success_unix.is_some());
        assert_eq!(status.last_error, None);
    }

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_last_snapshot_and_the_success_time() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [{"id": "glm-5.3"}]})),
            )
            .mount(&server)
            .await;
        let state = state_with_zai(&server).await;

        refresh_catalogs(&state).await;
        let first = state
            .catalog_refresh
            .lock()
            .unwrap()
            .get(&ProviderId::new("main"))
            .cloned()
            .unwrap();
        // Then the endpoint goes dark; the snapshot must survive.
        server.reset().await;
        wiremock::Mock::given(wiremock::matchers::method("GET"))
            .and(wiremock::matchers::path("/models"))
            .respond_with(wiremock::ResponseTemplate::new(503))
            .mount(&server)
            .await;
        refresh_catalogs(&state).await;
        let second = state
            .catalog_refresh
            .lock()
            .unwrap()
            .get(&ProviderId::new("main"))
            .cloned()
            .unwrap();

        // A failed poll is not an empty catalog.
        let stored = state.models.lock().unwrap().list("main").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].upstream_id, "glm-5.3");
        assert_eq!(second.last_success_unix, first.last_success_unix);
        assert!(second.last_error.is_some());
        // Only the failure is an event; the recovery just clears
        // `last_error` in the refresh status (Providers page).
        let events = state.events.list(10).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["catalog_error"]);
        let detail: serde_json::Value =
            serde_json::from_str(events[0].detail.as_deref().unwrap()).unwrap();
        assert!(detail["error"].as_str().unwrap().contains("503"));
    }

    #[tokio::test]
    async fn retention_purge_reports_what_it_deleted() {
        let server = wiremock::MockServer::start().await;
        let st = state_with_zai(&server).await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        // One expired request with its attempt, one expired event, and one
        // fresh event that must survive.
        st.history
            .lock()
            .unwrap()
            .insert_summaries(&[crate::history::RequestSummary {
                id: "r1".into(),
                key_alias: "k".into(),
                metamodel: "m".into(),
                started_at_unix: now - 10_000,
                finished_at_unix: now - 9_000,
                outcome: "ok".into(),
                input: None,
                declared_tools: None,
                issues: Vec::new(),
                attempts: Vec::new(),
            }])
            .unwrap();
        st.events
            .record(now - 10_000, "ban_recorded", None, &serde_json::json!({}))
            .unwrap();
        st.events
            .record(now, "ban_expired", None, &serde_json::json!({}))
            .unwrap();

        purge_retention(&st, std::time::Duration::from_secs(5_000));

        let events = st.events.list(10).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["retention_purged", "ban_expired"]);
        let detail: serde_json::Value =
            serde_json::from_str(events[0].detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["requests"], 1);
        assert_eq!(detail["events"], 1);
    }

    #[tokio::test]
    async fn ban_sweep_reports_each_expiry_once() {
        let state =
            state_with_local(crate::config::DriverKind::LlamaCpp, "http://127.0.0.1:9").await;
        let now = now_unix();
        // A ban that lapsed before the first sweep only seeds the state —
        // no fabricated "expired now" event after a restart.
        state
            .router
            .bans()
            .record("p", "m1", "overloaded", now - 10)
            .unwrap();
        let mut sweep = BanSweep::default();
        sweep.tick(&state);
        assert!(state.events.list(10).unwrap().is_empty());
        // A pair that becomes expired after the seed is reported once.
        state
            .router
            .bans()
            .record("p", "m2", "quota exhausted", now - 5)
            .unwrap();
        sweep.tick(&state);
        let events = state.events.list(10).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "ban_expired");
        assert_eq!(events[0].provider_id.as_deref(), Some("p"));
        sweep.tick(&state);
        assert_eq!(state.events.list(10).unwrap().len(), 1);
    }

    /// One dynamic Z.AI connection against a mock upstream, with real
    /// in-memory databases — the same shape App::build produces.
    async fn state_with_zai(server: &wiremock::MockServer) -> Arc<ApiState> {
        use crate::config::{ClientKey, HttpTimeouts, ProviderConfig};
        use crate::metamodel::MetamodelService;
        use crate::routing::Router;
        use crate::storage::bans::BanStore;
        use crate::storage::pools::PoolStore;
        use std::sync::Mutex;

        let conn = || rusqlite::Connection::open_in_memory().unwrap();
        let providers = ProviderRegistry::build(
            &[ProviderConfig {
                provider_id: "main".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("zai-key".into()),
                static_models: Vec::new(),
            }],
            HttpTimeouts::default(),
        )
        .unwrap();
        let (history, history_writer) = crate::api::tests_support::history_pair("schedule");
        Arc::new(ApiState {
            started_at_unix: 1,
            keys: crate::api::auth::KeyAuthenticator::new(vec![ClientKey {
                alias: "test".into(),
                secret: "s".into(),
            }]),
            providers,
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
        })
    }

    #[test]
    fn static_catalog_is_seeded_verbatim() {
        let mut store = ModelStore::new(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let models = vec![
            StaticModel {
                upstream_id: "llama-3".into(),
                context_tokens: Some(131_072),
            },
            StaticModel {
                upstream_id: "llama-3:8b".into(),
                context_tokens: None,
            },
        ];
        seed_static_catalog("local-llama", &models, 42, &mut store).unwrap();

        let stored = store.list("local-llama").unwrap();
        assert_eq!(
            stored
                .iter()
                .map(|m| m.upstream_id.as_str())
                .collect::<Vec<_>>(),
            ["llama-3", "llama-3:8b"]
        );
    }

    #[test]
    fn static_reseeding_replaces_the_previous_snapshot() {
        let mut store = ModelStore::new(rusqlite::Connection::open_in_memory().unwrap()).unwrap();
        let models = |upstream_id: &str| {
            vec![StaticModel {
                upstream_id: upstream_id.into(),
                context_tokens: None,
            }]
        };
        seed_static_catalog("local-llama", &models("old"), 42, &mut store).unwrap();
        seed_static_catalog("local-llama", &models("new"), 43, &mut store).unwrap();

        let stored = store.list("local-llama").unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].upstream_id, "new");
    }
}
