// Database open and init. Each database has one purpose and one lifecycle:
// catalog = models, pools, bans; balances = observations; requests = history;
// events = system event log; knowledge = researched model cards;
// memory = owner-scoped chat memory notes.
// An empty database is valid. A database that cannot open stops startup.

pub mod balances;
pub mod bans;
pub mod catalog;
pub mod events;
pub mod history;
pub mod knowledge;
pub mod memory;
pub mod pools;

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

/// Wait for a SQLite lock before failing. Proven value: 2 s.
const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

/// Database roles, one per file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbRole {
    Catalog,
    Balances,
    Requests,
    Events,
    Knowledge,
    Memory,
}

impl DbRole {
    pub fn file_name(self) -> &'static str {
        match self {
            DbRole::Catalog => "catalog.sqlite",
            DbRole::Balances => "balances.sqlite",
            DbRole::Requests => "requests.sqlite",
            DbRole::Events => "events.sqlite",
            DbRole::Knowledge => "knowledge.sqlite",
            DbRole::Memory => "memory.sqlite",
        }
    }
}

#[derive(Debug)]
pub struct StorageError(pub String);

impl std::fmt::Display for StorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "storage: {}", self.0)
    }
}
impl std::error::Error for StorageError {}

/// Open or create the database of one role. Fails when the file cannot open
/// or init. Catalog-file adapters (models, pools, bans) each take their own
/// connection this way; SQLite serializes writers via busy_timeout.
pub fn open_file(data_dir: &Path, role: DbRole) -> Result<Connection, StorageError> {
    open_one(&data_dir.join(role.file_name()))
}

fn open_one(path: &Path) -> Result<Connection, StorageError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| StorageError(format!("{}: {e}", path.display())))?;
    }
    let conn =
        Connection::open(path).map_err(|e| StorageError(format!("{}: {e}", path.display())))?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .map_err(|e| StorageError(format!("{}: busy_timeout: {e}", path.display())))?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_and_creates_a_database_file() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_file(dir.path(), DbRole::Catalog).unwrap();
        assert!(dir.path().join("catalog.sqlite").exists());
        // An empty database answers a trivial query.
        let n: i64 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn reopens_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        drop(open_file(dir.path(), DbRole::Requests).unwrap());
        let conn = open_file(dir.path(), DbRole::Requests).unwrap();
        let n: i64 = conn.query_row("SELECT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn rejects_a_directory_in_place_of_the_file() {
        let dir = tempfile::tempdir().unwrap();
        // A directory named like the database file cannot open as a database.
        std::fs::create_dir(dir.path().join(DbRole::Catalog.file_name())).unwrap();
        let err = open_file(dir.path(), DbRole::Catalog).unwrap_err();
        assert!(err.0.contains("catalog.sqlite"));
    }

    #[test]
    fn busy_timeout_is_set() {
        let dir = tempfile::tempdir().unwrap();
        let conn = open_file(dir.path(), DbRole::Catalog).unwrap();
        let ms: i64 = conn
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ms, 2000);
    }
}
