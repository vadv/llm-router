// Model ban storage. A ban exists only for provider_id + upstream_id —
// never for a whole provider — and is global across all pools and client
// keys. It survives restart and is only enforced until its expiry; expired
// rows are ignored lazily (no timers). There is no manual unban.
//
// The connection sits behind a Mutex: several request handlers share one
// Router (and thus this store), and no lock is ever held across a network
// await — each query locks, runs, unlocks.

use std::sync::Mutex;

use rusqlite::Connection;

use crate::model::ModelId;
use crate::routing::ban::{ActiveBan, BanError, ModelBans};

use super::StorageError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBan {
    pub provider_id: String,
    pub upstream_id: String,
    pub reason: String,
    pub expires_at_unix: i64,
}

pub struct BanStore {
    conn: Mutex<Connection>,
    // Optional event-log mirror: every recorded ban also appends a
    // `ban_recorded` event. Absent in tests that only exercise routing.
    events: Option<std::sync::Arc<crate::storage::events::EventStore>>,
}

impl BanStore {
    /// Takes ownership of a catalog database connection and ensures the schema.
    /// Test-only: the app always wires the event mirror.
    #[cfg(test)]
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        Self::with_events(conn, None)
    }

    /// Same, but every recorded ban is mirrored into the system event log.
    pub fn with_events(
        conn: Connection,
        events: Option<std::sync::Arc<crate::storage::events::EventStore>>,
    ) -> Result<Self, StorageError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS model_bans (
                 provider_id      TEXT NOT NULL,
                 upstream_id      TEXT NOT NULL,
                 reason           TEXT NOT NULL,
                 expires_at_unix  INTEGER NOT NULL,
                 PRIMARY KEY (provider_id, upstream_id)
             ) WITHOUT ROWID",
            [],
        )
        .map_err(|e| StorageError(format!("create model_bans: {e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
            events,
        })
    }

    /// Record (or overwrite) a ban for one model. The caller owns the ban
    /// policy and duration; storage keeps whatever it is given.
    pub fn record(
        &self,
        provider_id: &str,
        upstream_id: &str,
        reason: &str,
        expires_at_unix: i64,
    ) -> Result<(), StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        conn.execute(
            "INSERT OR REPLACE INTO model_bans
                     (provider_id, upstream_id, reason, expires_at_unix)
                 VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![provider_id, upstream_id, reason, expires_at_unix],
        )
        .map_err(|e| StorageError(format!("record ban: {e}")))?;
        // The event mirror is best-effort: a failing event log must not
        // fail the ban that routing just decided on.
        if let Some(events) = &self.events {
            let now = unix_now();
            let detail = serde_json::json!({
                "upstream_id": upstream_id,
                "reason": reason,
                "expires_at_unix": expires_at_unix,
            });
            if let Err(e) = events.record(
                now,
                crate::storage::events::event_kind::BAN_RECORDED,
                Some(provider_id),
                &detail,
            ) {
                eprintln!("[events] {e}");
            }
        }
        Ok(())
    }

    /// The ban in force right now, or None. An expired row is not a ban.
    pub fn active_ban(
        &self,
        provider_id: &str,
        upstream_id: &str,
        now_unix: i64,
    ) -> Result<Option<StoredBan>, StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, upstream_id, reason, expires_at_unix
                 FROM model_bans
                 WHERE provider_id = ?1 AND upstream_id = ?2",
            )
            .map_err(|e| StorageError(format!("prepare ban read: {e}")))?;
        match stmt.query_row(rusqlite::params![provider_id, upstream_id], |r| {
            Ok(StoredBan {
                provider_id: r.get(0)?,
                upstream_id: r.get(1)?,
                reason: r.get(2)?,
                expires_at_unix: r.get(3)?,
            })
        }) {
            Ok(ban) if ban.expires_at_unix > now_unix => Ok(Some(ban)),
            Ok(_) => Ok(None),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError(format!("read ban: {e}"))),
        }
    }

    /// All stored bans, expired or not. The scheduler's sweep reads this
    /// to notice bans that lapsed since the previous tick.
    pub fn all_bans(&self) -> Result<Vec<StoredBan>, StorageError> {
        let conn = self.conn.lock().map_err(|_| poisoned())?;
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, upstream_id, reason, expires_at_unix
                 FROM model_bans
                 ORDER BY provider_id, upstream_id",
            )
            .map_err(|e| StorageError(format!("prepare ban read: {e}")))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StoredBan {
                    provider_id: r.get(0)?,
                    upstream_id: r.get(1)?,
                    reason: r.get(2)?,
                    expires_at_unix: r.get(3)?,
                })
            })
            .map_err(|e| StorageError(format!("query bans: {e}")))?;
        let mut bans = Vec::new();
        for row in rows {
            let ban = row.map_err(|e| StorageError(format!("read ban: {e}")))?;
            bans.push(ban);
        }
        Ok(bans)
    }
}

/// The SQLite adapter implements the routing contract. A ban remains
/// keyed to the exact provider_id:upstream_id pair; only the mapping to
/// domain types happens here.
impl ModelBans for BanStore {
    fn record_ban(
        &self,
        model: &ModelId,
        reason: &str,
        expires_at_unix: i64,
    ) -> Result<(), BanError> {
        self.record(
            model.provider().as_str(),
            model.upstream(),
            reason,
            expires_at_unix,
        )
        .map_err(|e: StorageError| BanError(e.0))
    }

    fn ban_in_force(&self, model: &ModelId, now_unix: i64) -> Result<Option<ActiveBan>, BanError> {
        self.active_ban(model.provider().as_str(), model.upstream(), now_unix)
            .map_err(|e: StorageError| BanError(e.0))
            .map(|ban| {
                ban.map(|b| ActiveBan {
                    reason: b.reason,
                    expires_at_unix: b.expires_at_unix,
                })
            })
    }
}

/// A poisoned connection lock means a query panicked while holding it;
/// the store is unusable, not silently healthy.
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn poisoned() -> StorageError {
    StorageError("ban store lock is poisoned".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ModelId;

    fn store() -> BanStore {
        BanStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn model_id(provider: &str, upstream: &str) -> ModelId {
        ModelId::new(crate::model::ProviderId::new(provider), upstream)
    }

    #[test]
    fn no_ban_by_default() {
        let s = store();
        assert!(s.active_ban("p", "m", 1000).unwrap().is_none());
    }

    #[test]
    fn active_ban_roundtrip() {
        let s = store();
        s.record("p", "m", "insufficient balance", 2000).unwrap();
        let ban = s.active_ban("p", "m", 1000).unwrap().unwrap();
        assert_eq!(ban.reason, "insufficient balance");
        assert_eq!(ban.expires_at_unix, 2000);
    }

    #[test]
    fn expired_ban_is_not_enforced() {
        let s = store();
        s.record("p", "m", "overloaded", 2000).unwrap();
        // Exactly at expiry the model is available again.
        assert!(s.active_ban("p", "m", 2000).unwrap().is_none());
        assert!(s.active_ban("p", "m", 2001).unwrap().is_none());
    }

    #[test]
    fn new_ban_replaces_old() {
        let s = store();
        s.record("p", "m", "timeout", 2000).unwrap();
        s.record("p", "m", "quota exhausted", 9000).unwrap();
        let ban = s.active_ban("p", "m", 3000).unwrap().unwrap();
        assert_eq!(ban.reason, "quota exhausted");
        assert_eq!(ban.expires_at_unix, 9000);
    }

    #[test]
    fn ban_is_per_model() {
        let s = store();
        s.record("p", "model-a", "overloaded", 2000).unwrap();
        // Same provider, other model: not banned. Same model, other provider: not banned.
        assert!(s.active_ban("p", "model-b", 1000).unwrap().is_none());
        assert!(s.active_ban("q", "model-a", 1000).unwrap().is_none());
    }

    #[test]
    fn a_recorded_ban_is_mirrored_into_the_event_log() {
        use crate::storage::events::event_kind;
        let events =
            crate::storage::events::EventStore::new(Connection::open_in_memory().unwrap()).unwrap();
        let shared = std::sync::Arc::new(events);
        let bans = BanStore::with_events(
            Connection::open_in_memory().unwrap(),
            Some(std::sync::Arc::clone(&shared)),
        )
        .unwrap();
        bans.record_ban(&model_id("p", "model-a"), "quota exhausted", 9000)
            .unwrap();
        let logged = shared.list(10).unwrap();
        assert_eq!(logged.len(), 1);
        assert_eq!(logged[0].kind, event_kind::BAN_RECORDED);
        assert_eq!(logged[0].provider_id.as_deref(), Some("p"));
        let detail: serde_json::Value =
            serde_json::from_str(logged[0].detail.as_deref().unwrap()).unwrap();
        assert_eq!(detail["upstream_id"], "model-a");
        assert_eq!(detail["expires_at_unix"], 9000);
    }

    #[test]
    fn all_bans_returns_expired_rows_too() {
        let s = store();
        s.record("p", "model-a", "overloaded", 2000).unwrap();
        s.record("q", "model-b", "rate limit", 100).unwrap();
        let all = s.all_bans().unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|b| b.upstream_id == "model-b"));
    }
}
