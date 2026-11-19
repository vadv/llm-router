// Conversation identity for client integrations.
//
// Priority: the x-session-id header (OpenRouter's standard affinity header;
// Pi clients send it with sendSessionAffinityHeaders) over a non-empty `user`
// body field over a hash of the message prefix. Custom X-*-Gateway headers
// are forbidden: a harness must not know it talks to a router. The value is
// only a conversation key for stickiness — never a secret, never logged.

use std::collections::hash_map::DefaultHasher;
use std::hash::Hasher;

use axum::http::HeaderMap;
use serde_json::Value;

/// Why the conversation could not be identified. Only an invalid
/// x-session-id is a client error; the other sources cannot fail.
#[derive(Debug, PartialEq, Eq)]
pub struct InvalidSessionHeader(pub String);

impl std::fmt::Display for InvalidSessionHeader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The rejected value is not echoed back: it is untrusted input.
        write!(
            f,
            "invalid x-session-id: must be 1-128 ASCII chars of [A-Za-z0-9._-]"
        )
    }
}
impl std::error::Error for InvalidSessionHeader {}

/// The conversation identifier for one request.
pub fn conversation_id(headers: &HeaderMap, body: &Value) -> Result<String, InvalidSessionHeader> {
    if let Some(value) = headers.get("x-session-id") {
        let value = value
            .to_str()
            .map_err(|_| InvalidSessionHeader(String::new()))?;
        if !is_valid_session_id(value) {
            return Err(InvalidSessionHeader(value.to_owned()));
        }
        return Ok(value.to_owned());
    }
    if let Some(user) = body.get("user").and_then(Value::as_str)
        && !user.is_empty()
    {
        return Ok(user.to_owned());
    }

    Ok(hash_prefix(body))
}

/// ASCII, 1-128 chars of [A-Za-z0-9._-] — the same alphabet the old gateway
/// accepted, so migrated clients keep working. No quoting, no spaces.
fn is_valid_session_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Identity without any client setup: the conversation's first messages.
/// The system message plus the first user message hash to a stable id, so
/// follow-up requests of one conversation collide (by design) and unrelated
/// conversations rarely do. A restart cannot change it — the keys are fixed.
fn hash_prefix(body: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    let messages = body.get("messages").and_then(Value::as_array);
    for role in ["system", "user"] {
        let message = messages
            .and_then(|ms| {
                ms.iter()
                    .find(|m| m.get("role").and_then(Value::as_str) == Some(role))
            })
            .map(|m| m.get("content").cloned().unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        hasher.write(role.as_bytes());
        // The serialized content: deterministic and stable for equal input.
        serde_json::to_writer(HashWriter(&mut hasher), &message).ok();
    }
    format!("hash:{:016x}", hasher.finish())
}

/// Feeds serialized JSON bytes into the hasher without allocating a string.
struct HashWriter<'a>(&'a mut DefaultHasher);

impl std::io::Write for HashWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.write(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    use serde_json::json;

    fn headers(session: Option<&str>) -> HeaderMap {
        let mut h = HeaderMap::new();
        if let Some(v) = session {
            h.insert("x-session-id", HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn the_header_wins_over_the_body() {
        let body = json!({"user": "u1", "messages": []});
        assert_eq!(
            conversation_id(&headers(Some("abc.def-1_2")), &body).unwrap(),
            "abc.def-1_2"
        );
    }

    #[test]
    fn the_user_field_is_used_when_no_header_is_sent() {
        let body = json!({"user": "phone", "messages": []});
        assert_eq!(conversation_id(&headers(None), &body).unwrap(), "phone");
    }

    #[test]
    fn an_empty_user_field_falls_through_to_the_hash() {
        let body = json!({"user": "", "messages": []});
        assert!(
            conversation_id(&headers(None), &body)
                .unwrap()
                .starts_with("hash:")
        );
    }

    #[test]
    fn an_invalid_header_is_rejected_not_fallen_back() {
        let body = json!({"user": "u1"});
        for bad in ["", "with space", "tab\t", "кириллица", &"x".repeat(129)] {
            // Non-ASCII bytes fail to_str before validation; both are errors.
            assert!(
                conversation_id(&headers(Some(bad)), &body).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    #[test]
    fn non_ascii_header_bytes_are_rejected() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-session-id",
            HeaderValue::from_bytes(&[0xff, 0xfe]).unwrap(),
        );
        assert!(conversation_id(&h, &json!({})).is_err());
    }

    #[test]
    fn the_same_prefix_hashes_to_the_same_conversation() {
        let body = json!({"messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "hello"}
        ]});
        let a = conversation_id(&headers(None), &body).unwrap();
        let b = conversation_id(&headers(None), &body).unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("hash:"));
    }

    #[test]
    fn a_different_prefix_is_a_different_conversation() {
        let body = |content: &str| {
            json!({"messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": content}
            ]})
        };
        assert_ne!(
            conversation_id(&headers(None), &body("hello")).unwrap(),
            conversation_id(&headers(None), &body("goodbye")).unwrap()
        );
    }

    #[test]
    fn a_later_user_message_does_not_change_the_identity() {
        // Only the prefix counts: the follow-up request of one conversation
        // repeats the earlier messages, and the tail is ignored.
        let start = json!({"messages": [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "first"},
        ]});
        let followup = json!({"messages": [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "second"},
        ]});
        assert_eq!(
            conversation_id(&headers(None), &start).unwrap(),
            conversation_id(&headers(None), &followup).unwrap()
        );
    }

    #[test]
    fn content_shapes_are_part_of_the_identity() {
        let text = json!({"messages": [
            {"role": "user", "content": "hi"}
        ]});
        let parts = json!({"messages": [
            {"role": "user", "content": [{"type": "text", "text": "hi"}]}
        ]});
        assert_ne!(
            conversation_id(&headers(None), &text).unwrap(),
            conversation_id(&headers(None), &parts).unwrap()
        );
    }

    #[test]
    fn no_messages_at_all_is_still_a_deterministic_identity() {
        let a = conversation_id(&headers(None), &json!({})).unwrap();
        let b = conversation_id(&headers(None), &json!({"messages": []})).unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("hash:"));
    }
}
