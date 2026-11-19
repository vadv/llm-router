// Thin HTTP boundary for the chat web tools: search and read-source over
// WebSearchService. Handlers do auth, parsing, and error mapping only —
// provider choice, fallback, and the source registry live in the service.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::{ApiState, api_error, bearer_secret};
use crate::web_search::{ProviderChoice, ReadResult, SearchRequest, SearchResult, WebSearchError};

/// The owner: the alias of the presented client key. Server-side identity;
/// a model never supplies it. None = reject with `unauthorized()`.
pub(crate) fn owner_alias(state: &ApiState, headers: &HeaderMap) -> Option<String> {
    bearer_secret(headers)
        .and_then(|secret| state.keys.authenticate(&secret))
        .map(str::to_owned)
}

pub(crate) fn unauthorized() -> Response {
    api_error(
        StatusCode::UNAUTHORIZED,
        "invalid_api_key",
        "missing or invalid API key",
    )
}

/// Typed error mapping; the message is a fixed safe sentence, never a
/// provider body or credential.
pub(crate) fn web_error(error: WebSearchError) -> Response {
    match error {
        WebSearchError::InvalidArguments(message) => {
            api_error(StatusCode::BAD_REQUEST, "invalid_arguments", &message)
        }
        WebSearchError::ProviderUnavailable(message) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            &message,
        ),
        WebSearchError::NotFound(message) => {
            api_error(StatusCode::NOT_FOUND, "not_found", &message)
        }
        WebSearchError::Expired(message) => api_error(StatusCode::GONE, "expired", &message),
    }
}

fn bad(message: &str) -> Response {
    api_error(StatusCode::BAD_REQUEST, "invalid_arguments", message)
}

/// POST /v1/chat/search {query, count?, provider?}
pub async fn search(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let Some(service) = state.chat.web_search.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "web search is not configured",
        );
    };
    let Some(query) = body["query"].as_str() else {
        return bad("query (string) is required");
    };
    let count = match &body["count"] {
        serde_json::Value::Null => None,
        value => match value.as_u64() {
            Some(n) => Some(n as u32),
            None => return bad("count must be a positive integer"),
        },
    };
    let provider = match &body["provider"] {
        serde_json::Value::Null => ProviderChoice::Auto,
        value => match value.as_str().and_then(ProviderChoice::from_str) {
            Some(choice) => choice,
            None => return bad("provider must be auto, deepseek, or zai"),
        },
    };
    match service
        .search(
            &owner,
            &SearchRequest {
                query: query.to_owned(),
                count,
                provider,
            },
        )
        .await
    {
        Ok(result) => Json(search_json(&result)).into_response(),
        Err(error) => web_error(error),
    }
}

fn search_json(result: &SearchResult) -> serde_json::Value {
    json!({
        "items": result.items.iter().map(|item| {
            let mut value = json!({
                "source_id": item.source_id,
                "title": item.title,
                "url": item.url,
            });
            if let Some(snippet) = &item.snippet {
                value["snippet"] = json!(snippet);
            }
            value
        }).collect::<Vec<_>>(),
        "provider_used": result.provider_used.as_str(),
        "fallback_used": result.fallback_used,
    })
}

/// POST /v1/chat/read-source {source_id}
pub async fn read_source(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let Some(service) = state.chat.web_search.as_ref() else {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider_unavailable",
            "web search is not configured",
        );
    };
    let Some(source_id) = body["source_id"].as_str() else {
        return bad("source_id (string) is required");
    };
    match service.read(&owner, source_id).await {
        Ok(page) => Json(read_json(&page)).into_response(),
        Err(error) => web_error(error),
    }
}

fn read_json(page: &ReadResult) -> serde_json::Value {
    let mut value = json!({
        "url": page.url,
        "content_markdown": page.content_markdown,
        "chars": page.chars,
        "truncated": page.truncated,
    });
    if let Some(title) = &page.title {
        value["title"] = json!(title);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests_support::chat_state;
    use crate::web_search::fake::FakeAdapter;
    use crate::web_search::source_registry::{FakeClock, SourceRegistry, SourceRegistryConfig};
    use crate::web_search::{ProviderHit, WebSearchService};
    use std::sync::Arc;
    use std::time::Duration;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn hit(url: &str) -> ProviderHit {
        ProviderHit {
            title: "A page".into(),
            url: url.into(),
            snippet: Some("about it".into()),
        }
    }

    fn service(clock: FakeClock, search_failure: bool) -> WebSearchService {
        let mut fake = FakeAdapter::new().with_hits(vec![hit("https://example.com/page")]);
        if search_failure {
            fake = fake.failing(crate::web_search::AdapterError::Technical);
        }
        WebSearchService::new(
            Some(Arc::new(fake)),
            None,
            SourceRegistry::with_clock(
                SourceRegistryConfig {
                    max_ids_per_owner: 200,
                    ttl: Duration::from_secs(60),
                },
                clock,
            ),
        )
    }

    async fn serve(state: Arc<ApiState>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = crate::api::routes(state);
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        format!("http://{addr}")
    }

    fn client(secret: &str) -> reqwest::Client {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("authorization", format!("Bearer {secret}").parse().unwrap());
        reqwest::Client::builder()
            .default_headers(headers)
            .build()
            .unwrap()
    }

    async fn search_ok(base: &str, secret: &str) -> (String, serde_json::Value) {
        let body = client(secret)
            .post(format!("{base}/v1/chat/search"))
            .json(&serde_json::json!({"query": "rust allocator", "count": 3}))
            .send()
            .await
            .unwrap();
        assert_eq!(body.status(), reqwest::StatusCode::OK);
        let value: serde_json::Value = body.json().await.unwrap();
        assert_eq!(value["provider_used"], "deepseek");
        assert_eq!(value["fallback_used"], false);
        let source_id = value["items"][0]["source_id"].as_str().unwrap().to_owned();
        (source_id, value)
    }

    #[tokio::test]
    async fn search_then_read_happy_path() {
        let svc = service(FakeClock::default(), false);
        let base = serve(Arc::new(chat_state(Some(svc)))).await;

        let (source_id, value) = search_ok(&base, "secret-one").await;
        assert_eq!(value["items"][0]["url"], "https://example.com/page");
        assert_eq!(value["items"][0]["snippet"], "about it");

        let read = client("secret-one")
            .post(format!("{base}/v1/chat/read-source"))
            .json(&serde_json::json!({"source_id": source_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(read.status(), reqwest::StatusCode::OK);
        let page: serde_json::Value = read.json().await.unwrap();
        assert_eq!(page["url"], "https://example.com/page");
        assert!(page["content_markdown"].is_string());
        assert_eq!(page["truncated"], false);
    }

    #[tokio::test]
    async fn routes_require_a_key() {
        let svc = service(FakeClock::default(), false);
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        for path in ["/v1/chat/search", "/v1/chat/read-source"] {
            let response = reqwest::Client::new()
                .post(format!("{base}{path}"))
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED,
                "{path}"
            );
        }
    }

    #[tokio::test]
    async fn unconfigured_web_search_is_provider_unavailable() {
        let base = serve(Arc::new(chat_state(None))).await;
        let response = client("secret-one")
            .post(format!("{base}/v1/chat/search"))
            .json(&serde_json::json!({"query": "q"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "provider_unavailable");
    }

    #[tokio::test]
    async fn invalid_arguments_map_to_typed_errors() {
        let svc = service(FakeClock::default(), false);
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        let client = client("secret-one");
        for (body, message) in [
            (serde_json::json!({}), "query"),
            (serde_json::json!({"query": "q", "count": 0}), "count"),
            (
                serde_json::json!({"query": "q", "provider": "google"}),
                "provider",
            ),
        ] {
            let response = client
                .post(format!("{base}/v1/chat/search"))
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::BAD_REQUEST,
                "{message}"
            );
            let error: serde_json::Value = response.json().await.unwrap();
            assert_eq!(error["error"]["type"], "invalid_arguments");
        }
        let response = client
            .post(format!("{base}/v1/chat/read-source"))
            .json(&serde_json::json!({"source_id": ""}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn unknown_and_foreign_source_ids_are_not_found() {
        let svc = service(FakeClock::default(), false);
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        let (source_id, _) = search_ok(&base, "secret-one").await;

        // Unknown id.
        let response = client("secret-one")
            .post(format!("{base}/v1/chat/read-source"))
            .json(&serde_json::json!({"source_id": "00000000000000000000000000000000"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "not_found");

        // Another owner's id is indistinguishable from unknown.
        let response = client("secret-two")
            .post(format!("{base}/v1/chat/read-source"))
            .json(&serde_json::json!({"source_id": source_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "not_found");
    }

    #[tokio::test]
    async fn expired_source_id_maps_to_expired() {
        let clock = FakeClock::default();
        let svc = WebSearchService::new(
            Some(Arc::new(
                FakeAdapter::new().with_hits(vec![hit("https://example.com/page")]),
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
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        let (source_id, _) = search_ok(&base, "secret-one").await;
        clock.advance(Duration::from_secs(61));

        let response = client("secret-one")
            .post(format!("{base}/v1/chat/read-source"))
            .json(&serde_json::json!({"source_id": source_id}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::GONE);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "expired");
    }

    #[tokio::test]
    async fn provider_down_maps_to_provider_unavailable() {
        // A dead local port answers nothing: the technical failure path.
        let server = MockServer::start().await;
        let dead_url = server.uri();
        drop(server);
        let adapter = crate::web_search::deepseek::DeepseekAdapter::new(
            reqwest::Client::builder()
                .timeout(Duration::from_millis(200))
                .build()
                .unwrap(),
            &dead_url,
            "sk-test",
        );
        let svc = WebSearchService::new(
            Some(Arc::new(adapter)),
            None,
            SourceRegistry::new(SourceRegistryConfig {
                max_ids_per_owner: 200,
                ttl: Duration::from_secs(60),
            }),
        );
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        let response = client("secret-one")
            .post(format!("{base}/v1/chat/search"))
            .json(&serde_json::json!({"query": "q"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["error"]["type"], "provider_unavailable");
    }

    #[tokio::test]
    async fn provider_5xx_triggers_the_zai_fallback_over_http() {
        // DeepSeek answers 500; auto must serve from Z.AI.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/tools/search"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/api/paas/v4/web_search"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "search_result": [{
                    "title": "From Z.AI",
                    "content": "snippet",
                    "link": "https://example.com/zai"
                }]
            })))
            .mount(&server)
            .await;
        let http = reqwest::Client::new();
        let svc = WebSearchService::new(
            Some(Arc::new(crate::web_search::deepseek::DeepseekAdapter::new(
                http.clone(),
                &server.uri(),
                "sk-test",
            ))),
            Some(Arc::new(crate::web_search::zai::ZaiAdapter::new(
                http,
                &server.uri(),
                "zk-test",
                Duration::from_secs(5),
            ))),
            SourceRegistry::new(SourceRegistryConfig {
                max_ids_per_owner: 200,
                ttl: Duration::from_secs(60),
            }),
        );
        let base = serve(Arc::new(chat_state(Some(svc)))).await;
        let response = client("secret-one")
            .post(format!("{base}/v1/chat/search"))
            .json(&serde_json::json!({"query": "q", "provider": "auto"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["provider_used"], "zai");
        assert_eq!(body["fallback_used"], true);
        assert_eq!(body["items"][0]["url"], "https://example.com/zai");
    }
}
