// Owner-scoped chat memory: short notes a model saves and recalls in later
// dialogs. One table, parameterized SQL, owner always bound as a value — the
// owner never comes from model arguments. Notes are facts, not transcripts.

use rusqlite::Connection;

use super::StorageError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryEntry {
    pub id: i64,
    pub topic: String,
    pub note: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct MemoryStore {
    conn: Connection,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl MemoryStore {
    /// Takes ownership of a memory database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS chat_memory (
                 id         INTEGER PRIMARY KEY AUTOINCREMENT,
                 owner      TEXT    NOT NULL,
                 topic      TEXT    NOT NULL,
                 note       TEXT    NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS chat_memory_owner ON chat_memory(owner);",
        )
        .map_err(|e| StorageError(format!("create chat_memory: {e}")))?;
        Ok(Self { conn })
    }

    pub fn save(&mut self, owner: &str, topic: &str, note: &str) -> Result<i64, StorageError> {
        let now = now_unix();
        self.conn
            .execute(
                "INSERT INTO chat_memory (owner, topic, note, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![owner, topic, note, now],
            )
            .map_err(|e| StorageError(format!("save memory: {e}")))?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Replace topic and note. Ok(false) = no entry of this owner has the id.
    pub fn edit(
        &mut self,
        owner: &str,
        id: i64,
        topic: &str,
        note: &str,
    ) -> Result<bool, StorageError> {
        let changed = self
            .conn
            .execute(
                "UPDATE chat_memory
                 SET topic = ?3, note = ?4, updated_at = ?5
                 WHERE owner = ?1 AND id = ?2",
                rusqlite::params![owner, id, topic, note, now_unix()],
            )
            .map_err(|e| StorageError(format!("edit memory: {e}")))?;
        Ok(changed > 0)
    }

    /// Ok(false) = no entry of this owner has the id.
    pub fn delete(&mut self, owner: &str, id: i64) -> Result<bool, StorageError> {
        let changed = self
            .conn
            .execute(
                "DELETE FROM chat_memory WHERE owner = ?1 AND id = ?2",
                rusqlite::params![owner, id],
            )
            .map_err(|e| StorageError(format!("delete memory: {e}")))?;
        Ok(changed > 0)
    }

    /// Ranked recall: exact topic match first, then topic match, then note
    // match; newest first inside a tier. The query is bound as data and LIKE
    // wildcards in it are escaped, so a literal '%' matches only itself.
    // shortcut: plain LIKE ranking without a full-text index; upgrade only if
    // recall quality becomes a real complaint.
    pub fn recall(
        &self,
        owner: &str,
        query: &str,
        limit: u32,
    ) -> Result<Vec<MemoryEntry>, StorageError> {
        let pattern = format!("%{}%", escape_like(query));
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, topic, note, created_at, updated_at FROM chat_memory
                 WHERE owner = ?1
                   AND (topic = ?2 COLLATE NOCASE
                        OR topic LIKE ?3 ESCAPE '\\'
                        OR note  LIKE ?3 ESCAPE '\\')
                 ORDER BY CASE WHEN topic = ?2 COLLATE NOCASE THEN 0
                               WHEN topic LIKE ?3 ESCAPE '\\' THEN 1
                               ELSE 2 END,
                          updated_at DESC, id DESC
                 LIMIT ?4",
            )
            .map_err(|e| StorageError(format!("recall memory: {e}")))?;
        let rows = stmt
            .query_map(rusqlite::params![owner, query, pattern, limit], |r| {
                Ok(MemoryEntry {
                    id: r.get(0)?,
                    topic: r.get(1)?,
                    note: r.get(2)?,
                    created_at: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })
            .map_err(|e| StorageError(format!("recall memory: {e}")))?;
        let mut entries = Vec::new();
        for row in rows {
            entries.push(row.map_err(|e| StorageError(format!("recall memory row: {e}")))?);
        }
        Ok(entries)
    }
}

/// Escape LIKE wildcards so user text matches literally.
fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MemoryStore {
        MemoryStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn save_and_recall_round_trip() {
        let mut s = store();
        let id = s.save("laptop", "Coffee", "Beans in the blue tin").unwrap();
        let found = s.recall("laptop", "coffee", 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, id);
        assert_eq!(found[0].topic, "Coffee");
        assert_eq!(found[0].note, "Beans in the blue tin");
    }

    #[test]
    fn recall_ranks_exact_topic_then_topic_then_note() {
        let mut s = store();
        let note_hit = s.save("a", "Gardening", "rotors for the drone").unwrap();
        let topic_hit = s
            .save("a", "Drone spare parts", "order propellers")
            .unwrap();
        let exact = s.save("a", "drone", "check firmware").unwrap();
        let ranked = s.recall("a", "drone", 10).unwrap();
        assert_eq!(
            ranked.iter().map(|e| e.id).collect::<Vec<_>>(),
            vec![exact, topic_hit, note_hit]
        );
    }

    #[test]
    fn recall_respects_limit_and_recency_inside_a_tier() {
        let mut s = store();
        let first = s.save("a", "t", "note one").unwrap();
        let second = s.save("a", "t", "note two").unwrap();
        let all = s.recall("a", "note", 10).unwrap();
        assert_eq!(all.len(), 2);
        // Same tier (note match): newest first.
        assert_eq!(all[0].id, second);
        assert_eq!(all[1].id, first);
        assert_eq!(s.recall("a", "note", 1).unwrap().len(), 1);
    }

    #[test]
    fn owners_are_isolated() {
        let mut s = store();
        s.save("laptop", "Keys", "in the drawer").unwrap();
        assert!(s.recall("phone", "keys", 10).unwrap().is_empty());
        // A foreign id cannot be edited or deleted either.
        let id = s.save("laptop", "t", "n").unwrap();
        assert!(!s.edit("phone", id, "t2", "n2").unwrap());
        assert!(!s.delete("phone", id).unwrap());
        assert_eq!(s.recall("laptop", "t2", 10).unwrap().len(), 0);
    }

    #[test]
    fn edit_and_delete_report_unknown_ids() {
        let mut s = store();
        let id = s.save("a", "old topic", "old note").unwrap();
        assert!(s.edit("a", id, "new topic", "new note").unwrap());
        let after = &s.recall("a", "new topic", 10).unwrap()[0];
        assert_eq!(after.note, "new note");
        assert!(s.delete("a", id).unwrap());
        assert!(!s.delete("a", id).unwrap());
        assert!(s.recall("a", "new topic", 10).unwrap().is_empty());
    }

    #[test]
    fn like_wildcards_in_the_query_match_literally() {
        let mut s = store();
        let plain = s
            .save("a", "rust", "a plain note without special chars")
            .unwrap();
        let special = s
            .save("a", "other", "has 50% off and an x_y marker")
            .unwrap();
        // A lone wildcard matches only its literal occurrences, not every row.
        assert_eq!(s.recall("a", "%", 10).unwrap().len(), 1);
        assert_eq!(s.recall("a", "_", 10).unwrap().len(), 1);
        // Phrases with wildcards still match their literals.
        let hits = s.recall("a", "50% off", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, special);
        let hits = s.recall("a", "x_y", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, special);
        // And the plain note stays findable without wildcards.
        let hits = s.recall("a", "plain note", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, plain);
    }

    #[test]
    fn sql_control_characters_are_stored_as_data() {
        let mut s = store();
        let injection = "x'; DROP TABLE chat_memory;--";
        let id = s.save("a", injection, injection).unwrap();
        let found = s.recall("a", "DROP TABLE", 10).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, id);
        assert_eq!(found[0].topic, injection);
        // The table survived.
        let _ = s.save("a", "after", "still here").unwrap();
    }
}
