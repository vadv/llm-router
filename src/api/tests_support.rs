// Shared fixture for api handler tests: one ZAI provider, one client key.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::api::ApiState;
use crate::api::auth::KeyAuthenticator;
use crate::config::{ClientKey, ProviderConfig};
use crate::metamodel::MetamodelService;
use crate::provider::ProviderRegistry;
use crate::routing::Router;
use crate::storage::bans::BanStore;
use crate::storage::catalog::ModelStore;
use crate::storage::history::HistoryStore;
use crate::storage::pools::PoolStore;

/// A file-backed history pair: the writer thread needs its own
/// connection, so in-memory databases cannot cross the thread boundary.
/// Uniqueness comes from the process id plus a per-call counter.
pub fn history_pair(name: &str) -> (HistoryStore, crate::history::writer::HistoryWriter) {
    static SEED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seed = SEED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "inference-history-{name}-{}-{seed}.sqlite",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    let reader = HistoryStore::new(rusqlite::Connection::open(&path).unwrap()).unwrap();
    let writer_store = HistoryStore::new(rusqlite::Connection::open(&path).unwrap()).unwrap();
    let writer = crate::history::writer::HistoryWriter::spawn(
        writer_store,
        std::time::Duration::from_millis(30),
        crate::history::writer::DEFAULT_BUDGET,
        |_, _| {},
    );
    (reader, writer)
}

/// Wait until the writer persisted the request, then return it with its
/// attempts. None means the writer never produced it — a failed assertion
/// upstream is more useful than a bare timeout.
pub fn wait_history(
    state: &crate::api::ApiState,
    id: &str,
) -> Option<crate::storage::history::StoredHistoryRequest> {
    use crate::storage::history::RequestFilter;
    for _ in 0..300 {
        if let Ok(history) = state.history.lock()
            && let Ok(page) = history.list(&RequestFilter {
                limit: 100,
                ..Default::default()
            })
            && let Some(found) = page.into_iter().find(|request| request.id == id)
        {
            return Some(found);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    None
}

/// Key `secret-one`, provider `prov` (ZAI, unreachable example.invalid).
pub fn test_state() -> ApiState {
    state_with_keys(
        vec![ClientKey {
            alias: "test".into(),
            secret: "secret-one".into(),
        }],
        None,
    )
}

/// Chat tool route-test state: keys `secret-one` (alias `test`) and
/// `secret-two` (alias `other`), a chosen web search service, in-memory
/// memory with default bounds.
pub fn chat_state(web_search: Option<crate::web_search::WebSearchService>) -> ApiState {
    state_with_keys(
        vec![
            ClientKey {
                alias: "test".into(),
                secret: "secret-one".into(),
            },
            ClientKey {
                alias: "other".into(),
                secret: "secret-two".into(),
            },
        ],
        web_search,
    )
}

fn state_with_keys(
    keys: Vec<ClientKey>,
    web_search: Option<crate::web_search::WebSearchService>,
) -> ApiState {
    let conn = || rusqlite::Connection::open_in_memory().unwrap();
    let provider = ProviderConfig {
        provider_id: "prov".into(),
        driver: crate::config::DriverKind::Zai,
        base_url: "https://example.invalid/v1".into(),
        api_key: Some("k".into()),
        static_models: Vec::new(),
    };
    let (history, history_writer) = history_pair("support");
    ApiState {
        started_at_unix: 1_700_000_000,
        keys: KeyAuthenticator::new(keys),
        providers: ProviderRegistry::build(&[provider], crate::config::HttpTimeouts::default())
            .unwrap(),
        router: Router::new(
            BanStore::new(conn()).unwrap(),
            crate::config::BanPolicy::default(),
            crate::config::RetryPolicy::default(),
        ),
        metamodels: Mutex::new(MetamodelService::new(PoolStore::new(conn()).unwrap())),
        models: Mutex::new(ModelStore::new(conn()).unwrap()),
        history: Mutex::new(history),
        history_writer,
        running: crate::history::RunningRegistry::default(),
        events: std::sync::Arc::new(crate::storage::events::EventStore::new(conn()).unwrap()),
        knowledge: std::sync::Arc::new(
            crate::storage::knowledge::KnowledgeStore::new(conn()).unwrap(),
        ),
        knowledge_cfg: None,
        balances: Mutex::new(crate::storage::balances::BalanceStore::new(conn()).unwrap()),
        catalog_refresh: Mutex::new(HashMap::new()),
        refresh_running: std::sync::atomic::AtomicBool::new(false),
        history_writes: std::sync::Arc::new(Mutex::new(None)),
        chat: crate::api::ChatTools {
            web_search,
            memory: Mutex::new(
                crate::storage::memory::MemoryStore::new(
                    rusqlite::Connection::open_in_memory().unwrap(),
                )
                .unwrap(),
            ),
            memory_limits: crate::config::MemoryConfig::default(),
        },
    }
}
