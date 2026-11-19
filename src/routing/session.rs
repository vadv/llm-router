// Conversation→model bindings. RAM only, no TTL, no persistence: by owner
// decision a restart resets conversations to a fresh topmost selection.
// The store records the current binding; the router decides when to pin.
// shortcut: no size cap or eviction (single owner, few harness conversations,
// restart resets); revisit if bindings ever grow unbounded.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::model::ModelId;

/// Bindings of conversations to their currently selected model.
/// Shared by concurrent request handlers, so interior mutability.
pub struct SessionStore {
    bindings: Mutex<HashMap<String, ModelId>>,
}

impl SessionStore {
    pub fn new() -> Self {
        SessionStore {
            bindings: Mutex::new(HashMap::new()),
        }
    }

    /// The model currently pinned to this conversation, or None for a new
    /// conversation (the router then selects the topmost available model).
    pub fn binding(&self, conversation: &str) -> Option<ModelId> {
        self.lock().get(conversation).cloned()
    }

    /// Pin or re-pin a conversation. Overwriting is the switch itself: after
    /// a fallback the conversation stays on the new model until it fails.
    pub fn pin(&self, conversation: &str, model: ModelId) {
        self.lock().insert(conversation.to_owned(), model);
    }

    /// A panic cannot leave the map half-updated (inserts are atomic), so a
    /// poisoned lock is recovered instead of failing every later request.
    fn lock(&self) -> MutexGuard<'_, HashMap<String, ModelId>> {
        self.bindings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderId;

    fn model_id(provider: &str, upstream: &str) -> ModelId {
        ModelId::new(ProviderId::new(provider), upstream)
    }

    #[test]
    fn a_new_conversation_has_no_binding() {
        let sessions = SessionStore::new();
        assert_eq!(sessions.binding("conv-1"), None);
    }

    #[test]
    fn pin_and_read_back_the_same_model() {
        let sessions = SessionStore::new();
        let model = model_id("p", "a");
        sessions.pin("conv-1", model.clone());
        assert_eq!(sessions.binding("conv-1"), Some(model));
    }

    #[test]
    fn re_pin_replaces_the_binding_without_migrating_back() {
        let sessions = SessionStore::new();
        sessions.pin("conv-1", model_id("p", "a"));
        // A fallback moves the conversation to the second model...
        sessions.pin("conv-1", model_id("q", "b"));
        // ...and restoring the first model must not move it back on its own.
        assert_eq!(sessions.binding("conv-1"), Some(model_id("q", "b")));
    }

    #[test]
    fn conversations_are_independent() {
        let sessions = SessionStore::new();
        sessions.pin("conv-1", model_id("p", "a"));
        sessions.pin("conv-2", model_id("q", "b"));
        assert_eq!(sessions.binding("conv-1"), Some(model_id("p", "a")));
        assert_eq!(sessions.binding("conv-2"), Some(model_id("q", "b")));
    }

    #[test]
    fn concurrent_pins_from_different_threads_all_land() {
        let sessions = SessionStore::new();
        std::thread::scope(|scope| {
            for i in 0..8 {
                let sessions = &sessions;
                scope.spawn(move || {
                    sessions.pin(&format!("conv-{i}"), model_id("p", &format!("m{i}")));
                });
            }
        });
        for i in 0..8 {
            assert_eq!(
                sessions.binding(&format!("conv-{i}")),
                Some(model_id("p", &format!("m{i}")))
            );
        }
    }
}
