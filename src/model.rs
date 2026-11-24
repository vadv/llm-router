// Domain identity and read view for provider models. No credentials, no
// HTTP, no execution — those live in the provider module.

use std::collections::HashMap;
use std::fmt;

/// Identity of one configured provider connection.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProviderId(String);

impl ProviderId {
    pub fn new(value: impl Into<String>) -> Self {
        ProviderId(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ProviderId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// Identity of one catalog model: a provider plus the upstream id, verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelId {
    provider: ProviderId,
    upstream: String,
}

impl ModelId {
    pub fn new(provider: ProviderId, upstream: impl Into<String>) -> Self {
        ModelId {
            provider,
            upstream: upstream.into(),
        }
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn upstream(&self) -> &str {
        &self.upstream
    }
}

/// External `provider:upstream` form. The upstream id may itself contain
/// separators, so this form is for display and logs, never parsed back.
impl fmt::Display for ModelId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.provider, self.upstream)
    }
}

/// A catalog entry describing one model of one provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderModel {
    pub id: ModelId,
    pub context_tokens: Option<u64>,
    pub observed_at_unix: i64,
}

#[derive(Debug)]
pub struct CatalogError(pub String);

impl fmt::Display for CatalogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "catalog: {}", self.0)
    }
}
impl std::error::Error for CatalogError {}

/// Read-only catalog contract. SQLite adapters implement it; consumers never
/// see the adapter's collections.
pub trait ModelCatalog {
    fn find(&self, id: &ModelId) -> Result<Option<ProviderModel>, CatalogError>;
}

/// Knowledge key of a model: the same researched card serves every provider
/// and alias of one model. Vendor path prefixes ("z-ai/"), variant suffixes
/// (":free", ":batch"), Anthropic context slices ("[1m]"), the tokenator
/// "cursor-" and provider "free-" prefixes are cut. Version dots become
/// dashes because both spellings appear across providers (claude-opus-4.7
/// vs claude-opus-4-7). Lowercase for case-insensitive match. Best effort:
/// an unknown alias just gets its own card instead of sharing one.
pub fn knowledge_key(upstream_id: &str) -> String {
    let key = upstream_id.rsplit('/').next().unwrap_or(upstream_id);
    let key = key.split(':').next().unwrap_or(key);
    let key = key.split('[').next().unwrap_or(key);
    let key = key.strip_prefix("cursor-").unwrap_or(key);
    let key = key.strip_prefix("free-").unwrap_or(key);
    key.to_ascii_lowercase().replace('.', "-")
}

/// Two spellings of one model: `qwen-3.7-plus` on one provider and
/// `qwen3.7-plus` on the next. A card stored under either is the same card,
/// so the knowledge store and the catalog compare keys this way.
pub fn knowledge_identity(key: &str) -> String {
    key.replace('-', "")
}

/// One key per model for a set of knowledge keys. Providers spell one
/// family two ways (`cursor-qwen-3.7-plus` next to `qwen3.7-plus`); the
/// knowledge store already shares one card across such spellings, so the
/// catalog reports the spelling most listings use. A tie goes to the one
/// with more hyphens, which reads as the provider writes it, then to
/// alphabetical order, so the key of a model is the same on every read.
/// The answer maps a model's identity to the key that names it.
pub fn catalog_keys(exact: &[String]) -> HashMap<String, String> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for key in exact {
        *counts.entry(key.as_str()).or_default() += 1;
    }
    let mut chosen: HashMap<String, &str> = HashMap::new();
    for key in counts.keys() {
        let identity = knowledge_identity(key);
        match chosen.get(&identity) {
            Some(best) if preferred(best, counts[best], key, counts[key]) => {}
            _ => {
                chosen.insert(identity, key);
            }
        }
    }
    chosen
        .into_iter()
        .map(|(identity, key)| (identity, key.to_string()))
        .collect()
}

/// Whether spelling `a` with `a_count` listings names the model better
/// than `b` with `b_count`.
fn preferred(a: &str, a_count: usize, b: &str, b_count: usize) -> bool {
    a_count > b_count
        || (a_count == b_count
            && (a.matches('-').count() > b.matches('-').count()
                || (a.matches('-').count() == b.matches('-').count() && a < b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_key_unifies_providers_and_aliases() {
        assert_eq!(knowledge_key("z-ai/glm-5.3"), "glm-5-3");
        assert_eq!(knowledge_key("glm-5.3:free"), "glm-5-3");
        assert_eq!(
            knowledge_key("openrouter/qwen/qwen3-coder:free"),
            "qwen3-coder"
        );
        assert_eq!(knowledge_key("cursor-hy4-flash"), "hy4-flash");
        assert_eq!(knowledge_key("GLM-5.3"), "glm-5-3");
        assert_eq!(knowledge_key("hy4"), "hy4");
        assert_eq!(knowledge_key("gpt-oss-120b:extended"), "gpt-oss-120b");
    }

    #[test]
    fn knowledge_key_unifies_version_spellings_and_slices() {
        // Dots and dashes in versions name the same model across providers.
        assert_eq!(knowledge_key("claude-opus-4.7"), "claude-opus-4-7");
        assert_eq!(
            knowledge_key("anthropic/claude-opus-4-7"),
            "claude-opus-4-7"
        );
        // Anthropic context slices are the same model at another window.
        assert_eq!(knowledge_key("claude-opus-4.7[1m]"), "claude-opus-4-7");
        // Free routes on some providers mirror the paid model.
        assert_eq!(knowledge_key("free-claude-opus-5.5"), "claude-opus-5-5");
        assert_eq!(knowledge_key("free-gpt-6.2-sol"), "gpt-6-2-sol");
    }

    #[test]
    fn knowledge_key_of_an_empty_id_is_empty() {
        assert_eq!(knowledge_key(""), "");
        assert_eq!(knowledge_key(":free"), "");
    }

    #[test]
    fn knowledge_identity_ignores_hyphens_and_nothing_else() {
        assert_eq!(
            knowledge_identity("qwen-3.7-plus"),
            knowledge_identity("qwen3.7-plus")
        );
        assert_eq!(
            knowledge_identity("hy4-flash"),
            knowledge_identity("hy4flash")
        );
        assert_ne!(
            knowledge_identity("glm-5-3"),
            knowledge_identity("glm-5-3-flash")
        );
        assert_ne!(
            knowledge_identity("kimi-k3"),
            knowledge_identity("kimi-latest")
        );
        assert_eq!(knowledge_identity(""), "");
    }

    #[test]
    fn display_keeps_the_upstream_id_verbatim() {
        let id = ModelId::new(ProviderId::new("vendor"), "Vendor/Model-1:free");
        assert_eq!(id.to_string(), "vendor:Vendor/Model-1:free");
        assert_eq!(id.provider().as_str(), "vendor");
        assert_eq!(id.upstream(), "Vendor/Model-1:free");
    }

    #[test]
    fn ids_with_different_providers_are_distinct() {
        let a = ModelId::new(ProviderId::new("p1"), "m");
        let b = ModelId::new(ProviderId::new("p2"), "m");
        assert_ne!(a, b);
    }
}
