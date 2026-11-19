//! YAML config: providers, client keys, timeouts, intervals, retention.
//! Read at startup. Changes take effect after a restart.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// Driver that speaks the provider protocol. The set of names is fixed by code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverKind {
    OpenAi,
    Kimi,
    Zai,
    Alibaba,
    Mimo,
    Nvidia,
    OpenRouter,
    OpenCode,
    Tokenator,
    Workbuddy,
    LlamaCpp,
    Strata,
    Deepseek,
}

impl DriverKind {
    fn from_config(s: &str) -> Option<Self> {
        Some(match s {
            "openai" => Self::OpenAi,
            "kimi" => Self::Kimi,
            "zai" => Self::Zai,
            "alibaba" => Self::Alibaba,
            "mimo" => Self::Mimo,
            "nvidia" => Self::Nvidia,
            "openrouter" => Self::OpenRouter,
            "opencode" => Self::OpenCode,
            "tokenator" => Self::Tokenator,
            "workbuddy" => Self::Workbuddy,
            "llamacpp" => Self::LlamaCpp,
            "strata" => Self::Strata,
            "deepseek" => Self::Deepseek,
            _ => return None,
        })
    }
}

/// One provider connection. Secrets stay here and never go to logs or history.
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub provider_id: String,
    pub driver: DriverKind,
    pub base_url: String,
    pub api_key: Option<String>,
    /// Models for drivers without a dynamic catalog.
    pub static_models: Vec<StaticModel>,
}

#[derive(Debug, Clone)]
pub struct StaticModel {
    /// Upstream model ID, kept verbatim: case, slashes, ":free" suffix.
    pub upstream_id: String,
    pub context_tokens: Option<u64>,
}

/// Incoming key: non-secret alias plus secret. History stores the alias.
#[derive(Debug, Clone)]
pub struct ClientKey {
    pub alias: String,
    pub secret: String,
}

/// HTTP timeouts for inference, catalog and local engine requests.
#[derive(Debug, Clone, Copy)]
pub struct HttpTimeouts {
    /// Connect for inference requests.
    pub connect: Duration,
    /// Wait for the start of the upstream response: status and headers.
    pub first_byte: Duration,
    /// Upper limit for one upstream request. One attempt, not the whole loop.
    pub total_attempt: Duration,
    /// Requests to catalog and financial APIs.
    pub catalog: Duration,
    /// Connect for catalog and monitor clients.
    pub catalog_connect: Duration,
    /// Read of local engine state.
    pub local_state: Duration,
}

impl Default for HttpTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(10),
            first_byte: Duration::from_millis(60_000),
            total_attempt: Duration::from_secs(600),
            catalog: Duration::from_secs(15),
            catalog_connect: Duration::from_secs(5),
            local_state: Duration::from_millis(5_000),
        }
    }
}

/// Retry of a pinned model: 3 retries with 2/4/8 s pauses.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay: Duration::from_secs(2),
        }
    }
}

impl RetryPolicy {
    /// Pause before retry N: 2, 4, 8 s.
    pub fn delay_before_retry(&self, retry: u32) -> Duration {
        self.base_delay * 2u32.pow(retry)
    }
}

/// Default bans: 3600 s for a model and 30 s for a short-term rate limit.
#[derive(Debug, Clone, Copy)]
pub struct BanPolicy {
    /// Quota/balance exhaustion and broken-backend bans.
    pub model_ban: Duration,
    /// Recognized short-term rate limits: kept short on purpose.
    pub rate_limit_ban: Duration,
}

impl Default for BanPolicy {
    fn default() -> Self {
        Self {
            model_ban: Duration::from_secs(3_600),
            rate_limit_ban: Duration::from_secs(30),
        }
    }
}

/// How the knowledge base is filled: which configured provider and model
/// research the cards, and when a card counts as stale.
#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeConfig {
    pub provider_id: String,
    pub model: String,
    pub max_age: Duration,
}

/// One web search provider connection. The key is a dedicated search
/// credential, never an upstream inference key; it stays server-side.
#[derive(Debug, Clone)]
pub struct SearchProviderConfig {
    pub base_url: String,
    pub api_key: String,
}

/// Chat web-search settings. A provider entry turns that provider on;
/// a provider without an entry stays off.
#[derive(Debug, Clone)]
pub struct WebSearchConfig {
    pub deepseek: Option<SearchProviderConfig>,
    pub zai: Option<SearchProviderConfig>,
    /// One search or read call to a provider. Z.AI documents a 20 s reader
    /// default; keep both providers on the same proven number.
    pub request_timeout: Duration,
    /// Registry capacity per owner; oldest entries are evicted beyond it.
    pub max_source_ids: usize,
    /// How long a source_id stays readable after search.
    pub source_ttl: Duration,
}

/// Input bounds for the memory tools. MVP values; a note is a short fact,
/// not a transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryConfig {
    pub topic_max_chars: usize,
    pub note_max_chars: usize,
    pub recall_limit_max: u32,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            topic_max_chars: 200,
            note_max_chars: 4_000,
            recall_limit_max: 20,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    pub listen: String,
    pub providers: Vec<ProviderConfig>,
    pub client_keys: Vec<ClientKey>,
    pub http: HttpTimeouts,
    pub retry: RetryPolicy,
    pub ban: BanPolicy,
    pub knowledge: Option<KnowledgeConfig>,
    /// Catalog and balance refresh interval. Design target: tens of minutes.
    pub schedule_interval: Duration,
    /// How long request history is kept.
    pub retention: Duration,
    /// Directory for the SQLite files.
    pub data_dir: String,
    /// Chat web search; None = the web routes answer "not configured".
    pub web_search: Option<WebSearchConfig>,
    /// Memory input bounds; None = built-in defaults.
    pub memory: Option<MemoryConfig>,
}

#[derive(Debug)]
pub struct ConfigError(pub String);

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "config: {}", self.0)
    }
}
impl std::error::Error for ConfigError {}

// --- Serde structs that mirror the YAML shape. ---

#[derive(serde::Deserialize)]
struct RawConfig {
    listen: Option<String>,
    #[serde(default)]
    providers: Vec<RawProvider>,
    #[serde(default)]
    client_keys: Vec<RawClientKey>,
    timeouts: Option<RawTimeouts>,
    retry: Option<RawRetry>,
    ban: Option<RawBan>,
    schedule_interval_secs: Option<u64>,
    retention_days: Option<u64>,
    data_dir: Option<String>,
    knowledge: Option<RawKnowledge>,
    web_search: Option<RawWebSearch>,
    memory: Option<RawMemory>,
}

#[derive(serde::Deserialize, Default)]
struct RawKnowledge {
    provider_id: Option<String>,
    model: Option<String>,
    max_age_days: Option<u64>,
}

#[derive(serde::Deserialize, Default)]
struct RawWebSearch {
    request_timeout_secs: Option<u64>,
    max_source_ids: Option<usize>,
    source_ttl_secs: Option<u64>,
    deepseek: Option<RawSearchProvider>,
    zai: Option<RawSearchProvider>,
}

#[derive(serde::Deserialize, Default)]
struct RawSearchProvider {
    base_url: Option<String>,
    api_key: Option<String>,
}

#[derive(serde::Deserialize, Default)]
struct RawMemory {
    topic_max_chars: Option<usize>,
    note_max_chars: Option<usize>,
    recall_limit_max: Option<u32>,
}

#[derive(serde::Deserialize)]
struct RawProvider {
    provider_id: String,
    driver: String,
    base_url: String,
    api_key: Option<String>,
    #[serde(default)]
    models: Vec<RawModel>,
}

#[derive(serde::Deserialize)]
struct RawModel {
    id: String,
    context_tokens: Option<u64>,
}

#[derive(serde::Deserialize)]
struct RawClientKey {
    alias: String,
    secret: String,
}

#[derive(serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct RawTimeouts {
    connect_secs: Option<u64>,
    first_byte_ms: Option<u64>,
    total_attempt_secs: Option<u64>,
    catalog_secs: Option<u64>,
    catalog_connect_secs: Option<u64>,
    local_state_ms: Option<u64>,
}

#[derive(serde::Deserialize, Default)]
struct RawRetry {
    max_retries: Option<u32>,
    base_delay_secs: Option<u64>,
}

#[derive(serde::Deserialize, Default)]
struct RawBan {
    model_ban_secs: Option<u64>,
    rate_limit_ban_secs: Option<u64>,
}

pub fn load(path: &Path) -> Result<Config, ConfigError> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| ConfigError(format!("{}: {e}", path.display())))?;
    let raw: RawConfig =
        serde_yaml::from_str(&text).map_err(|e| ConfigError(format!("{}: {e}", path.display())))?;
    validate(raw, path)
}

/// Documented API root of one search provider; a config entry may override
/// it (for example a mirror), the default follows the public docs.
fn default_search_base(name: &str) -> String {
    match name {
        "zai" => "https://api.z.ai",
        _ => "https://api.deepseek.com",
    }
    .to_owned()
}

fn validate(raw: RawConfig, path: &Path) -> Result<Config, ConfigError> {
    let err = |msg: String| ConfigError(format!("{}: {msg}", path.display()));

    if raw.client_keys.is_empty() {
        return Err(err(
            "no client_keys given; at least one alias and secret is required".into(),
        ));
    }

    let mut client_keys = Vec::with_capacity(raw.client_keys.len());
    let mut aliases: HashMap<&str, ()> = HashMap::new();
    let mut secrets: HashMap<&str, ()> = HashMap::new();
    for k in &raw.client_keys {
        if k.alias.trim().is_empty() {
            return Err(err("client key alias is empty".into()));
        }
        if k.secret.trim().is_empty() {
            return Err(err(format!("client key '{}' has an empty secret", k.alias)));
        }
        if aliases.insert(k.alias.as_str(), ()).is_some() {
            return Err(err(format!("client key alias '{}' is used twice", k.alias)));
        }
        // One secret must mean one alias; a duplicate would make the
        // recorded history source ambiguous.
        if secrets.insert(k.secret.as_str(), ()).is_some() {
            return Err(err(format!(
                "client key '{}' reuses another key's secret",
                k.alias
            )));
        }
        client_keys.push(ClientKey {
            alias: k.alias.clone(),
            secret: k.secret.clone(),
        });
    }

    let mut providers = Vec::with_capacity(raw.providers.len());
    let mut ids: HashMap<&str, ()> = HashMap::new();
    for p in &raw.providers {
        if p.provider_id.trim().is_empty() {
            return Err(err("provider_id is empty".into()));
        }
        if ids.insert(p.provider_id.as_str(), ()).is_some() {
            return Err(err(format!(
                "provider_id '{}' is used twice",
                p.provider_id
            )));
        }
        let Some(driver) = DriverKind::from_config(&p.driver) else {
            return Err(err(format!(
                "provider '{}': unknown driver '{}'",
                p.provider_id, p.driver
            )));
        };
        if p.base_url.trim().is_empty() {
            return Err(err(format!(
                "provider '{}': base_url is empty",
                p.provider_id
            )));
        }
        let mut static_models = Vec::with_capacity(p.models.len());
        let mut model_ids: HashMap<&str, ()> = HashMap::new();
        for m in &p.models {
            if m.id.trim().is_empty() {
                return Err(err(format!(
                    "provider '{}': model id is empty",
                    p.provider_id
                )));
            }
            if model_ids.insert(m.id.as_str(), ()).is_some() {
                return Err(err(format!(
                    "provider '{}': model id '{}' is used twice",
                    p.provider_id, m.id
                )));
            }
            static_models.push(StaticModel {
                upstream_id: m.id.clone(),
                context_tokens: m.context_tokens,
            });
        }
        providers.push(ProviderConfig {
            provider_id: p.provider_id.clone(),
            driver,
            base_url: p.base_url.clone(),
            api_key: p.api_key.clone(),
            static_models,
        });
    }

    let t = raw.timeouts.unwrap_or_default();
    let http = HttpTimeouts {
        connect: Duration::from_secs(t.connect_secs.unwrap_or(10)),
        first_byte: Duration::from_millis(t.first_byte_ms.unwrap_or(60_000)),
        total_attempt: Duration::from_secs(t.total_attempt_secs.unwrap_or(600)),
        catalog: Duration::from_secs(t.catalog_secs.unwrap_or(15)),
        catalog_connect: Duration::from_secs(t.catalog_connect_secs.unwrap_or(5)),
        local_state: Duration::from_millis(t.local_state_ms.unwrap_or(5_000)),
    };

    let r = raw.retry.unwrap_or_default();
    let retry = RetryPolicy {
        max_retries: r.max_retries.unwrap_or(3),
        base_delay: Duration::from_secs(r.base_delay_secs.unwrap_or(2)),
    };

    let b = raw.ban.unwrap_or_default();
    let ban = BanPolicy {
        model_ban: Duration::from_secs(b.model_ban_secs.unwrap_or(3_600)),
        rate_limit_ban: Duration::from_secs(b.rate_limit_ban_secs.unwrap_or(30)),
    };
    if ban.model_ban.as_secs() < 1 {
        return Err(err("ban.model_ban_secs must be at least 1".into()));
    }
    if ban.rate_limit_ban.as_secs() < 1 || ban.rate_limit_ban.as_secs() > 300 {
        return Err(err(
            "ban.rate_limit_ban_secs must be between 1 and 300".into()
        ));
    }

    let knowledge = match raw.knowledge {
        Some(k) => {
            let provider_id = k.provider_id.unwrap_or_default();
            let model = k.model.unwrap_or_default();
            if provider_id.trim().is_empty() || model.trim().is_empty() {
                return Err(err("knowledge: provider_id and model are required".into()));
            }
            if !ids.contains_key(provider_id.as_str()) {
                return Err(err(format!(
                    "knowledge: provider_id '{provider_id}' is not a configured provider"
                )));
            }
            let max_age_days = k.max_age_days.unwrap_or(30);
            if max_age_days < 1 {
                return Err(err("knowledge: max_age_days must be at least 1".into()));
            }
            Some(KnowledgeConfig {
                provider_id,
                model,
                max_age: Duration::from_secs(max_age_days * 86_400),
            })
        }
        None => None,
    };

    let web_search = match raw.web_search {
        Some(ws) => {
            let provider = |raw: Option<RawSearchProvider>, name: &str| match raw {
                None => Ok(None),
                Some(p) => {
                    let api_key = p.api_key.unwrap_or_default();
                    if api_key.trim().is_empty() {
                        return Err(err(format!(
                            "web_search.{name}: api_key is required to enable the provider"
                        )));
                    }
                    Ok(Some(SearchProviderConfig {
                        base_url: p.base_url.unwrap_or_else(|| default_search_base(name)),
                        api_key,
                    }))
                }
            };
            let deepseek = provider(ws.deepseek, "deepseek")?;
            let zai = provider(ws.zai, "zai")?;
            let request_timeout_secs = ws.request_timeout_secs.unwrap_or(20);
            if request_timeout_secs == 0 {
                return Err(err(
                    "web_search.request_timeout_secs must be at least 1".into()
                ));
            }
            let max_source_ids = ws.max_source_ids.unwrap_or(200);
            if max_source_ids == 0 {
                return Err(err("web_search.max_source_ids must be at least 1".into()));
            }
            let source_ttl_secs = ws.source_ttl_secs.unwrap_or(1_800);
            if source_ttl_secs == 0 {
                return Err(err("web_search.source_ttl_secs must be at least 1".into()));
            }
            Some(WebSearchConfig {
                deepseek,
                zai,
                request_timeout: Duration::from_secs(request_timeout_secs),
                max_source_ids,
                source_ttl: Duration::from_secs(source_ttl_secs),
            })
        }
        None => None,
    };

    let memory = raw.memory.map(|m| {
        let defaults = MemoryConfig::default();
        MemoryConfig {
            topic_max_chars: m.topic_max_chars.unwrap_or(defaults.topic_max_chars),
            note_max_chars: m.note_max_chars.unwrap_or(defaults.note_max_chars),
            recall_limit_max: m.recall_limit_max.unwrap_or(defaults.recall_limit_max),
        }
    });

    Ok(Config {
        listen: raw.listen.unwrap_or_else(|| "127.0.0.1:8080".into()),
        providers,
        client_keys,
        http,
        retry,
        ban,
        knowledge,
        web_search,
        memory,
        schedule_interval: Duration::from_secs(raw.schedule_interval_secs.unwrap_or(600)),
        retention: Duration::from_secs(raw.retention_days.unwrap_or(30) * 86_400),
        data_dir: raw.data_dir.unwrap_or_else(|| "data".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> Result<Config, ConfigError> {
        let raw: RawConfig = serde_yaml::from_str(yaml).unwrap();
        validate(raw, Path::new("test.yaml"))
    }

    const MINIMAL: &str = r#"
client_keys:
  - alias: laptop
    secret: s1
"#;

    // Extends MINIMAL with one extra root-level mapping block (2-space indented).
    fn minimal_str(extra: &str) -> String {
        format!("{MINIMAL}\n{extra}")
    }

    #[test]
    fn minimal_config_ok() {
        let c = parse(MINIMAL).unwrap();
        assert_eq!(c.client_keys.len(), 1);
        assert_eq!(c.providers.len(), 0);
        assert_eq!(c.listen, "127.0.0.1:8080");
        assert_eq!(c.http.first_byte, Duration::from_millis(60_000));
        assert_eq!(c.retry.max_retries, 3);
        assert_eq!(c.retry.delay_before_retry(0), Duration::from_secs(2));
        assert_eq!(c.retry.delay_before_retry(2), Duration::from_secs(8));
        assert_eq!(c.ban.model_ban, Duration::from_secs(3_600));
        assert_eq!(c.ban.rate_limit_ban, Duration::from_secs(30));
    }

    #[test]
    fn knowledge_section_requires_a_configured_provider() {
        let yaml = minimal_str(
            "providers:\n  - provider_id: deepseek\n    driver: deepseek\n    base_url: https://api.deepseek.com/v1\nknowledge:\n  provider_id: deepseek\n  model: deepseek-flash\n",
        );
        let c = parse(&yaml).unwrap();
        let k = c.knowledge.unwrap();
        assert_eq!(k.provider_id, "deepseek");
        assert_eq!(k.model, "deepseek-flash");
        assert_eq!(k.max_age, Duration::from_secs(30 * 86_400));

        let bad = minimal_str("knowledge:\n  provider_id: ghost\n  model: m\n");
        assert!(
            parse(&bad)
                .unwrap_err()
                .0
                .contains("not a configured provider")
        );
    }

    #[test]
    fn ban_policy_is_configurable_and_validated() {
        let c = parse(&minimal_str(
            "ban:\n  model_ban_secs: 120\n  rate_limit_ban_secs: 5\n",
        ))
        .unwrap();
        assert_eq!(c.ban.model_ban, Duration::from_secs(120));
        assert_eq!(c.ban.rate_limit_ban, Duration::from_secs(5));

        let e = parse(&minimal_str("ban:\n  model_ban_secs: 0\n")).unwrap_err();
        assert!(e.0.contains("model_ban_secs"));
        let e = parse(&minimal_str("ban:\n  rate_limit_ban_secs: 301\n")).unwrap_err();
        assert!(e.0.contains("rate_limit_ban_secs"));
    }

    #[test]
    fn no_client_keys_rejected() {
        let e = parse("").unwrap_err();
        assert!(e.0.contains("no client_keys"));
    }

    #[test]
    fn empty_secret_rejected() {
        let e = parse("client_keys:\n  - alias: a\n    secret: \"\"\n").unwrap_err();
        assert!(e.0.contains("empty secret"));
    }

    #[test]
    fn duplicate_alias_rejected() {
        let e = parse("client_keys:\n  - {alias: a, secret: x}\n  - {alias: a, secret: y}\n")
            .unwrap_err();
        assert!(e.0.contains("client key alias 'a' is used twice"));
    }

    #[test]
    fn duplicate_secret_rejected() {
        let e = parse("client_keys:\n  - {alias: a, secret: same}\n  - {alias: b, secret: same}\n")
            .unwrap_err();
        assert!(e.0.contains("'b' reuses another key's secret"));
    }

    #[test]
    fn unknown_driver_rejected() {
        let e = parse(&format!(
            "{MINIMAL}providers:\n  - provider_id: p1\n    driver: nope\n    base_url: http://x\n"
        ))
        .unwrap_err();
        assert!(e.0.contains("unknown driver 'nope'"));
    }

    #[test]
    fn duplicate_provider_rejected() {
        let yaml = format!(
            "{MINIMAL}providers:\n  - provider_id: p\n    driver: kimi\n    base_url: http://x\n  - provider_id: p\n    driver: kimi\n    base_url: http://y\n"
        );
        assert!(
            parse(&yaml)
                .unwrap_err()
                .0
                .contains("provider_id 'p' is used twice")
        );
    }

    #[test]
    fn static_models_kept_verbatim() {
        let yaml = format!(
            "{MINIMAL}providers:\n  - provider_id: p\n    driver: openrouter\n    base_url: http://x\n    models:\n      - id: \"deepseek/deepseek-r1:free\"\n        context_tokens: 163840\n"
        );
        let c = parse(&yaml).unwrap();
        assert_eq!(
            c.providers[0].static_models[0].upstream_id,
            "deepseek/deepseek-r1:free"
        );
        assert_eq!(c.providers[0].static_models[0].context_tokens, Some(163840));
    }

    #[test]
    fn web_search_section_enables_only_configured_providers() {
        // No section: nothing is on.
        let c = parse(MINIMAL).unwrap();
        assert!(c.web_search.is_none());

        // An entry without a key is a config error, not a silent enable.
        let e = parse(&minimal_str(
            "web_search:\n  deepseek:\n    base_url: https://api.deepseek.com\n",
        ))
        .unwrap_err();
        assert!(e.0.contains("api_key is required"));

        let c = parse(&minimal_str(
            "web_search:\n  deepseek:\n    api_key: sk-1\n  request_timeout_secs: 5\n  max_source_ids: 50\n  source_ttl_secs: 60\n",
        ))
        .unwrap();
        let ws = c.web_search.unwrap();
        assert!(ws.deepseek.is_some());
        assert!(ws.zai.is_none());
        assert_eq!(ws.deepseek.unwrap().base_url, "https://api.deepseek.com");
        assert_eq!(ws.request_timeout, Duration::from_secs(5));
        assert_eq!(ws.max_source_ids, 50);
        assert_eq!(ws.source_ttl, Duration::from_secs(60));

        let e = parse(&minimal_str("web_search:\n  request_timeout_secs: 0\n")).unwrap_err();
        assert!(e.0.contains("request_timeout_secs"));
    }

    #[test]
    fn memory_bounds_default_and_override() {
        let c = parse(MINIMAL).unwrap();
        assert_eq!(c.memory, None);

        let c = parse(&minimal_str(
            "memory:\n  topic_max_chars: 50\n  note_max_chars: 1000\n  recall_limit_max: 5\n",
        ))
        .unwrap();
        let m = c.memory.unwrap();
        assert_eq!(m.topic_max_chars, 50);
        assert_eq!(m.note_max_chars, 1_000);
        assert_eq!(m.recall_limit_max, 5);
    }

    #[test]
    fn missing_file_rejected() {
        let e = load(Path::new("/nonexistent/config.yaml")).unwrap_err();
        assert!(e.0.contains("/nonexistent/config.yaml"));
    }
}
