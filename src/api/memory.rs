// Thin HTTP boundary for the chat memory tools. The owner is the alias of
// the presented client key; every store call is scoped by it. Input bounds
// come from config; the store itself uses parameterized SQL only.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use super::web::{owner_alias, unauthorized};
use super::{ApiState, api_error, internal_error};

fn bad(message: &str) -> Response {
    api_error(StatusCode::BAD_REQUEST, "invalid_arguments", message)
}

fn not_found(message: &str) -> Response {
    api_error(StatusCode::NOT_FOUND, "not_found", message)
}

/// Bound one text input: non-empty and within the configured limit. The
/// Err text is a safe message for invalid_arguments.
fn checked<'a>(text: &'a str, max_chars: usize, name: &str) -> Result<&'a str, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("{name} must be at most {max_chars} characters"));
    }
    Ok(trimmed)
}

fn entry_json(entry: &crate::storage::memory::MemoryEntry) -> serde_json::Value {
    json!({
        "id": entry.id,
        "topic": entry.topic,
        "note": entry.note,
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
    })
}

/// POST /v1/chat/memory/recall {query, limit?}
pub async fn recall(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let limits = state.chat.memory_limits;
    let Some(query) = body["query"].as_str() else {
        return bad("query (string) is required");
    };
    let query = match checked(query, limits.topic_max_chars, "query") {
        Ok(query) => query,
        Err(message) => return bad(&message),
    };
    let limit = match &body["limit"] {
        serde_json::Value::Null => limits.recall_limit_max,
        value => match value.as_u64() {
            Some(n) if (1..=limits.recall_limit_max as u64).contains(&n) => n as u32,
            _ => {
                return bad(&format!(
                    "limit must be between 1 and {}",
                    limits.recall_limit_max
                ));
            }
        },
    };
    // A short lock for one local SQLite query; no await inside.
    let entries = {
        let memory = state.chat.memory.lock().unwrap();
        match memory.recall(&owner, query, limit) {
            Ok(entries) => entries,
            Err(e) => return internal_error(&e.0),
        }
    };
    Json(json!({ "entries": entries.iter().map(entry_json).collect::<Vec<_>>() })).into_response()
}

/// POST /v1/chat/memory/save {topic, note} → {id}
pub async fn save(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let limits = state.chat.memory_limits;
    let (Some(topic), Some(note)) = (body["topic"].as_str(), body["note"].as_str()) else {
        return bad("topic and note (strings) are required");
    };
    let (topic, note) = match (
        checked(topic, limits.topic_max_chars, "topic"),
        checked(note, limits.note_max_chars, "note"),
    ) {
        (Ok(topic), Ok(note)) => (topic, note),
        (Err(message), _) | (_, Err(message)) => return bad(&message),
    };
    let id = {
        let mut memory = state.chat.memory.lock().unwrap();
        match memory.save(&owner, topic, note) {
            Ok(id) => id,
            Err(e) => return internal_error(&e.0),
        }
    };
    Json(json!({ "id": id })).into_response()
}

/// POST /v1/chat/memory/edit {id, topic, note} → {ok} or not_found
pub async fn edit(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let limits = state.chat.memory_limits;
    let Some(id) = body["id"].as_u64() else {
        return bad("id (integer) is required");
    };
    let (Some(topic), Some(note)) = (body["topic"].as_str(), body["note"].as_str()) else {
        return bad("topic and note (strings) are required");
    };
    let (topic, note) = match (
        checked(topic, limits.topic_max_chars, "topic"),
        checked(note, limits.note_max_chars, "note"),
    ) {
        (Ok(topic), Ok(note)) => (topic, note),
        (Err(message), _) | (_, Err(message)) => return bad(&message),
    };
    let changed = {
        let mut memory = state.chat.memory.lock().unwrap();
        match memory.edit(&owner, id as i64, topic, note) {
            Ok(changed) => changed,
            Err(e) => return internal_error(&e.0),
        }
    };
    if changed {
        Json(json!({ "ok": true })).into_response()
    } else {
        not_found("no memory entry with this id")
    }
}

/// POST /v1/chat/memory/delete {id} → {ok} or not_found
pub async fn delete(
    State(state): State<Arc<ApiState>>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    let Some(owner) = owner_alias(&state, &headers) else {
        return unauthorized();
    };
    let Some(id) = body["id"].as_u64() else {
        return bad("id (integer) is required");
    };
    let deleted = {
        let mut memory = state.chat.memory.lock().unwrap();
        match memory.delete(&owner, id as i64) {
            Ok(deleted) => deleted,
            Err(e) => return internal_error(&e.0),
        }
    };
    if deleted {
        Json(json!({ "ok": true })).into_response()
    } else {
        not_found("no memory entry with this id")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests_support::chat_state;

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

    async fn post(
        base: &str,
        secret: &str,
        path: &str,
        body: serde_json::Value,
    ) -> reqwest::Response {
        client(secret)
            .post(format!("{base}{path}"))
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn memory_crud_round_trip() {
        let base = serve(Arc::new(chat_state(None))).await;

        let saved = post(
            &base,
            "secret-one",
            "/v1/chat/memory/save",
            json!({"topic": "Coffee", "note": "beans in the blue tin"}),
        )
        .await;
        assert_eq!(saved.status(), reqwest::StatusCode::OK);
        let id = saved.json::<serde_json::Value>().await.unwrap()["id"]
            .as_i64()
            .unwrap();

        // Saved data is visible to recall.
        let recalled = post(
            &base,
            "secret-one",
            "/v1/chat/memory/recall",
            json!({"query": "coffee"}),
        )
        .await;
        let value: serde_json::Value = recalled.json().await.unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["entries"][0]["id"].as_i64(), Some(id));

        // Edit changes what recall finds.
        let edited = post(
            &base,
            "secret-one",
            "/v1/chat/memory/edit",
            json!({"id": id, "topic": "Tea", "note": "green loose leaf"}),
        )
        .await;
        assert_eq!(edited.status(), reqwest::StatusCode::OK);
        let recalled = post(
            &base,
            "secret-one",
            "/v1/chat/memory/recall",
            json!({"query": "Tea"}),
        )
        .await;
        let value: serde_json::Value = recalled.json().await.unwrap();
        assert_eq!(value["entries"][0]["note"], "green loose leaf");

        let deleted = post(
            &base,
            "secret-one",
            "/v1/chat/memory/delete",
            json!({"id": id}),
        )
        .await;
        assert_eq!(deleted.status(), reqwest::StatusCode::OK);
        let recalled = post(
            &base,
            "secret-one",
            "/v1/chat/memory/recall",
            json!({"query": "Tea"}),
        )
        .await;
        let value: serde_json::Value = recalled.json().await.unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 0);

        // Deleting again is a typed not-found.
        let deleted = post(
            &base,
            "secret-one",
            "/v1/chat/memory/delete",
            json!({"id": id}),
        )
        .await;
        assert_eq!(deleted.status(), reqwest::StatusCode::NOT_FOUND);
        let error: serde_json::Value = deleted.json().await.unwrap();
        assert_eq!(error["error"]["type"], "not_found");
    }

    #[tokio::test]
    async fn memory_is_isolated_between_owners() {
        let base = serve(Arc::new(chat_state(None))).await;
        let saved = post(
            &base,
            "secret-one",
            "/v1/chat/memory/save",
            json!({"topic": "Keys", "note": "in the drawer"}),
        )
        .await;
        let id = saved.json::<serde_json::Value>().await.unwrap()["id"]
            .as_i64()
            .unwrap();

        let recalled = post(
            &base,
            "secret-two",
            "/v1/chat/memory/recall",
            json!({"query": "keys"}),
        )
        .await;
        let value: serde_json::Value = recalled.json().await.unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 0);

        // The foreign id cannot be edited or deleted.
        for (path, body) in [
            (
                "/v1/chat/memory/edit",
                json!({"id": id, "topic": "x", "note": "y"}),
            ),
            ("/v1/chat/memory/delete", json!({"id": id})),
        ] {
            let response = post(&base, "secret-two", path, body).await;
            assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND, "{path}");
        }
        // The owner still sees the note.
        let recalled = post(
            &base,
            "secret-one",
            "/v1/chat/memory/recall",
            json!({"query": "drawer"}),
        )
        .await;
        let value: serde_json::Value = recalled.json().await.unwrap();
        assert_eq!(value["entries"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn memory_bounds_are_enforced() {
        let base = serve(Arc::new(chat_state(None))).await;
        // chat_state uses the default limits: topic 200, note 4000, limit 20.
        let long_topic = "t".repeat(201);
        let long_note = "n".repeat(4_001);
        for (path, body) in [
            (
                "/v1/chat/memory/save",
                json!({"topic": long_topic, "note": "n"}),
            ),
            (
                "/v1/chat/memory/save",
                json!({"topic": "t", "note": long_note}),
            ),
            ("/v1/chat/memory/save", json!({"topic": "  ", "note": "n"})),
            ("/v1/chat/memory/save", json!({"topic": "t", "note": ""})),
            ("/v1/chat/memory/recall", json!({"query": "q", "limit": 0})),
            ("/v1/chat/memory/recall", json!({"query": "q", "limit": 21})),
            ("/v1/chat/memory/recall", json!({"query": ""})),
        ] {
            let response = post(&base, "secret-one", path, body).await;
            assert_eq!(
                response.status(),
                reqwest::StatusCode::BAD_REQUEST,
                "{path}"
            );
            let error: serde_json::Value = response.json().await.unwrap();
            assert_eq!(error["error"]["type"], "invalid_arguments");
        }
    }

    #[tokio::test]
    async fn memory_routes_require_a_key() {
        let base = serve(Arc::new(chat_state(None))).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/chat/memory/recall"))
            .json(&json!({"query": "q"}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    }
}
