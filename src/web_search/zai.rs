// Z.AI search/read adapter against the documented Tool API
// (docs.z.ai, api-reference/tools/web-search and web-reader). Bearer auth
// with the existing subscription key; search-prime is the standard engine.
// shortcut: response shapes follow the public API reference, not a recorded
// live fixture; verify against a real response before relying on edge
// fields. The provider stays off until a matching config entry exists.

use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::Deserialize;

use super::{
    AdapterError, ProviderHit, ProviderReadPage, SearchAdapter, bounded_text, classify_read_status,
    classify_search_status,
};
const SEARCH_MAX_BYTES: usize = 1024 * 1024;
const READ_MAX_BYTES: usize = 4 * 1024 * 1024;

pub struct ZaiAdapter {
    http: reqwest::Client,
    search_url: String,
    reader_url: String,
    api_key: String,
    /// Reader-side timeout in seconds; the API documents 20 as its default,
    /// so the configured request timeout is forwarded as-is.
    read_timeout: Duration,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    search_result: Vec<SearchEntry>,
}

#[derive(Deserialize)]
struct SearchEntry {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    link: Option<String>,
}

#[derive(Deserialize)]
struct ReaderResponse {
    #[serde(default)]
    reader_result: Option<ReaderResult>,
}

#[derive(Deserialize)]
struct ReaderResult {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

impl ZaiAdapter {
    pub fn new(
        http: reqwest::Client,
        base_url: &str,
        api_key: &str,
        request_timeout: Duration,
    ) -> Self {
        let base = base_url.trim_end_matches('/');
        Self {
            http,
            search_url: format!("{base}/api/paas/v4/web_search"),
            reader_url: format!("{base}/api/paas/v4/reader"),
            api_key: api_key.to_owned(),
            read_timeout: request_timeout,
        }
    }
}

impl SearchAdapter for ZaiAdapter {
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
                .json(&serde_json::json!({
                    "search_engine": "search-prime",
                    "search_query": query,
                    "count": count,
                }))
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
                .search_result
                .into_iter()
                .filter_map(|entry| {
                    Some(ProviderHit {
                        title: entry.title?,
                        url: entry.link?,
                        // The reader summary doubles as the snippet.
                        snippet: entry.content,
                    })
                })
                .collect())
        })
    }

    fn read<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<ProviderReadPage, AdapterError>> {
        Box::pin(async move {
            let response = self
                .http
                .post(&self.reader_url)
                .bearer_auth(&self.api_key)
                .json(&serde_json::json!({
                    "url": url,
                    "timeout": self.read_timeout.as_secs(),
                    "return_format": "markdown",
                }))
                .send()
                .await
                .map_err(|_| AdapterError::Technical)?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return Err(classify_read_status(status));
            }
            let text = bounded_text(response, READ_MAX_BYTES).await?;
            let parsed: ReaderResponse =
                serde_json::from_str(&text).map_err(|_| AdapterError::BadResponse)?;
            let result = parsed.reader_result.ok_or(AdapterError::BadResponse)?;
            Ok(ProviderReadPage {
                // The documented field carries the page URL; the service
                // re-checks it as a public destination before use.
                url: result.url,
                title: result.title,
                content_markdown: result.content.unwrap_or_default(),
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn adapter(server: &MockServer) -> ZaiAdapter {
        ZaiAdapter::new(
            reqwest::Client::new(),
            &server.uri(),
            "zk-test",
            Duration::from_secs(20),
        )
    }

    #[tokio::test]
    async fn search_parses_the_documented_shape() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/paas/v4/web_search"))
            .and(body_partial_json(serde_json::json!({
                "search_engine": "search-prime",
                "search_query": "rust",
                "count": 2
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "abc",
                "created": 1_700_000_000,
                "search_result": [
                    {
                        "title": "Rust book",
                        "content": "The Rust language",
                        "link": "https://example.com/rust",
                        "media": "example.com",
                        "icon": "https://example.com/i.png",
                        "refer": "0",
                        "publish_date": "2026-06-01"
                    }
                ]
            })))
            .mount(&server)
            .await;
        let hits = adapter(&server).search("rust", 2).await.unwrap();
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
            (429, AdapterError::Technical),
            (400, AdapterError::Rejected(400)),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/paas/v4/web_search"))
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
    async fn read_parses_the_documented_shape() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/paas/v4/reader"))
            .and(body_partial_json(
                serde_json::json!({"url": "https://example.com/a"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "abc",
                "created": 1_700_000_000,
                "request_id": "req",
                "model": "reader",
                "reader_result": {
                    "content": "# page",
                    "description": "d",
                    "title": "A page",
                    "url": "https://example.com/a",
                    "external": { "stylesheet": {} },
                    "metadata": {}
                }
            })))
            .mount(&server)
            .await;
        let page = adapter(&server)
            .read("https://example.com/a")
            .await
            .unwrap();
        assert_eq!(page.url.as_deref(), Some("https://example.com/a"));
        assert_eq!(page.title.as_deref(), Some("A page"));
        assert_eq!(page.content_markdown, "# page");
    }

    #[tokio::test]
    async fn read_without_reader_result_is_a_bad_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/paas/v4/reader"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": 123,
                "message": "failed"
            })))
            .mount(&server)
            .await;
        assert_eq!(
            adapter(&server)
                .read("https://example.com/a")
                .await
                .unwrap_err(),
            AdapterError::BadResponse
        );
    }

    #[tokio::test]
    async fn read_classifies_statuses() {
        for (status, expected) in [
            (500u16, AdapterError::Technical),
            (404, AdapterError::ReadFailed),
            (402, AdapterError::Rejected(402)),
        ] {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/paas/v4/reader"))
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
}
