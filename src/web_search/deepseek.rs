// DeepSeek search/read adapter against the documented Search & Fetch API
// (api-docs.deepseek.com, guides/search). Bearer auth with a dedicated key.
// shortcut: response shapes follow the public API reference, not a recorded
// live fixture; verify against a real response before relying on edge
// fields. The provider stays off until a matching config entry exists.

use futures_util::future::BoxFuture;
use serde::Deserialize;

use super::{
    AdapterError, ProviderHit, ProviderReadPage, SearchAdapter, bounded_text, classify_read_status,
    classify_search_status,
};
/// A search answer holds at most 50 short entries; 1 MiB is generous.
const SEARCH_MAX_BYTES: usize = 1024 * 1024;
/// Fetch returns full-page markdown; 4 MiB covers it before char truncation.
const FETCH_MAX_BYTES: usize = 4 * 1024 * 1024;

pub struct DeepseekAdapter {
    http: reqwest::Client,
    search_url: String,
    fetch_url: String,
    api_key: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    results: Vec<SearchEntry>,
}

#[derive(Deserialize)]
struct SearchEntry {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    snippet: Option<String>,
}

#[derive(Deserialize)]
struct FetchResponse {
    #[serde(default)]
    title: Option<String>,
    content: String,
}

impl DeepseekAdapter {
    pub fn new(http: reqwest::Client, base_url: &str, api_key: &str) -> Self {
        let base = base_url.trim_end_matches('/');
        Self {
            http,
            search_url: format!("{base}/v1/tools/search"),
            fetch_url: format!("{base}/v1/tools/fetch"),
            api_key: api_key.to_owned(),
        }
    }
}

impl SearchAdapter for DeepseekAdapter {
    fn search<'a>(
        &'a self,
        query: &'a str,
        count: u32,
    ) -> BoxFuture<'a, Result<Vec<ProviderHit>, AdapterError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(&self.search_url)
                .bearer_auth(&self.api_key)
                .json(&serde_json::json!({ "query": query, "count": count }))
                .send()
                .await
                .map_err(|_| AdapterError::Technical)?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Err(classify_search_status(status));
            }
            let text = bounded_text(response, SEARCH_MAX_BYTES).await?;
            let parsed: SearchResponse =
                serde_json::from_str(&text).map_err(|_| AdapterError::BadResponse)?;
            Ok(parsed
                .results
                .into_iter()
                .filter_map(|entry| {
                    Some(ProviderHit {
                        title: entry.title?,
                        url: entry.url?,
                        snippet: entry.snippet,
                    })
                })
                .collect())
        })
    }

    fn read<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<ProviderReadPage, AdapterError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(&self.fetch_url)
                .bearer_auth(&self.api_key)
                .json(&serde_json::json!({ "url": url }))
                .send()
                .await
                .map_err(|_| AdapterError::Technical)?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Err(classify_read_status(status));
            }
            let text = bounded_text(response, FETCH_MAX_BYTES).await?;
            let parsed: FetchResponse =
                serde_json::from_str(&text).map_err(|_| AdapterError::BadResponse)?;
            // The Fetch API returns no URL; the caller keeps the URL it
            // validated and registered.
            Ok(ProviderReadPage {
                url: None,
                title: parsed.title,
                content_markdown: parsed.content,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn adapter(server: &MockServer) -> DeepseekAdapter {
        DeepseekAdapter::new(reqwest::Client::new(), &server.uri(), "sk-test")
    }

    #[tokio::test]
    async fn search_parses_the_documented_shape() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/tools/search"))
            .and(body_partial_json(
                serde_json::json!({"query": "rust", "count": 3}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "results": [
                    {
                        "rerank_score": 2.4,
                        "title": "Rust book",
                        "url": "https://example.com/rust",
                        "snippet": "The Rust language",
                        "summary": "longer summary",
                        "content": "",
                        "site_name": "Example",
                        "site_icon": null,
                        "date": "2026-06-01T00:00:00+00:00",
                        "authority": 3
                    },
                    { "title": "No url entry is skipped", "snippet": "x" }
                ]
            })))
            .mount(&server)
            .await;
        let hits = adapter(&server).search("rust", 3).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com/rust");
        assert_eq!(hits[0].snippet.as_deref(), Some("The Rust language"));
    }

    #[tokio::test]
    async fn search_classifies_statuses() {
        // A fresh server per status: stacked mocks would answer the first
        // matching one forever.
        for (status, expected) in [
            (500u16, AdapterError::Technical),
            (503, AdapterError::Technical),
            (429, AdapterError::Technical),
            (408, AdapterError::Technical),
            (400, AdapterError::Rejected(400)),
            (402, AdapterError::Rejected(402)),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/v1/tools/search"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            assert_eq!(
                adapter(&server).search("q", 1).await.unwrap_err(),
                expected,
                "status {status}"
            );
        }
    }

    #[tokio::test]
    async fn search_rejects_an_undocumented_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/tools/search"))
            .respond_with(ResponseTemplate::new(200).set_body_string("not json"))
            .mount(&server)
            .await;
        assert_eq!(
            adapter(&server).search("q", 1).await.unwrap_err(),
            AdapterError::BadResponse
        );
    }

    #[tokio::test]
    async fn read_parses_title_and_content_without_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/tools/fetch"))
            .and(body_partial_json(
                serde_json::json!({"url": "https://example.com/a"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "title": "A page",
                "content": "# markdown"
            })))
            .mount(&server)
            .await;
        let page = adapter(&server)
            .read("https://example.com/a")
            .await
            .unwrap();
        assert_eq!(page.url, None);
        assert_eq!(page.title.as_deref(), Some("A page"));
        assert_eq!(page.content_markdown, "# markdown");
    }

    #[tokio::test]
    async fn read_classifies_statuses() {
        for (status, expected) in [
            (500u16, AdapterError::Technical),
            (429, AdapterError::Technical),
            (404, AdapterError::ReadFailed),
            (403, AdapterError::ReadFailed),
            (402, AdapterError::Rejected(402)),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/v1/tools/fetch"))
                .respond_with(ResponseTemplate::new(status))
                .mount(&server)
                .await;
            assert_eq!(
                adapter(&server)
                    .read("https://example.com/a")
                    .await
                    .unwrap_err(),
                expected,
                "status {status}"
            );
        }
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_technical() {
        let adapter = DeepseekAdapter::new(
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_millis(300))
                .build()
                .unwrap(),
            "http://127.0.0.1:1",
            "sk-test",
        );
        assert_eq!(
            adapter.search("q", 1).await.unwrap_err(),
            AdapterError::Technical
        );
    }
}
