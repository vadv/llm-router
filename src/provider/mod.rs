// Provider connections, drivers, and the registry. A Provider owns one
// configured connection (driver instance + credentials); routing and
// metamodels never see the driver's internals.
pub mod driver;
pub mod drivers;
pub mod knowledge;

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use crate::config::{DriverKind, HttpTimeouts, ProviderConfig, StaticModel};
use crate::model::ProviderId;

use driver::Driver;
use drivers::deepseek::DeepSeekDriver;
use drivers::kimi::KimiDriver;
use drivers::local::{LocalEngineDriver, LocalKind};
use drivers::openaicompat::OpenAiCompatDriver;
use drivers::opencode::OpenCodeDriver;
use drivers::openrouter::OpenRouterDriver;
use drivers::tokenator::TokenatorDriver;
use drivers::workbuddy::WorkBuddyDriver;
use drivers::zai::ZaiDriver;

/// One configured connection: identity, a driver instance holding the
/// credentials, and the config-side catalog source for static drivers.
/// Pools, sessions, bans and request history live outside this module.
pub struct Provider {
    reported_cost_unit: Option<&'static str>,
    driver: Arc<dyn Driver>,
    static_models: Vec<StaticModel>,
}

impl Provider {
    pub fn reported_cost_unit(&self) -> Option<&'static str> {
        self.reported_cost_unit
    }
    pub fn driver(&self) -> &dyn Driver {
        &*self.driver
    }

    /// Config-declared models, the catalog for drivers without a catalog
    /// endpoint. Empty for dynamic drivers; the sources are never merged.
    pub fn static_models(&self) -> &[StaticModel] {
        &self.static_models
    }
}

/// All configured connections, looked up by id. Same driver code can serve
/// several Providers with different credentials. It owns no other app data
/// beyond the local engines' last reported state, which only schedule
/// writes and management reads.
pub struct ProviderRegistry {
    by_id: HashMap<ProviderId, Arc<Provider>>,
    /// Last reported state per local engine; RAM only, restart resets it.
    /// Cloud connections never appear here.
    local_states: std::sync::Mutex<HashMap<ProviderId, driver::LocalState>>,
}

/// Startup failure: a provider entry cannot become a usable connection.
#[derive(Debug)]
pub struct ProviderBuildError(pub String);

impl fmt::Display for ProviderBuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "provider: {}", self.0)
    }
}
impl std::error::Error for ProviderBuildError {}

impl ProviderRegistry {
    /// Construct one connection per config entry. Any unusable entry fails
    /// startup outright: a partially built registry is never served.
    pub fn build(
        providers: &[ProviderConfig],
        http: HttpTimeouts,
    ) -> Result<Self, ProviderBuildError> {
        let mut by_id = HashMap::new();
        for config in providers {
            let id = ProviderId::new(config.provider_id.clone());
            if by_id.contains_key(&id) {
                return Err(ProviderBuildError(format!(
                    "duplicate provider id '{}'",
                    config.provider_id
                )));
            }
            let driver: Arc<dyn Driver> = match config.driver {
                DriverKind::Zai => Arc::new(ZaiDriver::new(
                    &config.base_url,
                    // The key exists only here and in the driver; it never
                    // reaches logs or error messages.
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (zai) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Mimo => Arc::new(drivers::mimo::MimoDriver::new(
                    &config.base_url,
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (mimo) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Alibaba | DriverKind::Nvidia => Arc::new(OpenAiCompatDriver::new(
                    &config.base_url,
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (openai-compat) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Deepseek => Arc::new(DeepSeekDriver::new(
                    &config.base_url,
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (deepseek) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Workbuddy => Arc::new(WorkBuddyDriver::new(
                    &config.base_url,
                    // The key exists only here and in the driver; it never
                    // reaches logs or error messages.
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (workbuddy) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::OpenRouter => Arc::new(OpenRouterDriver::new(
                    &config.base_url,
                    // The key exists only here and in the driver; it never
                    // reaches logs or error messages.
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (openrouter) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::OpenCode => Arc::new(OpenCodeDriver::new(
                    &config.base_url,
                    // The key exists only here and in the driver; it never
                    // reaches logs or error messages.
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (opencode) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Kimi => Arc::new(KimiDriver::new(
                    &config.base_url,
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (kimi) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::Tokenator => Arc::new(TokenatorDriver::new(
                    &config.base_url,
                    config.api_key.as_deref().ok_or_else(|| {
                        ProviderBuildError(format!(
                            "provider '{}' (tokenator) has no api_key",
                            config.provider_id
                        ))
                    })?,
                    http,
                )),
                DriverKind::LlamaCpp | DriverKind::Strata => {
                    // Local engines load the model on the first request after
                    // a wake; allow 300 s for this cold start.
                    let kind = match config.driver {
                        DriverKind::LlamaCpp => LocalKind::LlamaCpp,
                        _ => LocalKind::Strata,
                    };
                    let mut local_http = http;
                    local_http.first_byte = local_http
                        .first_byte
                        .max(std::time::Duration::from_secs(300));
                    Arc::new(LocalEngineDriver::new(
                        kind,
                        &config.base_url,
                        config.api_key.as_deref(),
                        local_http,
                    ))
                }
                kind => {
                    return Err(ProviderBuildError(format!(
                        "provider '{}': driver kind {kind:?} is not implemented yet",
                        config.provider_id
                    )));
                }
            };
            if driver.catalog_mode() == driver::CatalogMode::Dynamic
                && !config.static_models.is_empty()
            {
                return Err(ProviderBuildError(format!(
                    "provider '{}' mixes catalog sources: static_models on a \
                     dynamic-catalog driver are refused, never merged",
                    config.provider_id
                )));
            }
            by_id.insert(
                id,
                Arc::new(Provider {
                    reported_cost_unit: (config.driver == DriverKind::OpenRouter).then_some("USD"),
                    driver,
                    static_models: config.static_models.clone(),
                }),
            );
        }
        Ok(ProviderRegistry {
            by_id,
            local_states: std::sync::Mutex::new(HashMap::new()),
        })
    }

    pub fn get(&self, id: &ProviderId) -> Option<Arc<Provider>> {
        self.by_id.get(id).cloned()
    }

    /// Store a local engine's last reported state. Overwrites the previous
    /// one whole: an engine that stopped reporting a field reports it as
    /// unknown, not as the stale value.
    pub fn update_local_state(&self, id: &ProviderId, state: driver::LocalState) {
        self.local_states.lock().unwrap().insert(id.clone(), state);
    }

    /// The last reported state of a local engine, if any was collected.
    pub fn local_state(&self, id: &ProviderId) -> Option<driver::LocalState> {
        self.local_states.lock().unwrap().get(id).cloned()
    }

    /// All connections with their ids. Schedule iterates them; the list is
    /// small (one per config entry) so a Vec beats a borrow fight.
    pub fn connections(&self) -> Vec<(ProviderId, Arc<Provider>)> {
        self.by_id
            .iter()
            .map(|(id, p)| (id.clone(), p.clone()))
            .collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.by_id.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zai_config(id: &str, api_key: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            provider_id: id.into(),
            driver: DriverKind::Zai,
            base_url: "http://127.0.0.1:9".into(),
            api_key: api_key.map(str::to_owned),
            static_models: Vec::new(),
        }
    }

    #[test]
    fn the_shared_openai_compat_kinds_build_one_driver() {
        let config = |id: &str, driver| ProviderConfig {
            provider_id: id.into(),
            driver,
            base_url: "http://127.0.0.1:9".into(),
            api_key: Some("k".into()),
            static_models: Vec::new(),
        };
        let registry = ProviderRegistry::build(
            &[
                config("alibaba", DriverKind::Alibaba),
                config("mimo", DriverKind::Mimo),
                config("nvidia", DriverKind::Nvidia),
            ],
            HttpTimeouts::default(),
        )
        .unwrap();
        assert_eq!(registry.len(), 3);

        let mut without_key = config("nvidia", DriverKind::Nvidia);
        without_key.api_key = None;
        assert!(ProviderRegistry::build(&[without_key], HttpTimeouts::default()).is_err());
    }

    #[test]
    fn connections_are_found_by_id_and_share_driver_code() {
        let registry = ProviderRegistry::build(
            &[
                zai_config("primary", Some("k1")),
                zai_config("backup", Some("k2")),
            ],
            HttpTimeouts::default(),
        )
        .unwrap();
        assert_eq!(registry.len(), 2);

        let primary = registry.get(&ProviderId::new("primary")).unwrap();
        let backup = registry.get(&ProviderId::new("backup")).unwrap();
        // Same driver code, dynamic catalog, no config models.
        assert_eq!(
            primary.driver().catalog_mode(),
            driver::CatalogMode::Dynamic
        );
        assert!(primary.static_models().is_empty());
        assert!(backup.static_models().is_empty());
        assert!(registry.get(&ProviderId::new("absent")).is_none());
    }

    #[test]
    fn a_duplicate_id_is_refused() {
        let error = ProviderRegistry::build(
            &[zai_config("same", Some("k")), zai_config("same", Some("k"))],
            HttpTimeouts::default(),
        )
        .err()
        .unwrap();
        assert!(error.0.contains("duplicate provider id 'same'"));
    }

    #[test]
    fn a_missing_key_is_refused_with_the_provider_named() {
        let error = ProviderRegistry::build(&[zai_config("main", None)], HttpTimeouts::default())
            .err()
            .unwrap();
        assert!(error.0.contains("'main'"));
        assert!(error.0.contains("api_key"));
    }

    #[test]
    fn an_unimplemented_driver_kind_is_refused_with_both_names() {
        let mut config = zai_config("main", Some("k"));
        // The OpenAI kind is the still-unimplemented OAuth plan (kept for
        // the owner's decision record); it names the refusal path.
        config.driver = DriverKind::OpenAi;
        let error = ProviderRegistry::build(&[config], HttpTimeouts::default())
            .err()
            .unwrap();
        assert!(error.0.contains("'main'"));
        assert!(error.0.contains("not implemented"));
    }

    #[test]
    fn static_models_on_a_dynamic_driver_are_refused_not_merged() {
        let mut config = zai_config("main", Some("k"));
        config.static_models = vec![StaticModel {
            upstream_id: "glm-5.3".into(),
            context_tokens: None,
        }];
        let error = ProviderRegistry::build(&[config], HttpTimeouts::default())
            .err()
            .unwrap();
        assert!(error.0.contains("catalog sources"));
    }
}
