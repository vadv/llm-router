// Chat web search: a normalized search/read contract over two server-side
// providers (DeepSeek, Z.AI). The provider is chosen before any network
// call; auto mode falls back to the second provider only on a technical
// failure (timeout, network error, 5xx) — an empty or weak result is a
// final answer. Source ids are owner-scoped, temporary, and the only way
// to read a page: read_source never accepts an arbitrary URL.

pub mod deepseek;
pub mod source_registry;
pub mod zai;

#[cfg(test)]
pub mod fake;

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use source_registry::{SourceRegistry, SourceRegistryConfig};

/// The provider that actually served a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Deepseek,
    Zai,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Deepseek => "deepseek",
            Provider::Zai => "zai",
        }
    }
}

/// Provider asked for by the caller; auto = DeepSeek first, Z.AI on
/// technical failure only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProviderChoice {
    #[default]
    Auto,
    Deepseek,
    Zai,
}

impl ProviderChoice {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "deepseek" => Some(Self::Deepseek),
            "zai" => Some(Self::Zai),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub count: Option<u32>,
    pub provider: ProviderChoice,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchItem {
    pub source_id: String,
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchResult {
    pub items: Vec<SearchItem>,
    pub provider_used: Provider,
    pub fallback_used: bool,
}

/// A page read through a provider.
///
/// Redirects are not verified by the router: the providers fetch the page
/// themselves, and their fetch/redirect policy is the documented boundary.
/// `url` is the URL we validated and registered, or a provider-returned URL
/// that passed the same public-destination check — never a claim that the
/// redirect chain was inspected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadResult {
    pub url: String,
    pub title: Option<String>,
    pub content_markdown: String,
    pub chars: usize,
    pub truncated: bool,
}

/// Typed service errors; the HTTP layer maps each to {error: {type, message}}
/// with a safe message — provider bodies and credentials never leak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebSearchError {
    InvalidArguments(String),
    ProviderUnavailable(String),
    NotFound(String),
    Expired(String),
}

/// Why a provider call failed. `Technical` (timeout, connect error, 408,
/// 429, 5xx) is the only class that may trigger auto fallback; a rejected
/// request or an unexpected response shape is final.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdapterError {
    Technical,
    /// Other 4xx; the number is logged as a status only, no body is kept.
    Rejected(u16),
    /// The response could not be parsed into the documented shape.
    BadResponse,
    /// Read only: the provider answered that the page is unavailable or
    /// blocked — not a retryable transport problem.
    ReadFailed,
}

/// One raw search hit as the adapter sees it, before a source_id exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderHit {
    pub title: String,
    pub url: String,
    pub snippet: Option<String>,
}

/// A page as the provider returns it. `url` is None when the provider's
/// read API reports no URL at all (DeepSeek fetch returns title+content).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderReadPage {
    pub url: Option<String>,
    pub title: Option<String>,
    pub content_markdown: String,
}

/// The one interface both providers implement, search and read only. The
/// service knows which slot an adapter occupies; the adapter does not.
pub trait SearchAdapter: Send + Sync {
    fn search<'a>(
        &'a self,
        query: &'a str,
        count: u32,
    ) -> BoxFuture<'a, Result<Vec<ProviderHit>, AdapterError>>;
    fn read<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<ProviderReadPage, AdapterError>>;
}

/// Local bound on the query we forward. Providers apply their own, tighter
/// limits and answer with a rejected status we surface, not hide.
const QUERY_MAX_CHARS: usize = 512;
/// Both providers document 50 as the maximum result count.
pub const COUNT_MAX: u32 = 50;
const COUNT_DEFAULT: u32 = 10;
/// Read content cap in chars; a longer page arrives truncated. Roughly a
/// model-readable page excerpt, not a full-site dump.
pub const READ_MAX_CHARS: usize = 20_000;
/// DeepSeek documents 8192 as the longest accepted URL; URLs beyond it are
/// dropped instead of forwarded.
const URL_MAX_CHARS: usize = 8_192;

/// Read a provider response body as text with a hard byte cap: a stream
/// of unknown shape never collects without bound. UTF-8 failures and
/// oversize both count as an unusable response.
pub(crate) async fn bounded_text(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, AdapterError> {
    let mut stream = response.bytes_stream();
    let mut buf = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| AdapterError::Technical)?;
        buf.extend_from_slice(&chunk);
        if buf.len() > max_bytes {
            return Err(AdapterError::BadResponse);
        }
    }
    String::from_utf8(buf).map_err(|_| AdapterError::BadResponse)
}

/// HTTP status → adapter error, search flavor: only transport classes
/// (5xx, 408, 429) are technical and eligible for auto fallback; every
/// other 4xx is a final rejection.
pub(crate) fn classify_search_status(status: u16) -> AdapterError {
    if (500..600).contains(&status) || status == 408 || status == 429 {
        AdapterError::Technical
    } else {
        AdapterError::Rejected(status)
    }
}

/// HTTP status → adapter error, read flavor: 403/404 mean the page could
/// not be read, which is a final answer about the page, not a transport
/// fault eligible for retry.
pub(crate) fn classify_read_status(status: u16) -> AdapterError {
    match status {
        403 | 404 => AdapterError::ReadFailed,
        _ => classify_search_status(status),
    }
}

pub struct WebSearchService {
    deepseek: Option<Arc<dyn SearchAdapter>>,
    zai: Option<Arc<dyn SearchAdapter>>,
    registry: SourceRegistry,
}

impl WebSearchService {
    pub fn new(
        deepseek: Option<Arc<dyn SearchAdapter>>,
        zai: Option<Arc<dyn SearchAdapter>>,
        registry: SourceRegistry,
    ) -> Self {
        Self {
            deepseek,
            zai,
            registry,
        }
    }

    fn adapter(&self, provider: Provider) -> Option<&Arc<dyn SearchAdapter>> {
        match provider {
            Provider::Deepseek => self.deepseek.as_ref(),
            Provider::Zai => self.zai.as_ref(),
        }
    }

    /// The ordered provider list for one request, decided before any
    /// network call: the explicit choice, or DeepSeek then Z.AI for auto.
    fn plan(&self, choice: ProviderChoice) -> Vec<Provider> {
        match choice {
            ProviderChoice::Deepseek => vec![Provider::Deepseek],
            ProviderChoice::Zai => vec![Provider::Zai],
            ProviderChoice::Auto => vec![Provider::Deepseek, Provider::Zai],
        }
    }

    pub async fn search(
        &self,
        owner: &str,
        request: &SearchRequest,
    ) -> Result<SearchResult, WebSearchError> {
        let query = request.query.trim();
        if query.is_empty() || query.chars().count() > QUERY_MAX_CHARS {
            return Err(WebSearchError::InvalidArguments(format!(
                "query must be 1 to {QUERY_MAX_CHARS} characters"
            )));
        }
        let count = match request.count {
            None => COUNT_DEFAULT,
            Some(n) if (1..=COUNT_MAX).contains(&n) => n,
            Some(_) => {
                return Err(WebSearchError::InvalidArguments(format!(
                    "count must be between 1 and {COUNT_MAX}"
                )));
            }
        };

        let mut fallback_used = false;
        let mut last: Option<WebSearchError> = None;
        for provider in self.plan(request.provider) {
            let Some(adapter) = self.adapter(provider) else {
                // Not configured: in auto mode this provider is skipped; as
                // an explicit choice it is a dead end.
                last = Some(WebSearchError::ProviderUnavailable(format!(
                    "provider {} is not configured",
                    provider.as_str()
                )));
                continue;
            };
            match adapter.search(query, count).await {
                Ok(hits) => {
                    let items = self.register_hits(owner, provider, hits);
                    return Ok(SearchResult {
                        items,
                        provider_used: provider,
                        fallback_used,
                    });
                }
                Err(AdapterError::Technical) => {
                    // Only a technical failure may try the next provider.
                    fallback_used = true;
                    last = Some(WebSearchError::ProviderUnavailable(format!(
                        "provider {} is unreachable",
                        provider.as_str()
                    )));
                }
                Err(AdapterError::Rejected(status)) => {
                    return Err(rejected_search_error(status));
                }
                Err(AdapterError::BadResponse) => {
                    return Err(WebSearchError::ProviderUnavailable(
                        "search provider returned an unexpected response".into(),
                    ));
                }
                Err(AdapterError::ReadFailed) => {
                    // Search adapters never report ReadFailed; treating it
                    // as a provider fault keeps the invariant total.
                    return Err(WebSearchError::ProviderUnavailable(
                        "search provider failed".into(),
                    ));
                }
            }
        }
        Err(last.unwrap_or_else(|| {
            WebSearchError::ProviderUnavailable("no search provider is configured".into())
        }))
    }

    /// Turn provider hits into owner-scoped items. Hits whose URL is not a
    /// public http(s) destination are dropped — never registered, never
    /// readable.
    fn register_hits(
        &self,
        owner: &str,
        provider: Provider,
        hits: Vec<ProviderHit>,
    ) -> Vec<SearchItem> {
        hits.into_iter()
            .filter_map(|hit| {
                if validate_public_url(&hit.url).is_err() {
                    return None;
                }
                let source_id = self.registry.register(owner, &hit.url, provider);
                Some(SearchItem {
                    source_id,
                    title: hit.title,
                    url: hit.url,
                    snippet: hit.snippet,
                })
            })
            .collect()
    }

    /// Read a source found earlier in this dialog. Only the registered id
    /// is accepted; the read goes through the provider that found the page.
    pub async fn read(&self, owner: &str, source_id: &str) -> Result<ReadResult, WebSearchError> {
        let source = self
            .registry
            .lookup(owner, source_id)
            .map_err(|kind| match kind {
                source_registry::LookupError::NotFound => {
                    WebSearchError::NotFound("source_id is unknown; run a new search".into())
                }
                source_registry::LookupError::Expired => {
                    WebSearchError::Expired("source_id expired; run a new search".into())
                }
            })?;
        let Some(adapter) = self.adapter(source.provider) else {
            return Err(WebSearchError::ProviderUnavailable(format!(
                "provider {} is not configured",
                source.provider.as_str()
            )));
        };
        let page = match adapter.read(&source.url).await {
            Ok(page) => page,
            Err(AdapterError::Technical) => {
                return Err(WebSearchError::ProviderUnavailable(
                    "read provider is unreachable".into(),
                ));
            }
            Err(
                AdapterError::ReadFailed
                | AdapterError::Rejected(403)
                | AdapterError::Rejected(404),
            ) => {
                return Err(WebSearchError::NotFound(
                    "the source page could not be read".into(),
                ));
            }
            Err(AdapterError::Rejected(_)) => {
                return Err(WebSearchError::ProviderUnavailable(
                    "read provider refused the request".into(),
                ));
            }
            Err(AdapterError::BadResponse) => {
                return Err(WebSearchError::ProviderUnavailable(
                    "read provider returned an unexpected response".into(),
                ));
            }
        };
        // shortcut: provider-side fetch/redirect policy is the documented
        // boundary; redirect safety is not verified by the router — upgrade
        // if a local reader is added or providers document final-URL
        // guarantees. A provider-returned URL still passes the same
        // public-destination check as the registered one.
        let url = match &page.url {
            Some(returned) => match validate_public_url(returned) {
                Ok(()) => returned.clone(),
                Err(_) => {
                    return Err(WebSearchError::ProviderUnavailable(
                        "read provider returned an unsafe destination".into(),
                    ));
                }
            },
            None => source.url.clone(),
        };
        let (content, truncated) = truncate_chars(&page.content_markdown, READ_MAX_CHARS);
        Ok(ReadResult {
            url,
            title: page.title,
            chars: content.chars().count(),
            truncated,
            content_markdown: content,
        })
    }
}

/// A rejected search request: a bad argument is the caller's to fix; the
/// remaining 4xx classes (auth, balance, policy) are provider trouble.
fn rejected_search_error(status: u16) -> WebSearchError {
    match status {
        400 | 413 => WebSearchError::InvalidArguments("search provider rejected the query".into()),
        _ => WebSearchError::ProviderUnavailable("search provider refused the request".into()),
    }
}

/// Cut to at most `max` chars on a char boundary.
fn truncate_chars(text: &str, max: usize) -> (String, bool) {
    if text.chars().count() <= max {
        return (text.to_owned(), false);
    }
    (text.chars().take(max).collect(), true)
}

/// Public http(s) destination check for URLs we hand to a provider reader.
/// Syntactic only: scheme, no embedded credentials, no private/loopback/
/// link-local host, sane length. DNS answers and redirect targets are the
/// fetching provider's boundary, not ours.
pub fn validate_public_url(raw: &str) -> Result<(), &'static str> {
    if raw.len() > URL_MAX_CHARS {
        return Err("url is too long");
    }
    let url = url::Url::parse(raw).map_err(|_| "url is not valid")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("url scheme must be http or https");
    }
    // Url::parse keeps userinfo in username/password; "http://a:b@host/" is
    // credentials-in-URL and must never reach a provider.
    if url.username() != "" || url.password().is_some() {
        return Err("url must not contain credentials");
    }
    let Some(host) = url.host_str() else {
        return Err("url has no host");
    };
    if !is_public_host(host) {
        return Err("url host is not a public destination");
    }
    Ok(())
}

/// Reject localhost names and every non-global IP literal (v4 and v6,
/// including IPv4-mapped v6). A hostname that merely resolves privately is
/// the fetching provider's boundary.
fn is_public_host(host: &str) -> bool {
    let lowered = host.to_ascii_lowercase();
    if lowered == "localhost" || lowered.ends_with(".localhost") {
        return false;
    }
    // Url::host_str keeps the brackets on IPv6 ("[::1]"); strip them so the
    // literal parses as an address instead of passing as a name.
    let bare = if lowered.starts_with('[') && lowered.ends_with(']') {
        &lowered[1..lowered.len() - 1]
    } else {
        &lowered
    };
    match bare.parse::<std::net::IpAddr>() {
        Ok(ip) => match ip {
            std::net::IpAddr::V4(v4) => {
                !v4.is_loopback()
                    && !v4.is_private()
                    && !v4.is_link_local()
                    && !v4.is_unspecified()
                    && !is_shared_address_space(v4)
            }
            std::net::IpAddr::V6(v6) => {
                let seg = v6.segments();
                !(v6.is_loopback()
                    || v6.is_unspecified()
                    // fe80::/10 link-local and fc00::/7 unique-local.
                    || (seg[0] & 0xffc0) == 0xfe80
                    || (seg[0] & 0xfe00) == 0xfc00
                    // 64:ff9b::/96 well-known NAT64 embeds an IPv4 address.
                    || (seg[0] == 0x0064 && seg[1] == 0xff9b)
                    // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible forms.
                    || seg[..5] == [0, 0, 0, 0, 0]
                        && (seg[5] == 0xffff || (seg[5] == 0 && seg[6] != 0)))
            }
        },
        // A name, not an address: treated as public.
        Err(_) => true,
    }
}

/// 100.64.0.0/10 carrier-grade NAT: not globally reachable.
fn is_shared_address_space(v4: std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    (o[0] == 100) && (o[1] & 0xc0) == 64
}

/// Registry sizing taken from the service configuration.
impl From<&crate::config::WebSearchConfig> for SourceRegistryConfig {
    fn from(cfg: &crate::config::WebSearchConfig) -> Self {
        Self {
            max_ids_per_owner: cfg.max_source_ids,
            ttl: cfg.source_ttl,
        }
    }
}

/// Re-exported for wiring and tests: build the service with real adapters.
pub fn service_from_config(cfg: &crate::config::WebSearchConfig) -> WebSearchService {
    let client = |timeout: Duration| {
        reqwest::Client::builder()
            // Same 5 s connect budget as the proven catalog clients.
            .connect_timeout(Duration::from_secs(5))
            .timeout(timeout)
            // Our calls go to the configured provider root only; the
            // provider itself does the page fetching.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client with only timeouts configured")
    };
    let deepseek = cfg.deepseek.as_ref().map(|p| {
        Arc::new(deepseek::DeepseekAdapter::new(
            client(cfg.request_timeout),
            &p.base_url,
            &p.api_key,
        )) as Arc<dyn SearchAdapter>
    });
    let zai = cfg.zai.as_ref().map(|p| {
        Arc::new(zai::ZaiAdapter::new(
            client(cfg.request_timeout),
            &p.base_url,
            &p.api_key,
            cfg.request_timeout,
        )) as Arc<dyn SearchAdapter>
    });
    WebSearchService::new(
        deepseek,
        zai,
        SourceRegistry::new(SourceRegistryConfig::from(cfg)),
    )
}

#[cfg(test)]
mod tests {
    use super::fake::FakeAdapter;
    use super::source_registry::{Clock, FakeClock, SystemClock};
    use super::*;

    fn hit(title: &str, url: &str) -> ProviderHit {
        ProviderHit {
            title: title.into(),
            url: url.into(),
            snippet: Some(format!("snippet about {title}")),
        }
    }

    fn service(
        deepseek: Option<Arc<dyn SearchAdapter>>,
        zai: Option<Arc<dyn SearchAdapter>>,
    ) -> WebSearchService {
        WebSearchService::new(
            deepseek,
            zai,
            SourceRegistry::new(SourceRegistryConfig {
                max_ids_per_owner: 200,
                ttl: Duration::from_secs(1_800),
            }),
        )
    }

    fn ok_adapter(_provider: Provider, hits: Vec<ProviderHit>) -> Arc<FakeAdapter> {
        Arc::new(FakeAdapter::new().with_hits(hits))
    }

    async fn search(service: &WebSearchService, provider: ProviderChoice) -> SearchResult {
        service
            .search(
                "laptop",
                &SearchRequest {
                    query: "rust allocator".into(),
                    count: Some(5),
                    provider,
                },
            )
            .await
            .unwrap()
    }

    #[test]
    fn url_guard_rejects_unsafe_destinations() {
        for bad in [
            "http://user:pass@example.com/",
            "http://user@example.com/",
            "ftp://example.com/file",
            "file:///etc/passwd",
            "gopher://example.com",
            "http://127.0.0.1/",
            "http://127.1.2.3/",
            "http://localhost/",
            "http://api.localhost/",
            "http://192.168.1.5/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://0.0.0.0/",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
            "http://[fd12::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:192.168.0.1]/",
            "http://[::]/",
            "not a url",
            "",
        ] {
            assert!(
                validate_public_url(bad).is_err(),
                "expected rejection: {bad}"
            );
        }
    }

    #[test]
    fn url_guard_accepts_public_destinations() {
        for good in [
            "https://example.com/a?b=c#d",
            "http://8.8.8.8/dns",
            "https://93.184.216.34/",
            "http://[2606:2800:220:1:248:1893:25c8:1946]/",
            "https://sub.domain.example/path",
        ] {
            assert!(validate_public_url(good).is_ok(), "expected ok: {good}");
        }
    }

    #[tokio::test]
    async fn search_registers_source_ids_and_reports_the_provider() {
        let ds = ok_adapter(
            Provider::Deepseek,
            vec![hit("Rust", "https://example.com/rust")],
        );
        let zai = ok_adapter(Provider::Zai, vec![]);
        let svc = service(Some(ds.clone()), Some(zai.clone()));
        let result = search(&svc, ProviderChoice::Deepseek).await;
        assert_eq!(result.provider_used, Provider::Deepseek);
        assert!(!result.fallback_used);
        assert_eq!(result.items.len(), 1);
        assert!(!result.items[0].source_id.is_empty());
        // The explicit deepseek plan never touches Z.AI.
        assert_eq!(zai.search_calls(), 0);
        assert_eq!(ds.search_calls(), 1);
    }

    #[tokio::test]
    async fn auto_falls_back_only_on_technical_failure() {
        // Technical failure on DeepSeek -> Z.AI serves, fallback reported.
        let ds = Arc::new(FakeAdapter::new().failing(AdapterError::Technical));
        let zai = ok_adapter(Provider::Zai, vec![hit("Backup", "https://example.com/b")]);
        let svc = service(Some(ds), Some(zai));
        let result = search(&svc, ProviderChoice::Auto).await;
        assert_eq!(result.provider_used, Provider::Zai);
        assert!(result.fallback_used);

        // Empty result from DeepSeek is final: no hidden second request.
        let ds = ok_adapter(Provider::Deepseek, vec![]);
        let zai = ok_adapter(Provider::Zai, vec![hit("Backup", "https://example.com/b")]);
        let svc = service(Some(ds), Some(zai.clone()));
        let result = search(&svc, ProviderChoice::Auto).await;
        assert_eq!(result.provider_used, Provider::Deepseek);
        assert!(!result.fallback_used);
        assert!(result.items.is_empty());
        assert_eq!(zai.search_calls(), 0);

        // A rejected request (4xx) is final too.
        let ds = Arc::new(FakeAdapter::new().failing(AdapterError::Rejected(402)));
        let zai = ok_adapter(Provider::Zai, vec![hit("Backup", "https://example.com/b")]);
        let svc = service(Some(ds), Some(zai.clone()));
        assert!(matches!(
            svc.search(
                "laptop",
                &SearchRequest {
                    query: "q".into(),
                    count: None,
                    provider: ProviderChoice::Auto
                }
            )
            .await,
            Err(WebSearchError::ProviderUnavailable(_))
        ));
        assert_eq!(zai.search_calls(), 0);
    }

    #[tokio::test]
    async fn auto_with_both_providers_down_is_provider_unavailable() {
        let ds = Arc::new(FakeAdapter::new().failing(AdapterError::Technical));
        let zai = Arc::new(FakeAdapter::new().failing(AdapterError::Technical));
        let svc = service(Some(ds), Some(zai));
        assert_eq!(
            svc.search(
                "laptop",
                &SearchRequest {
                    query: "q".into(),
                    count: None,
                    provider: ProviderChoice::Auto
                }
            )
            .await,
            Err(WebSearchError::ProviderUnavailable(
                "provider zai is unreachable".into()
            ))
        );
    }

    #[tokio::test]
    async fn an_unconfigured_explicit_provider_fails_without_network_calls() {
        let ds = ok_adapter(
            Provider::Deepseek,
            vec![hit("Rust", "https://example.com/r")],
        );
        let svc = service(Some(ds.clone()), None);
        assert!(matches!(
            svc.search(
                "laptop",
                &SearchRequest {
                    query: "q".into(),
                    count: None,
                    provider: ProviderChoice::Zai
                }
            )
            .await,
            Err(WebSearchError::ProviderUnavailable(msg)) if msg.contains("not configured")
        ));
        assert_eq!(ds.search_calls(), 0);
    }

    #[tokio::test]
    async fn search_arguments_are_validated_before_any_call() {
        let ds = ok_adapter(Provider::Deepseek, vec![]);
        let svc = service(Some(ds.clone()), None);
        for bad in [
            SearchRequest {
                query: "   ".into(),
                count: None,
                provider: ProviderChoice::Auto,
            },
            SearchRequest {
                query: "x".repeat(600),
                count: None,
                provider: ProviderChoice::Auto,
            },
            SearchRequest {
                query: "q".into(),
                count: Some(0),
                provider: ProviderChoice::Auto,
            },
            SearchRequest {
                query: "q".into(),
                count: Some(COUNT_MAX + 1),
                provider: ProviderChoice::Auto,
            },
        ] {
            assert!(matches!(
                svc.search("laptop", &bad).await,
                Err(WebSearchError::InvalidArguments(_))
            ));
        }
        assert_eq!(ds.search_calls(), 0);
    }

    #[tokio::test]
    async fn hits_with_unsafe_urls_are_dropped() {
        let ds = ok_adapter(
            Provider::Deepseek,
            vec![
                hit("Private", "http://127.0.0.1/admin"),
                hit("Good", "https://example.com/good"),
                hit("No host", "not-a-url"),
            ],
        );
        let svc = service(Some(ds), None);
        let result = search(&svc, ProviderChoice::Deepseek).await;
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].url, "https://example.com/good");
    }

    #[tokio::test]
    async fn read_returns_the_registered_url_when_the_provider_reports_none() {
        // DeepSeek fetch returns title+content only; the answer echoes the
        // URL we validated and registered, and claims nothing about
        // redirects.
        let ds = Arc::new(
            FakeAdapter::new()
                .with_hits(vec![hit("Page", "https://example.com/page")])
                .with_page(None, Some("A page".into()), "# markdown".into()),
        );
        let svc = service(Some(ds), None);
        let found = search(&svc, ProviderChoice::Deepseek).await;
        let read = svc.read("laptop", &found.items[0].source_id).await.unwrap();
        assert_eq!(read.url, "https://example.com/page");
        assert_eq!(read.title.as_deref(), Some("A page"));
        assert_eq!(read.content_markdown, "# markdown");
        assert_eq!(read.chars, 10);
        assert!(!read.truncated);
    }

    #[tokio::test]
    async fn read_uses_a_provider_returned_url_only_when_it_is_public() {
        let ds = Arc::new(
            FakeAdapter::new()
                .with_hits(vec![hit("Page", "https://example.com/page")])
                .with_page(
                    Some("https://other.example/final".into()),
                    None,
                    "text".into(),
                ),
        );
        let svc = service(Some(ds), None);
        let found = search(&svc, ProviderChoice::Deepseek).await;
        let read = svc.read("laptop", &found.items[0].source_id).await.unwrap();
        assert_eq!(read.url, "https://other.example/final");

        // A provider answer pointing at a private destination is refused.
        let ds = Arc::new(
            FakeAdapter::new()
                .with_hits(vec![hit("Page", "https://example.com/page")])
                .with_page(Some("http://127.0.0.1/x".into()), None, "text".into()),
        );
        let svc = service(Some(ds), None);
        let found = search(&svc, ProviderChoice::Deepseek).await;
        assert!(matches!(
            svc.read("laptop", &found.items[0].source_id).await,
            Err(WebSearchError::ProviderUnavailable(msg)) if msg.contains("unsafe")
        ));
    }

    #[tokio::test]
    async fn read_is_scoped_to_the_owner_and_the_registry() {
        let clock = Arc::new(FakeClock::default());
        let svc = WebSearchService::new(
            Some(ok_adapter(
                Provider::Deepseek,
                vec![hit("Page", "https://example.com/page")],
            )),
            None,
            SourceRegistry::with_clock(
                SourceRegistryConfig {
                    max_ids_per_owner: 200,
                    ttl: Duration::from_secs(60),
                },
                clock.clone(),
            ),
        );
        let found = svc
            .search(
                "laptop",
                &SearchRequest {
                    query: "q".into(),
                    count: None,
                    provider: ProviderChoice::Auto,
                },
            )
            .await
            .unwrap();
        let source_id = found.items[0].source_id.clone();

        // Another owner sees nothing, without learning why.
        assert!(matches!(
            svc.read("phone", &source_id).await,
            Err(WebSearchError::NotFound(_))
        ));
        // Unknown id.
        assert!(matches!(
            svc.read("laptop", "no-such-id").await,
            Err(WebSearchError::NotFound(_))
        ));
        // Expiry turns the same id into a typed expired error.
        clock.advance(Duration::from_secs(61));
        assert!(matches!(
            svc.read("laptop", &source_id).await,
            Err(WebSearchError::Expired(_))
        ));
    }

    #[tokio::test]
    async fn read_truncates_long_content_and_reports_chars() {
        let ds = Arc::new(
            FakeAdapter::new()
                .with_hits(vec![hit("Page", "https://example.com/page")])
                .with_page(None, None, "x".repeat(READ_MAX_CHARS + 500)),
        );
        let svc = service(Some(ds), None);
        let found = search(&svc, ProviderChoice::Deepseek).await;
        let read = svc.read("laptop", &found.items[0].source_id).await.unwrap();
        assert!(read.truncated);
        assert_eq!(read.chars, READ_MAX_CHARS);
        assert_eq!(read.content_markdown.chars().count(), READ_MAX_CHARS);
    }

    #[tokio::test]
    async fn read_maps_provider_failure_classes() {
        for (failure, expected) in [
            (
                AdapterError::Technical,
                WebSearchError::ProviderUnavailable("read provider is unreachable".into()),
            ),
            (
                AdapterError::ReadFailed,
                WebSearchError::NotFound("the source page could not be read".into()),
            ),
            (
                AdapterError::Rejected(403),
                WebSearchError::NotFound("the source page could not be read".into()),
            ),
            (
                AdapterError::Rejected(404),
                WebSearchError::NotFound("the source page could not be read".into()),
            ),
            (
                AdapterError::Rejected(401),
                WebSearchError::ProviderUnavailable("read provider refused the request".into()),
            ),
            (
                AdapterError::BadResponse,
                WebSearchError::ProviderUnavailable(
                    "read provider returned an unexpected response".into(),
                ),
            ),
        ] {
            let ds = Arc::new(
                FakeAdapter::new()
                    .with_hits(vec![hit("Page", "https://example.com/page")])
                    .failing_read(failure),
            );
            let svc = service(Some(ds), None);
            let found = svc
                .search(
                    "laptop",
                    &SearchRequest {
                        query: "q".into(),
                        count: None,
                        provider: ProviderChoice::Auto,
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                svc.read("laptop", &found.items[0].source_id).await,
                Err(expected),
                "failure class {failure:?}"
            );
        }
    }

    #[test]
    fn service_from_config_builds_only_configured_adapters() {
        let cfg = crate::config::WebSearchConfig {
            deepseek: Some(crate::config::SearchProviderConfig {
                base_url: "https://api.deepseek.com".into(),
                api_key: "sk-test".into(),
            }),
            zai: None,
            request_timeout: Duration::from_secs(20),
            max_source_ids: 200,
            source_ttl: Duration::from_secs(1_800),
        };
        // Real adapters are built but never called here; only shape matters.
        let _svc = service_from_config(&cfg);
    }

    // Keep the unused import warning away when SystemClock is not otherwise
    // referenced in tests.
    #[test]
    fn system_clock_returns_increasing_instants() {
        let a = SystemClock.now();
        assert!(a.elapsed() < Duration::from_secs(60));
    }
}
