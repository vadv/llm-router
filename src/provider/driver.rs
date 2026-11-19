// The driver interface: the one boundary that is genuinely polymorphic.
// A driver instance knows its own endpoints and credentials, discovers its
// catalog, and executes one inference request on one upstream model.
//
// Error classification vocabulary is shared: DriverError and FailureClass
// live in routing::classify because routing owns their consequences; the
// driver decides which class a particular upstream response means.

pub use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use serde_json::Value;

use crate::routing::classify::DriverError;

/// Where this connection's model list comes from: exactly one source,
/// never a merge of both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CatalogMode {
    /// The upstream reports its models; config entries are ignored.
    Dynamic,
}

/// One model as the upstream reports it: an id and what it claims. No pool
/// membership, no credentials — schedule adds the connection's identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredModel {
    pub upstream_id: String,
    pub context_tokens: Option<u64>,
}

/// The client's inference request. The body is verbatim: the transport
/// substitutes the upstream model id and credentials; every other field —
/// including ones we do not know — passes through untouched. The
/// conversation identity rides along for drivers whose upstream
/// requires a session/affinity header (OpenCode Go's `x-opencode-session`);
/// drivers without such a contract ignore it.
#[derive(Debug, Clone)]
pub struct InferenceRequest {
    pub body: Value,
    /// The resolved conversation id (integration contract §2.5), never a
    /// raw client header value: it is already validated at the boundary.
    pub session_id: String,
}

/// One indicator of a connection's balance or subscription, as the
/// upstream reported it. Amounts stay verbatim strings:
/// the upstream's own representation, no re-typed number, no invented
/// precision. Schedule adds the connection's identity and the time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Indicator {
    /// What the indicator describes, e.g. "account" or "coding-plan".
    pub resource: String,
    /// The kind of indicator, e.g. "money", "tokens", "credits".
    pub metric: String,
    /// Currency or unit, e.g. "USD", "token"; None if not reported.
    pub unit: Option<String>,
    pub limit: Option<String>,
    pub usage: Option<String>,
    pub remaining: Option<String>,
    /// Usage window as reported, e.g. "5h", "weekly".
    pub window: Option<String>,
    pub resets_at_unix: Option<i64>,
}

/// The state of a local engine serving on the LAN, as it reported itself
/// (llama.cpp `/props`+`/slots`, Strata `/v1/status`). Everything the engine
/// did not report stays None: unknown, not zero.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LocalState {
    /// The engine's loaded model name, if reported.
    pub model: Option<String>,
    /// Whether the model is loaded and the engine can serve now.
    pub loaded: Option<bool>,
    /// Total concurrent requests the engine can run.
    pub slots: Option<u64>,
    /// Requests running right now.
    pub busy: Option<u64>,
}

/// The upstream's answer. Never a fully assembled generation text in RAM:
/// a stream stays a stream and is relayed as it arrives.
pub enum UpstreamResponse {
    /// Non-streaming: the complete upstream response body, verbatim.
    Complete(Value),
    /// Streaming: raw SSE bytes as they arrive. The observing layer parses
    /// usage from the events; it does not buffer the whole generation.
    Stream(BoxStream<'static, Result<Vec<u8>, DriverError>>),
}

pub trait Driver: Send + Sync {
    fn catalog_mode(&self) -> CatalogMode;

    /// The upstream's current model list, or a classified error. An error
    /// never becomes an empty catalog: the last snapshot stays in force.
    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>>;

    /// The connection's balance/subscription indicators, or a classified
    /// error. `Ok(None)` means this driver reports no indicators — an
    /// explicit "not supported", not an observation of zero.
    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>>;

    /// The state of a local engine (slots, busy, loaded model), or a
    /// classified error. `Ok(None)` means this connection is not a local
    /// engine and has no state to report.
    fn fetch_local_state(&self) -> BoxFuture<'_, Result<Option<LocalState>, DriverError>>;

    /// Execute one request on one upstream model. The model id is the
    /// upstream's own id, substituted by the caller; the request body is
    /// passed through apart from that.
    fn execute<'a>(
        &'a self,
        model: &'a str,
        request: &'a InferenceRequest,
    ) -> BoxFuture<'a, Result<UpstreamResponse, DriverError>>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scripted driver standing in for a real one: enough to prove the
    /// trait is object-safe and both response shapes travel through it.
    struct StubDriver {
        calls: AtomicUsize,
    }

    impl Driver for StubDriver {
        fn catalog_mode(&self) -> CatalogMode {
            CatalogMode::Dynamic
        }

        fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
            Box::pin(async {
                Ok(vec![DiscoveredModel {
                    upstream_id: "Vendor/Model-1:free".into(),
                    context_tokens: Some(128_000),
                }])
            })
        }

        fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
            Box::pin(async { Ok(None) })
        }

        fn fetch_local_state(&self) -> BoxFuture<'_, Result<Option<LocalState>, DriverError>> {
            Box::pin(async { Ok(None) })
        }

        fn execute<'a>(
            &'a self,
            model: &'a str,
            request: &'a InferenceRequest,
        ) -> BoxFuture<'a, Result<UpstreamResponse, DriverError>> {
            Box::pin(async move {
                self.calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(model, "Vendor/Model-1:free");
                // Unknown client fields survive into the driver untouched.
                assert!(request.body.get("future_field").is_some());
                let events = futures_util::stream::iter(
                    [b"data: {\"delta\":\"hi\"}".to_vec(), b"\n\n".to_vec()]
                        .into_iter()
                        .map(Ok::<_, DriverError>),
                );
                Ok(UpstreamResponse::Stream(Box::pin(events)))
            })
        }
    }

    #[tokio::test]
    async fn the_trait_is_object_safe_and_carries_both_response_shapes() {
        let driver: Box<dyn Driver> = Box::new(StubDriver {
            calls: AtomicUsize::new(0),
        });

        assert_eq!(driver.catalog_mode(), CatalogMode::Dynamic);
        let catalog = driver.fetch_catalog().await.unwrap();
        assert_eq!(catalog.len(), 1);
        assert_eq!(catalog[0].upstream_id, "Vendor/Model-1:free");

        let request = InferenceRequest {
            body: serde_json::json!({"model": "m", "future_field": {"nested": true}}),
            session_id: "conversation-1".into(),
        };
        match driver
            .execute("Vendor/Model-1:free", &request)
            .await
            .unwrap()
        {
            UpstreamResponse::Stream(mut stream) => {
                let first = stream.next().await.unwrap().unwrap();
                assert_eq!(first, b"data: {\"delta\":\"hi\"}".to_vec());
                let second = stream.next().await.unwrap().unwrap();
                assert_eq!(second, b"\n\n".to_vec());
                assert!(stream.next().await.is_none());
            }
            UpstreamResponse::Complete(_) => panic!("stub streams"),
        }
    }
}
