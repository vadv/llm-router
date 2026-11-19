// Health reports the state of the process and its components.
// Degraded is not dead: inference can keep serving while history is not
// written. This endpoint is unauthenticated liveness surface: booleans and
// timestamps are public, but upstream error texts are not — an upstream can
// echo parts of a request back in an error, so the strings are shown only to
// a caller that presented a client key.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::management::authorize;
use crate::api::ApiState;

/// Live check. `status` is `ok` only when every component is healthy;
/// otherwise `degraded` with the failing parts named.
pub async fn health(State(state): State<Arc<ApiState>>, headers: HeaderMap) -> Response {
    // Any valid client key unlocks the error texts; liveness stays public.
    let trusted = authorize(&state, &headers).is_none();
    let mut components = serde_json::Map::new();
    let mut all_ok = true;

    // A poisoned lock means a component panicked; report it degraded.
    for (name, alive) in [
        ("catalog", ping_of(&state.models)),
        ("balances", ping_of(&state.balances)),
    ] {
        all_ok &= alive;
        components.insert(name.into(), json!({ "ok": alive }));
    }

    // The event log is best-effort: a dead events database degrades the
    // management view, not inference. It reports as its own component.
    let events_alive = state.events.ping();
    all_ok &= events_alive;
    components.insert("events".into(), json!({ "ok": events_alive }));
    // The knowledge base serves the management view only; a dead database
    // degrades it, not inference.
    let knowledge_alive = state.knowledge.ping();
    all_ok &= knowledge_alive;
    components.insert("knowledge".into(), json!({ "ok": knowledge_alive }));
    // History: the storage must answer and the last write must have
    // succeeded. Serving inference while records are lost is degradation,
    // not full health. The writer counters surface losses even while the
    // database still answers pings.
    let history_alive = ping_of(&state.history);
    let last_write_error = state.history_writes.lock().unwrap().clone();
    let stats = state.history_writer.stats();
    all_ok &= history_alive && last_write_error.is_none();
    components.insert(
        "requests".into(),
        json!({
            "ok": history_alive && last_write_error.is_none(),
            "detail": match (&last_write_error, trusted) {
                (None, _) => "alive",
                (Some(err), true) => err.as_str(),
                (Some(_), false) => "write failed",
            },
            "queue_bytes": state.history_writer.queued_bytes(),
            "dropped_total": stats.dropped_total,
            "written_total": stats.written_total,
        }),
    );

    // Schedule: the latest catalog refresh outcome per connection. A
    // failed poll degrades the component but never erases the last good
    // snapshot.
    let refresh = state.catalog_refresh.lock().unwrap().clone();
    let refresh_ok = refresh.values().all(|r| r.last_error.is_none());
    all_ok &= refresh_ok;
    components.insert(
        "schedule".into(),
        json!({
            "ok": refresh_ok,
            "providers": refresh.iter().map(|(id, r)| {
                (id.as_str().to_string(), json!({
                    "last_success_unix": r.last_success_unix,
                    "last_error": if trusted { r.last_error.as_deref() } else { None },
                }))
            }).collect::<serde_json::Map<String, _>>(),
        }),
    );

    let providers_alive = !state.providers.connections().is_empty();
    all_ok &= providers_alive;
    components.insert(
        "providers".into(),
        json!({ "ok": providers_alive, "count": state.providers.connections().len() }),
    );

    let uptime_unix = now_unix() - state.started_at_unix;
    let status = if all_ok { "ok" } else { "degraded" };
    let code = if all_ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        code,
        Json(json!({
            "status": status,
            "uptime_unix": uptime_unix,
            "components": components,
        })),
    )
        .into_response()
}

fn ping_of(store: &std::sync::Mutex<impl Pinger>) -> bool {
    store.lock().map(|s| s.ping()).unwrap_or(false)
}

/// The one query health needs from a store.
trait Pinger {
    fn ping(&self) -> bool;
}

impl Pinger for crate::storage::catalog::ModelStore {
    fn ping(&self) -> bool {
        crate::storage::catalog::ModelStore::ping(self)
    }
}

impl Pinger for crate::storage::history::HistoryStore {
    fn ping(&self) -> bool {
        self.ping()
    }
}

impl Pinger for crate::storage::balances::BalanceStore {
    fn ping(&self) -> bool {
        crate::storage::balances::BalanceStore::ping(self)
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::api::tests_support::test_state;
    use crate::schedule::RefreshStatus;

    fn headers(secret: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {secret}").parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn fresh_state_is_healthy() {
        let state = test_state();
        let response = health(State(Arc::new(state)), HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = body_of(response).await;
        assert_eq!(body["status"], "ok");
        assert_eq!(body["components"]["requests"]["ok"], true);
        assert!(body["uptime_unix"].is_u64(), "uptime must be present");
    }

    #[tokio::test]
    async fn history_write_failure_degrades_but_keeps_serving() {
        let state = test_state();
        *state.history_writes.lock().unwrap() = Some("attempt insert failed".into());
        let response = health(State(Arc::new(state)), headers("secret-one")).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = body_of(response).await;
        assert_eq!(body["status"], "degraded");
        assert_eq!(
            body["components"]["requests"]["detail"],
            "attempt insert failed"
        );
        assert_eq!(body["components"]["catalog"]["ok"], true, "others stay ok");
    }

    #[tokio::test]
    async fn history_counters_report_losses_and_queue_depth() {
        // A summary bigger than the whole budget is dropped whole; the
        // counters must show the loss even while the storage answers
        // pings.
        use crate::history::{AttemptSummary, RequestSummary};
        let state = test_state();
        let big = RequestSummary {
            id: "oversized".to_owned(),
            key_alias: "m5".to_owned(),
            metamodel: "glm".to_owned(),
            started_at_unix: 100,
            finished_at_unix: 109,
            outcome: "ok".to_owned(),
            input: Some(crate::history::Preview {
                text: "x".repeat(64 * 1024 * 1024),
                truncated: false,
            }),
            declared_tools: None,
            issues: vec![],
            attempts: vec![AttemptSummary {
                provider_id: "zai".to_owned(),
                upstream_id: "glm-5.3".to_owned(),
                started_at_unix: 100,
                finished_at_unix: 109,
                result: "ok".to_owned(),
                error: None,
                error_class: None,
                duration_ms: None,
                switch_reason: None,
                input_tokens: Some(1),
                output_tokens: Some(2),
                cost: None,
                response: None,
                tool_calls: Default::default(),
                issues: vec![],
            }],
        };
        state.history_writer.enqueue(big).unwrap_err();
        let response = health(State(Arc::new(state)), headers("secret-one")).await;
        let body = body_of(response).await;
        assert_eq!(body["components"]["requests"]["dropped_total"], 1);
        assert!(body["components"]["requests"]["queue_bytes"].is_u64());
    }

    #[tokio::test]
    async fn anonymous_caller_sees_status_but_no_error_text() {
        // Upstream error strings can quote parts of a request. Liveness is
        // public; the texts are not.
        let state = test_state();
        *state.history_writes.lock().unwrap() = Some("attempt insert failed: key k-1".into());
        state.catalog_refresh.lock().unwrap().insert(
            crate::model::ProviderId::new("prov"),
            RefreshStatus {
                last_success_unix: Some(100),
                last_error: Some("http 503".into()),
            },
        );
        let response = health(State(Arc::new(state)), HeaderMap::new()).await;
        let body = body_of(response).await;
        assert_eq!(body["status"], "degraded");
        assert_eq!(body["components"]["requests"]["detail"], "write failed");
        assert_eq!(
            body["components"]["schedule"]["providers"]["prov"]["last_error"],
            serde_json::Value::Null
        );
        assert_eq!(
            body["components"]["schedule"]["providers"]["prov"]["last_success_unix"],
            100
        );
    }

    #[tokio::test]
    async fn failed_catalog_refresh_degrades_schedule() {
        let state = test_state();
        state.catalog_refresh.lock().unwrap().insert(
            crate::model::ProviderId::new("prov"),
            RefreshStatus {
                last_success_unix: Some(100),
                last_error: Some("http 503".into()),
            },
        );
        let response = health(State(Arc::new(state)), headers("secret-one")).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = body_of(response).await;
        assert_eq!(body["components"]["schedule"]["ok"], false);
        assert_eq!(
            body["components"]["schedule"]["providers"]["prov"]["last_error"],
            "http 503"
        );
        assert_eq!(
            body["components"]["schedule"]["providers"]["prov"]["last_success_unix"], 100,
            "the last good snapshot stays visible"
        );
    }

    async fn body_of(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }
}
