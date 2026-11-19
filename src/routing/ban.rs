// Model bans as routing sees them: a ban exists only for one
// provider_id:upstream_id pair, carries a reason, and is in force only
// until its expiry. The caller owns "now" and the ban policy and duration;
// the store only records and answers. There is no manual unban.

use crate::model::ModelId;

/// A ban in force at a specific moment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveBan {
    pub reason: String,
    pub expires_at_unix: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BanError(pub String);

impl std::fmt::Display for BanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ban: {}", self.0)
    }
}
impl std::error::Error for BanError {}

/// Domain contract implemented by the SQLite adapter. A ban is global
/// across pools and client keys; queries take the model id, not a pool.
pub trait ModelBans: Send + Sync {
    /// Record a ban, or overwrite the existing one for the same model.
    /// `&self`: the adapter owns its internal locking, so one shared store
    /// can serve concurrent request handlers.
    fn record_ban(
        &self,
        model: &ModelId,
        reason: &str,
        expires_at_unix: i64,
    ) -> Result<(), BanError>;

    /// The ban in force for this model at now_unix, or None. An expired row
    /// is not a ban; nothing implies a ban for the whole provider.
    fn ban_in_force(&self, model: &ModelId, now_unix: i64) -> Result<Option<ActiveBan>, BanError>;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderId;
    use crate::storage::bans::BanStore;
    use rusqlite::Connection;

    fn model_id(provider: &str, upstream: &str) -> ModelId {
        ModelId::new(ProviderId::new(provider), upstream)
    }

    fn store() -> BanStore {
        BanStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn a_recorded_ban_is_in_force_with_its_reason() {
        let bans = store();
        bans.record_ban(&model_id("p", "a"), "quota exhausted", 1_000)
            .unwrap();
        let ban = bans
            .ban_in_force(&model_id("p", "a"), 999)
            .unwrap()
            .unwrap();
        assert_eq!(ban.reason, "quota exhausted");
        assert_eq!(ban.expires_at_unix, 1_000);
    }

    #[test]
    fn an_expired_ban_is_not_in_force() {
        let bans = store();
        bans.record_ban(&model_id("p", "a"), "rate limit", 1_000)
            .unwrap();
        assert!(
            bans.ban_in_force(&model_id("p", "a"), 1_000)
                .unwrap()
                .is_none()
        );
        assert!(
            bans.ban_in_force(&model_id("p", "a"), 2_000)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_ban_covers_exactly_one_model() {
        let bans = store();
        bans.record_ban(&model_id("p", "a"), "reason", 1_000)
            .unwrap();
        assert!(
            bans.ban_in_force(&model_id("p", "b"), 999)
                .unwrap()
                .is_none()
        );
        assert!(
            bans.ban_in_force(&model_id("q", "a"), 999)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn recording_again_overwrites_the_ban() {
        let bans = store();
        bans.record_ban(&model_id("p", "a"), "first", 1_000)
            .unwrap();
        bans.record_ban(&model_id("p", "a"), "second", 5_000)
            .unwrap();
        let ban = bans
            .ban_in_force(&model_id("p", "a"), 4_000)
            .unwrap()
            .unwrap();
        assert_eq!(ban.reason, "second");
    }

    #[test]
    fn an_unknown_model_has_no_ban() {
        let bans = store();
        assert!(bans.ban_in_force(&model_id("p", "a"), 0).unwrap().is_none());
    }
}
