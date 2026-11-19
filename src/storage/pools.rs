// Metamodel (pool) storage. A pool is user data: an ordered list of member
// references (provider_id + upstream_id). No foreign keys: a pool is plain
// user data, and deletion integrity is enforced in our code, not by the DB
// (SQLite FKs are off by default anyway). Position in the list is the priority.
// A model disappearing from a provider never removes it from a pool.

use rusqlite::Connection;

use super::StorageError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolMember {
    pub provider_id: String,
    pub upstream_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPool {
    pub name: String,
    /// Priority order: lower position = higher priority.
    pub members: Vec<PoolMember>,
}

pub struct PoolStore {
    conn: Connection,
}

impl PoolStore {
    /// Takes ownership of a catalog database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metamodels (
                 name TEXT PRIMARY KEY
             );
             CREATE TABLE IF NOT EXISTS metamodel_members (
                 metamodel_name TEXT    NOT NULL,
                 position      INTEGER  NOT NULL,
                 provider_id   TEXT     NOT NULL,
                 upstream_id   TEXT     NOT NULL,
                 PRIMARY KEY (metamodel_name, position)
             );",
        )
        .map_err(|e| StorageError(format!("create pool tables: {e}")))?;
        Ok(Self { conn })
    }

    /// Create a pool. Fails when the name already exists.
    pub fn create(&mut self, name: &str, members: Vec<PoolMember>) -> Result<(), StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin transaction: {e}")))?;
        tx.execute("INSERT INTO metamodels (name) VALUES (?1)", [name])
            .map_err(|e| StorageError(format!("create pool '{name}': {e}")))?;
        insert_members(&tx, name, &members)?;
        tx.commit()
            .map_err(|e| StorageError(format!("commit pool: {e}")))
    }

    /// Replace the member list and order. Fails when the pool does not exist.
    pub fn replace_members(
        &mut self,
        name: &str,
        members: Vec<PoolMember>,
    ) -> Result<(), StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin transaction: {e}")))?;
        let changed = tx
            .execute(
                "DELETE FROM metamodel_members WHERE metamodel_name = ?1",
                [name],
            )
            .map_err(|e| StorageError(format!("delete members: {e}")))?;
        let _ = changed;
        // A pool with zero members is valid user data, but the pool must exist.
        let exists: bool = tx
            .query_row(
                "SELECT COUNT(*) FROM metamodels WHERE name = ?1",
                [name],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| StorageError(format!("check pool: {e}")))?
            > 0;
        if !exists {
            return Err(StorageError(format!("pool '{name}' does not exist")));
        }
        insert_members(&tx, name, &members)?;
        tx.commit()
            .map_err(|e| StorageError(format!("commit members: {e}")))
    }

    pub fn delete(&mut self, name: &str) -> Result<(), StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin transaction: {e}")))?;
        tx.execute(
            "DELETE FROM metamodel_members WHERE metamodel_name = ?1",
            [name],
        )
        .map_err(|e| StorageError(format!("delete members: {e}")))?;
        tx.execute("DELETE FROM metamodels WHERE name = ?1", [name])
            .map_err(|e| StorageError(format!("delete pool '{name}': {e}")))?;
        tx.commit()
            .map_err(|e| StorageError(format!("commit delete: {e}")))
    }

    pub fn get(&self, name: &str) -> Result<Option<StoredPool>, StorageError> {
        let exists: bool = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM metamodels WHERE name = ?1",
                [name],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| StorageError(format!("check pool: {e}")))?
            > 0;
        if !exists {
            return Ok(None);
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT provider_id, upstream_id
                 FROM metamodel_members
                 WHERE metamodel_name = ?1
                 ORDER BY position",
            )
            .map_err(|e| StorageError(format!("prepare members: {e}")))?;
        let rows = stmt
            .query_map([name], |r| {
                Ok(PoolMember {
                    provider_id: r.get(0)?,
                    upstream_id: r.get(1)?,
                })
            })
            .map_err(|e| StorageError(format!("read members: {e}")))?;
        let mut members = Vec::new();
        for row in rows {
            members.push(row.map_err(|e| StorageError(format!("read member: {e}")))?);
        }
        Ok(Some(StoredPool {
            name: name.into(),
            members,
        }))
    }

    pub fn list(&self) -> Result<Vec<StoredPool>, StorageError> {
        let mut stmt = self
            .conn
            .prepare("SELECT name FROM metamodels ORDER BY name")
            .map_err(|e| StorageError(format!("prepare pools: {e}")))?;
        let names = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| StorageError(format!("read pools: {e}")))?;
        let mut pools = Vec::new();
        for name in names {
            let name = name.map_err(|e| StorageError(format!("read pool name: {e}")))?;
            pools.push(self.get(&name)?.expect("pool listed above exists"));
        }
        Ok(pools)
    }
}

fn insert_members(
    tx: &rusqlite::Transaction<'_>,
    name: &str,
    members: &[PoolMember],
) -> Result<(), StorageError> {
    for (position, m) in members.iter().enumerate() {
        tx.execute(
            "INSERT INTO metamodel_members
                 (metamodel_name, position, provider_id, upstream_id)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, position as i64, m.provider_id, m.upstream_id],
        )
        .map_err(|e| StorageError(format!("insert member {position}: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> PoolStore {
        PoolStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn member(p: &str, m: &str) -> PoolMember {
        PoolMember {
            provider_id: p.into(),
            upstream_id: m.into(),
        }
    }

    #[test]
    fn create_and_read_preserves_order() {
        let mut s = store();
        s.create(
            "coding",
            vec![
                member("kimi", "model-a"),
                member("zai", "model-b"),
                member("local", "model-c"),
            ],
        )
        .unwrap();
        let pool = s.get("coding").unwrap().unwrap();
        assert_eq!(
            pool.members,
            vec![
                member("kimi", "model-a"),
                member("zai", "model-b"),
                member("local", "model-c"),
            ]
        );
    }

    #[test]
    fn duplicate_name_rejected() {
        let mut s = store();
        s.create("coding", vec![member("p", "m")]).unwrap();
        assert!(s.create("coding", vec![]).is_err());
        // The failed create left the original pool intact.
        assert_eq!(
            s.get("coding").unwrap().unwrap().members,
            vec![member("p", "m")]
        );
    }

    #[test]
    fn replace_members_changes_order_and_set() {
        let mut s = store();
        s.create("coding", vec![member("a", "m1"), member("b", "m2")])
            .unwrap();
        s.replace_members(
            "coding",
            vec![member("b", "m2"), member("a", "m1"), member("c", "m3")],
        )
        .unwrap();
        let pool = s.get("coding").unwrap().unwrap();
        assert_eq!(
            pool.members,
            vec![member("b", "m2"), member("a", "m1"), member("c", "m3")]
        );
    }

    #[test]
    fn replace_members_of_missing_pool_rejected() {
        let mut s = store();
        assert!(s.replace_members("nope", vec![member("p", "m")]).is_err());
    }

    #[test]
    fn delete_removes_pool_and_members() {
        let mut s = store();
        s.create("coding", vec![member("p", "m")]).unwrap();
        s.create("other", vec![member("p", "m")]).unwrap();
        s.delete("coding").unwrap();
        assert!(s.get("coding").unwrap().is_none());
        // Other pools are untouched.
        assert!(s.get("other").unwrap().is_some());
        assert_eq!(s.list().unwrap().len(), 1);
    }

    #[test]
    fn missing_pool_is_none_not_empty() {
        let s = store();
        assert!(s.get("nope").unwrap().is_none());
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn delete_then_recreate_same_name() {
        // Regression: orphaned member rows used to block re-creation at position 0.
        let mut s = store();
        s.create("coding", vec![member("p", "m")]).unwrap();
        s.delete("coding").unwrap();
        assert!(s.get("coding").unwrap().is_none());
        s.create("coding", vec![member("q", "n")]).unwrap();
        assert_eq!(
            s.get("coding").unwrap().unwrap().members,
            vec![member("q", "n")]
        );
    }

    #[test]
    fn pool_with_no_members_is_valid() {
        let mut s = store();
        s.create("coding", vec![]).unwrap();
        let pool = s.get("coding").unwrap().unwrap();
        assert!(pool.members.is_empty());
        // It stays editable.
        s.replace_members("coding", vec![member("p", "m")]).unwrap();
        assert_eq!(
            s.get("coding").unwrap().unwrap().members,
            vec![member("p", "m")]
        );
    }

    #[test]
    fn members_have_no_catalog_dependency() {
        // A member reference is plain data; no model catalog exists here at all.
        let mut s = store();
        s.create("coding", vec![member("ghost-provider", "ghost-model")])
            .unwrap();
        assert_eq!(s.get("coding").unwrap().unwrap().members.len(), 1);
    }
}
