// Model catalog storage. One snapshot per provider connection; a successful
// full snapshot replaces the previous one in a single transaction. A failed
// or partial refresh never deletes models. Upstream IDs are stored verbatim.

use rusqlite::Connection;

use crate::model::{CatalogError, ModelCatalog, ModelId, ProviderId, ProviderModel};

use super::StorageError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewModel {
    /// Upstream model ID, verbatim: case, slashes, ":free" suffix.
    pub upstream_id: String,
    /// Context window in tokens. None = unknown, never zero-by-default.
    pub context_tokens: Option<u64>,
    pub observed_at_unix: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredModel {
    pub provider_id: String,
    pub upstream_id: String,
    pub context_tokens: Option<u64>,
    pub observed_at_unix: i64,
}

pub struct ModelStore {
    conn: Connection,
}

impl ModelStore {
    /// Takes ownership of the catalog database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS provider_models (
                 provider_id      TEXT NOT NULL,
                 upstream_id      TEXT NOT NULL,
                 context_tokens   INTEGER,
                 observed_at_unix INTEGER NOT NULL,
                 PRIMARY KEY (provider_id, upstream_id)
             ) WITHOUT ROWID",
            [],
        )
        .map_err(|e| StorageError(format!("create provider_models: {e}")))?;
        Ok(Self { conn })
    }

    /// Replace the model snapshot of one provider. Atomic: either the whole
    /// new snapshot is stored or the old one stays.
    pub fn replace_snapshot(
        &mut self,
        provider_id: &str,
        models: Vec<NewModel>,
    ) -> Result<(), StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin transaction: {e}")))?;
        tx.execute(
            "DELETE FROM provider_models WHERE provider_id = ?1",
            [provider_id],
        )
        .map_err(|e| StorageError(format!("delete old snapshot: {e}")))?;
        for m in &models {
            tx.execute(
                "INSERT INTO provider_models
                     (provider_id, upstream_id, context_tokens, observed_at_unix)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    provider_id,
                    m.upstream_id,
                    m.context_tokens,
                    m.observed_at_unix
                ],
            )
            .map_err(|e| StorageError(format!("insert model '{}': {e}", m.upstream_id)))?;
        }
        tx.commit()
            .map_err(|e| StorageError(format!("commit snapshot: {e}")))
    }

    pub fn find(
        &self,
        provider_id: &str,
        upstream_id: &str,
    ) -> Result<Option<StoredModel>, StorageError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT provider_id, upstream_id, context_tokens, observed_at_unix
                 FROM provider_models
                 WHERE provider_id = ?1 AND upstream_id = ?2",
            )
            .map_err(|e| StorageError(format!("prepare find: {e}")))?;
        match stmt.query_row(rusqlite::params![provider_id, upstream_id], stored_model_of) {
            Ok(m) => Ok(Some(m)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError(format!("find: {e}"))),
        }
    }

    /// Live check for /health: this connection answers a trivial query.
    pub fn ping(&self) -> bool {
        self.conn
            .query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }

    /// All models of one provider, ordered by upstream_id for stable listing.
    pub fn list(&self, provider_id: &str) -> Result<Vec<StoredModel>, StorageError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT provider_id, upstream_id, context_tokens, observed_at_unix
                 FROM provider_models
                 WHERE provider_id = ?1
                 ORDER BY upstream_id",
            )
            .map_err(|e| StorageError(format!("prepare list: {e}")))?;
        let rows = stmt
            .query_map([provider_id], stored_model_of)
            .map_err(|e| StorageError(format!("list: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| StorageError(format!("read row: {e}")))?);
        }
        Ok(out)
    }

    /// All models of all providers, ordered by provider then upstream id.
    /// The knowledge API scans this to find every catalog entry sharing one
    /// knowledge key (the same model behind different providers/aliases).
    pub fn list_all(&self) -> Result<Vec<StoredModel>, StorageError> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT provider_id, upstream_id, context_tokens, observed_at_unix
                 FROM provider_models
                 ORDER BY provider_id, upstream_id",
            )
            .map_err(|e| StorageError(format!("prepare list_all: {e}")))?;
        let rows = stmt
            .query_map([], stored_model_of)
            .map_err(|e| StorageError(format!("list_all: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| StorageError(format!("read row: {e}")))?);
        }
        Ok(out)
    }
}

fn stored_model_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredModel> {
    Ok(StoredModel {
        provider_id: r.get(0)?,
        upstream_id: r.get(1)?,
        context_tokens: r.get::<_, Option<i64>>(2)?.map(|v| v as u64),
        observed_at_unix: r.get(3)?,
    })
}

/// The SQLite adapter implements the domain read contract. Consumers see
/// domain objects, never the adapter's rows.
impl ModelCatalog for ModelStore {
    fn find(&self, id: &ModelId) -> Result<Option<ProviderModel>, CatalogError> {
        self.find(id.provider().as_str(), id.upstream())
            .map(|stored| {
                stored.map(|m| ProviderModel {
                    id: ModelId::new(ProviderId::new(m.provider_id), m.upstream_id),
                    context_tokens: m.context_tokens,
                    observed_at_unix: m.observed_at_unix,
                })
            })
            .map_err(|e: StorageError| CatalogError(e.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> ModelStore {
        ModelStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn model(id: &str, ctx: Option<u64>) -> NewModel {
        NewModel {
            upstream_id: id.into(),
            context_tokens: ctx,
            observed_at_unix: 1000,
        }
    }

    #[test]
    fn empty_provider_has_no_models() {
        let s = store();
        assert!(s.list("p").unwrap().is_empty());
        assert!(s.find("p", "m").unwrap().is_none());
    }

    #[test]
    fn snapshot_roundtrip() {
        let mut s = store();
        s.replace_snapshot(
            "p",
            vec![model("model-a", Some(128_000)), model("model-b", None)],
        )
        .unwrap();
        let found = s.find("p", "model-a").unwrap().unwrap();
        assert_eq!(found.provider_id, "p");
        assert_eq!(found.context_tokens, Some(128_000));
        assert_eq!(
            s.find("p", "model-b").unwrap().unwrap().context_tokens,
            None
        );
        assert_eq!(s.list("p").unwrap().len(), 2);
    }

    #[test]
    fn replace_removes_stale_models() {
        let mut s = store();
        s.replace_snapshot("p", vec![model("model-a", None), model("model-b", None)])
            .unwrap();
        s.replace_snapshot("p", vec![model("model-b", Some(64_000))])
            .unwrap();
        let list = s.list("p").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].upstream_id, "model-b");
        assert_eq!(list[0].context_tokens, Some(64_000));
    }

    #[test]
    fn snapshots_are_per_provider() {
        let mut s = store();
        s.replace_snapshot("p1", vec![model("m", None)]).unwrap();
        s.replace_snapshot("p2", vec![model("m", None)]).unwrap();
        assert_eq!(s.list("p1").unwrap().len(), 1);
        assert_eq!(s.list("p2").unwrap().len(), 1);
        // The same upstream name under another provider is a different model.
        assert_ne!(
            s.find("p1", "m").unwrap().unwrap(),
            s.find("p2", "m").unwrap().unwrap()
        );
    }

    #[test]
    fn verbatim_ids_with_special_characters() {
        let mut s = store();
        s.replace_snapshot(
            "p",
            vec![
                model("Vendor/Model-1:free", None),
                model("Model.Case", None),
            ],
        )
        .unwrap();
        // Case and punctuation survive exactly; "Model.case" is not "Model.Case".
        assert!(s.find("p", "Vendor/Model-1:free").unwrap().is_some());
        assert!(s.find("p", "Model.Case").unwrap().is_some());
        assert!(s.find("p", "Model.case").unwrap().is_none());
    }

    #[test]
    fn duplicate_model_in_one_batch_keeps_old_snapshot() {
        let mut s = store();
        s.replace_snapshot("p", vec![model("old", None)]).unwrap();
        // A malformed snapshot (the same ID twice) must not half-apply.
        let err = s
            .replace_snapshot("p", vec![model("new", None), model("new", None)])
            .unwrap_err();
        assert!(err.0.contains("insert model"));
        let list = s.list("p").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].upstream_id, "old");
    }

    #[test]
    fn implements_the_domain_catalog_contract() {
        let mut s = ModelStore::new(Connection::open_in_memory().unwrap()).unwrap();
        s.replace_snapshot(
            "p",
            vec![NewModel {
                upstream_id: "Vendor/Model-1:free".into(),
                context_tokens: Some(8_000),
                observed_at_unix: 123,
            }],
        )
        .unwrap();
        let id = ModelId::new(ProviderId::new("p"), "Vendor/Model-1:free");
        let found = ModelCatalog::find(&s, &id).unwrap().unwrap();
        assert_eq!(found.id, id);
        assert_eq!(found.context_tokens, Some(8_000));
        assert_eq!(found.observed_at_unix, 123);

        let missing = ModelId::new(ProviderId::new("p"), "nope");
        assert!(ModelCatalog::find(&s, &missing).unwrap().is_none());
    }
}
