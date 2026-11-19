// Model knowledge base storage: one researched card per normalized model key,
// shared across providers and aliases (:free, vendor prefixes). Cards are
// written only after validation; a re-collection overwrites the old card.

use std::sync::Mutex;

use rusqlite::Connection;

use super::StorageError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewCard {
    /// Normalized model key, e.g. "glm-5.3".
    pub key: String,
    /// The validated card as canonical JSON text.
    pub card_json: String,
    pub collected_at_unix: i64,
    /// What produced the card, e.g. "deepseek/deepseek-flash+websearch".
    pub generator: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredCard {
    pub key: String,
    pub card_json: String,
    pub collected_at_unix: i64,
    pub generator: String,
}

pub struct KnowledgeStore {
    conn: Mutex<Connection>,
}

impl KnowledgeStore {
    /// Takes ownership of the knowledge database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS model_knowledge (
                 key              TEXT PRIMARY KEY,
                 card_json        TEXT NOT NULL,
                 collected_at_unix INTEGER NOT NULL,
                 generator        TEXT NOT NULL
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS knowledge_spelling
                 ON model_knowledge(replace(key, '-', ''), key);",
        )
        .map_err(|e| StorageError(format!("create model_knowledge: {e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<StoredCard>, StorageError> {
        // Exact hit first; no table scan for the common path.
        if let Some(card) = self.get_exact(key)? {
            return Ok(Some(card));
        }
        // Providers spell one family differently (workbuddy `hy4flash-free`
        // vs opencode `hy4-flash-free`); compare hyphen-stripped keys so a
        // card matches without migrating stored rows.
        let conn = self.conn.lock().expect("knowledge store lock");
        let mut statement = conn
            .prepare("SELECT key, card_json, collected_at_unix, generator FROM model_knowledge")
            .map_err(|e| StorageError(e.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| StorageError(e.to_string()))?;
        for row in rows {
            let (stored_key, card_json, collected_at_unix, generator) =
                row.map_err(|e| StorageError(e.to_string()))?;
            if stored_key.replace('-', "") == key.replace('-', "") {
                return Ok(Some(StoredCard {
                    key: stored_key,
                    card_json,
                    collected_at_unix,
                    generator,
                }));
            }
        }
        Ok(None)
    }

    /// Return only fields used to browse the catalog. Prefer an exact key over a spelling match.
    pub fn summaries(&self, keys: &[String]) -> Result<Vec<serde_json::Value>, StorageError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| StorageError("knowledge storage unavailable".into()))?;
        let query = "SELECT json_object('key', w.value,
                   'canonical_name', json_extract(card_json, '$.canonical_name'),
                   'vendor', json_extract(card_json, '$.vendor'),
                   'description', substr(json_extract(card_json, '$.description'), 1, 320),
                   'modality', substr(json_extract(card_json, '$.modality'), 1, 160),
                   'primary_use', CASE WHEN json_type(card_json, '$.use_cases[0]') = 'text'
                       THEN substr(json_extract(card_json, '$.use_cases[0]'), 1, 160) END,
                   'release_date', json_extract(card_json, '$.release_date'),
                   'ratings', json_extract(card_json, '$.ratings'))
               FROM json_each(?1) w JOIN model_knowledge m ON m.key = coalesce(
                   (SELECT key FROM model_knowledge WHERE key = w.value),
                   (SELECT key FROM model_knowledge WHERE replace(key, '-', '') = replace(w.value, '-', '')
                    ORDER BY key LIMIT 1))";
        let mut stmt = conn
            .prepare(query)
            .map_err(|e| StorageError(e.to_string()))?;
        let keys = serde_json::to_string(keys).map_err(|e| StorageError(e.to_string()))?;
        let rows = stmt
            .query_map([keys], |row| row.get::<_, String>(0))
            .map_err(|e| StorageError(e.to_string()))?;
        rows.map(|row| {
            let raw = row.map_err(|e| StorageError(e.to_string()))?;
            serde_json::from_str(&raw).map_err(|e| StorageError(e.to_string()))
        })
        .collect()
    }

    fn get_exact(&self, key: &str) -> Result<Option<StoredCard>, StorageError> {
        let conn = self.conn.lock().expect("knowledge store lock");
        match conn.query_row(
            "SELECT key, card_json, collected_at_unix, generator
             FROM model_knowledge WHERE key = ?1",
            [key],
            |r| {
                Ok(StoredCard {
                    key: r.get(0)?,
                    card_json: r.get(1)?,
                    collected_at_unix: r.get(2)?,
                    generator: r.get(3)?,
                })
            },
        ) {
            Ok(c) => Ok(Some(c)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError(format!("get '{key}': {e}"))),
        }
    }

    /// Insert or overwrite the card of one key.
    pub fn upsert(&self, card: &NewCard) -> Result<(), StorageError> {
        let conn = self.conn.lock().expect("knowledge store lock");
        conn.execute(
            "INSERT OR REPLACE INTO model_knowledge
                 (key, card_json, collected_at_unix, generator)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                card.key,
                card.card_json,
                card.collected_at_unix,
                card.generator
            ],
        )
        .map_err(|e| StorageError(format!("upsert '{}': {e}", card.key)))?;
        Ok(())
    }

    /// Live check for /health: this connection answers a trivial query.
    pub fn ping(&self) -> bool {
        let conn = self.conn.lock().expect("knowledge store lock");
        conn.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> KnowledgeStore {
        KnowledgeStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn upsert_then_get_roundtrips() {
        let s = store();
        s.upsert(&NewCard {
            key: "glm-5.3".into(),
            card_json: r#"{"description":"GLM 5.3"}"#.into(),
            collected_at_unix: 1_760_000_000,
            generator: "deepseek/deepseek-flash+websearch".into(),
        })
        .unwrap();
        let c = s.get("glm-5.3").unwrap().unwrap();
        assert_eq!(c.card_json, r#"{"description":"GLM 5.3"}"#);
        assert_eq!(c.collected_at_unix, 1_760_000_000);
        assert_eq!(c.generator, "deepseek/deepseek-flash+websearch");
    }

    #[test]
    fn missing_key_is_none_not_an_error() {
        let s = store();
        assert!(s.get("nemotron").unwrap().is_none());
    }

    #[test]
    fn hyphen_spelling_variants_share_one_card() {
        // workbuddy writes `hy4flash-free`, the stored card came from
        // opencode as `hy4-flash-free`: one family, one card.
        let s = store();
        s.upsert(&NewCard {
            key: "hy4-flash-free".into(),
            card_json: r#"{"description":"HunYuan 4 Flash"}"#.into(),
            collected_at_unix: 1_760_000_000,
            generator: "g".into(),
        })
        .unwrap();
        let loose = s.get("hy4flash-free").unwrap().unwrap();
        assert_eq!(loose.key, "hy4-flash-free");
        // And the exact key still wins when both spellings exist.
        s.upsert(&NewCard {
            key: "hy4flash-free".into(),
            card_json: r#"{"description":"own card"}"#.into(),
            collected_at_unix: 1_760_000_001,
            generator: "g".into(),
        })
        .unwrap();
        assert_eq!(
            s.get("hy4flash-free").unwrap().unwrap().card_json,
            r#"{"description":"own card"}"#
        );
    }

    #[test]
    fn recollection_overwrites_the_old_card() {
        let s = store();
        for (json, at) in [("{\"v\":1}", 100i64), ("{\"v\":2}", 200)] {
            s.upsert(&NewCard {
                key: "hy4".into(),
                card_json: json.into(),
                collected_at_unix: at,
                generator: "g".into(),
            })
            .unwrap();
        }
        let c = s.get("hy4").unwrap().unwrap();
        assert_eq!(c.card_json, "{\"v\":2}");
        assert_eq!(c.collected_at_unix, 200);
    }

    #[test]
    fn persists_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("knowledge.sqlite");
        {
            let s = KnowledgeStore::new(Connection::open(&path).unwrap()).unwrap();
            s.upsert(&NewCard {
                key: "k".into(),
                card_json: "{}".into(),
                collected_at_unix: 1,
                generator: "g".into(),
            })
            .unwrap();
        }
        let s = KnowledgeStore::new(Connection::open(&path).unwrap()).unwrap();
        assert!(s.get("k").unwrap().is_some());
    }

    #[test]
    fn ping_answers() {
        assert!(store().ping());
    }
}
