// Application assembly and serving. Startup order: config, databases, HTTP.
// No graceful shutdown: a restart can cut active connections by design.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::api::{ApiState, routes};
use crate::config::Config;
use crate::metamodel::MetamodelService;
use crate::provider::ProviderRegistry;
use crate::routing::Router;
use crate::storage::{self, DbRole, bans::BanStore, catalog::ModelStore};
use crate::storage::{history::HistoryStore, pools::PoolStore};

use crate::api::auth::KeyAuthenticator;
use crate::history::writer::{DEFAULT_BUDGET, DEFAULT_FLUSH_EVERY, HistoryWriter};

pub struct App {
    state: Arc<ApiState>,
    listen: String,
    schedule_interval: Duration,
    retention: Duration,
}

impl App {
    /// Load config, open databases, prepare to serve. Blocking, runs once at startup.
    pub fn build(config: Config) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let dir = Path::new(&config.data_dir);
        // The catalog file serves three adapters; each takes its own
        // connection, and SQLite serializes writers via busy_timeout.
        let mut models = ModelStore::new(storage::open_file(dir, DbRole::Catalog)?)?;
        let pools = PoolStore::new(storage::open_file(dir, DbRole::Catalog)?)?;
        let events = std::sync::Arc::new(crate::storage::events::EventStore::new(
            storage::open_file(dir, DbRole::Events)?,
        )?);
        let bans = BanStore::with_events(
            storage::open_file(dir, DbRole::Catalog)?,
            Some(std::sync::Arc::clone(&events)),
        )?;
        let history = HistoryStore::new(storage::open_file(dir, DbRole::Requests)?)?;
        let knowledge = std::sync::Arc::new(crate::storage::knowledge::KnowledgeStore::new(
            storage::open_file(dir, DbRole::Knowledge)?,
        )?);
        let balances = crate::storage::balances::BalanceStore::new(storage::open_file(
            dir,
            DbRole::Balances,
        )?)?;
        // Unusable provider entries stop startup here, not on first request.
        let providers = ProviderRegistry::build(&config.providers, config.http)?;
        let router = Router::new(bans, config.ban, config.retry);

        let started_at_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            // A clock before the epoch breaks ids and history anyway; the
            // created timestamp is the least of the damage.
            .unwrap_or(0);
        // Static catalogs come from the config; a restart rereads the YAML.
        crate::schedule::seed_all_static_catalogs(&providers, &mut models)?;
        // The writer thread owns its own store handle; management reads
        // go through the short-lived lock in ApiState.
        let writer_store = HistoryStore::new(storage::open_file(dir, DbRole::Requests)?)?;
        let history_writes: std::sync::Arc<Mutex<Option<String>>> =
            std::sync::Arc::new(Mutex::new(None));
        let drop_report = {
            let history_writes = std::sync::Arc::clone(&history_writes);
            move |count: u32, reason: &str| {
                if let Ok(mut slot) = history_writes.lock() {
                    *slot = Some(format!("{count} request summaries dropped: {reason}"));
                }
            }
        };
        let history_writer = HistoryWriter::spawn(
            writer_store,
            DEFAULT_FLUSH_EVERY,
            DEFAULT_BUDGET,
            drop_report,
        );
        let chat = crate::api::ChatTools::build(&config)?;
        let state = Arc::new(ApiState {
            started_at_unix,
            keys: KeyAuthenticator::new(config.client_keys),
            providers,
            router,
            metamodels: Mutex::new(MetamodelService::new(pools)),
            models: Mutex::new(models),
            history: Mutex::new(history),
            history_writer,
            running: crate::history::RunningRegistry::default(),
            events,
            knowledge,
            knowledge_cfg: config.knowledge,
            research: Mutex::new(None),
            balances: Mutex::new(balances),
            catalog_refresh: Mutex::new(HashMap::new()),
            refresh_running: std::sync::atomic::AtomicBool::new(false),
            history_writes,
            chat,
        });
        Ok(Self {
            state,
            listen: config.listen,
            schedule_interval: config.schedule_interval,
            retention: config.retention,
        })
    }

    /// Bind the configured address and serve until the process stops.
    pub async fn run(self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        // Bind first: the port must be up in a fraction of a second. The
        // catalog is already seeded from the config and the last persisted
        // snapshot; the schedule loop refreshes upstreams right after — a
        // slow provider must not delay the service.
        crate::schedule::spawn(self.state.clone(), self.schedule_interval, self.retention);
        // A start marker on the event timeline explains gaps in history and
        // the loss of RAM session bindings after a restart.
        crate::schedule::emit(
            &self.state,
            crate::storage::events::event_kind::SERVER_STARTED,
            None,
            &serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
        );
        let listener = tokio::net::TcpListener::bind(&self.listen).await?;
        let state = self.state;
        tokio::spawn(force_stop(state.clone()));
        axum::serve(listener, http(state)).await?;
        Ok(())
    }

    /// Serve on a given listener. Separate from `run` so tests can bind port 0.
    #[cfg(test)]
    pub async fn serve_on(
        self,
        listener: tokio::net::TcpListener,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let state = self.state;
        axum::serve(listener, http(state)).await?;
        Ok(())
    }
}

/// API routes plus the embedded UI on every other path.
fn http(state: Arc<ApiState>) -> axum::Router {
    routes(state).fallback(crate::web::serve)
}

/// SIGTERM (procd) or Ctrl-C: stop NOW. Live connections are cut by
/// design — a restart must not hang on open dashboard streams or let procd
/// escalate to SIGKILL. The history queue is drained first: it is small and
/// local SQLite, milliseconds; two seconds is the never-hang ceiling.
async fn force_stop(state: Arc<ApiState>) {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                term.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    state.history_writer.shutdown();
    let drained = state.history_writer.wait_stopped(Duration::from_secs(2));
    if !drained {
        eprintln!("history writer did not flush in 2s; exiting anyway");
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ClientKey, Config, HttpTimeouts, ProviderConfig};
    use std::time::Duration;

    use crate::metamodel::{Metamodel, MetamodelId};
    use crate::model::{ModelId, ProviderId};
    use crate::storage::catalog::NewModel;
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_config(data_dir: &Path) -> Config {
        Config {
            listen: "127.0.0.1:0".into(),
            providers: Vec::<ProviderConfig>::new(),
            client_keys: vec![ClientKey {
                alias: "test".into(),
                secret: "s".into(),
            }],
            http: HttpTimeouts::default(),
            retry: crate::config::RetryPolicy::default(),
            ban: crate::config::BanPolicy::default(),
            knowledge: None,
            schedule_interval: Duration::from_secs(600),
            retention: Duration::from_secs(86_400),
            data_dir: data_dir.display().to_string(),
            web_search: None,
            memory: None,
        }
    }

    #[tokio::test]
    async fn serves_health_on_ephemeral_port() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::build(test_config(dir.path())).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(app.serve_on(listener));
        let resp = reqwest::get(format!("http://{addr}/health")).await.unwrap();
        // No providers are configured: the storages are fine, but the
        // proxy cannot serve inference, so it is degraded, not ok.
        assert_eq!(resp.status(), 503);
        let body: serde_json::Value = resp.json().await.unwrap();
        assert_eq!(body["status"], "degraded");
        assert_eq!(body["components"]["catalog"]["ok"], true);
        assert_eq!(body["components"]["balances"]["ok"], true);
        assert_eq!(body["components"]["requests"]["ok"], true);
        assert_eq!(body["components"]["providers"]["ok"], false);
    }

    #[tokio::test]
    async fn build_fails_when_database_cannot_open() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("catalog.sqlite")).unwrap();
        assert!(App::build(test_config(dir.path())).is_err());
    }

    #[tokio::test]
    async fn build_fails_when_a_provider_entry_is_unusable() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = test_config(dir.path());
        config.providers = vec![ProviderConfig {
            provider_id: "main".into(),
            driver: crate::config::DriverKind::OpenAi,
            base_url: "http://127.0.0.1:9".into(),
            api_key: None,
            static_models: Vec::new(),
        }];
        let error = App::build(config).err().unwrap().to_string();
        assert!(error.contains("not implemented"));
    }

    // ---- End-to-end: real config, real SQLite files, real Z.AI driver ----

    /// App plus a running server. `upstreams` maps provider ids to mock
    /// base urls; the pool `coding` holds their models in order.
    async fn e2e(
        dir: &Path,
        upstreams: &[(&str, &MockServer)],
        members: &[(&str, &str)],
    ) -> String {
        let mut config = test_config(dir);
        config.providers = upstreams
            .iter()
            .map(|(id, server)| ProviderConfig {
                provider_id: (*id).into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("zai-secret".into()),
                static_models: Vec::new(),
            })
            .collect();
        let app = App::build(config).unwrap();
        {
            // Seed the catalog snapshot and pool without a network refresh.
            for (id, _) in upstreams {
                let models: Vec<NewModel> = members
                    .iter()
                    .filter(|(p, _)| p == id)
                    .map(|(_, m)| NewModel {
                        upstream_id: (*m).into(),
                        context_tokens: Some(128_000),
                        observed_at_unix: 1,
                    })
                    .collect();
                app.state
                    .models
                    .lock()
                    .unwrap()
                    .replace_snapshot(id, models)
                    .unwrap();
            }
            let pool: Vec<ModelId> = members
                .iter()
                .map(|(p, m)| ModelId::new(ProviderId::new((*p).to_string()), (*m).to_string()))
                .collect();
            app.state
                .metamodels
                .lock()
                .unwrap()
                .create(Metamodel::new(MetamodelId::new("coding"), pool).unwrap())
                .unwrap();
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(app.serve_on(listener));
        format!("http://{addr}")
    }

    type AttemptRow = (String, String, String, Option<u64>, Option<u64>);

    /// One persisted attempt: provider, upstream, result, input and
    /// output tokens. The writer persists asynchronously, so the reader
    /// polls with a bounded wait instead of a sleep.
    fn history(dir: &Path, expected: usize) -> Vec<AttemptRow> {
        for _ in 0..200 {
            let conn = rusqlite::Connection::open(dir.join("requests.sqlite")).unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT provider_id, upstream_id, result, input_tokens, output_tokens
                     FROM attempts ORDER BY id",
                )
                .unwrap();
            let rows: Vec<AttemptRow> = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .unwrap()
                .map(Result::unwrap)
                .collect();
            if rows.len() >= expected {
                return rows;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("timed out waiting for {expected} history rows");
    }

    #[tokio::test]
    async fn e2e_non_streaming_completion_goes_through_the_whole_stack() {
        let dir = tempfile::tempdir().unwrap();
        let primary = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(header("authorization", "Bearer zai-secret"))
            // The client asks for "coding"; the upstream sees the member id.
            .and(body_partial_json(json!({"model": "glm-4.7"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"role": "assistant", "content": "hello"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            })))
            .expect(1)
            .mount(&primary)
            .await;

        let base = e2e(dir.path(), &[("main", &primary)], &[("main", "glm-4.7")]).await;

        let response = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("s")
            .json(&json!({
                "model": "coding",
                "messages": [{"role": "user", "content": "hi"}],
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["choices"][0]["message"]["content"], "hello");

        primary.verify().await;
        assert_eq!(
            history(dir.path(), 1),
            vec![(
                "main".into(),
                "glm-4.7".into(),
                "ok".into(),
                Some(3),
                Some(2)
            )]
        );
    }

    #[tokio::test]
    async fn e2e_fallback_and_session_stickiness() {
        let dir = tempfile::tempdir().unwrap();
        let primary = MockServer::start().await;
        // A bare 500 is class Unknown: no retry, straight to the next member.
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(500))
            .expect(1)
            .mount(&primary)
            .await;
        let backup = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"role": "assistant", "content": "from backup"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            })))
            .expect(2)
            .mount(&backup)
            .await;

        let base = e2e(
            dir.path(),
            &[("main", &primary), ("backup", &backup)],
            &[("main", "glm"), ("backup", "glm-2")],
        )
        .await;

        // Two requests of one conversation, recognized by x-session-id.
        for _ in 0..2 {
            let response = reqwest::Client::new()
                .post(format!("{base}/v1/chat/completions"))
                .bearer_auth("s")
                .header("x-session-id", "conv-1")
                .json(&json!({
                    "model": "coding",
                    "messages": [{"role": "user", "content": "hi"}],
                }))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            let body: serde_json::Value = response.json().await.unwrap();
            assert_eq!(body["choices"][0]["message"]["content"], "from backup");
        }

        // The failed member was tried exactly once; the pinned fallback
        // served both requests.
        primary.verify().await;
        backup.verify().await;
        let attempts = history(dir.path(), 3);
        assert_eq!(attempts.len(), 3);
        assert_eq!(attempts[0].2, "error");
        assert_eq!(attempts[0].1, "glm");
        assert_eq!(attempts[1].2, "ok");
        assert_eq!(attempts[1].1, "glm-2");
        // The second request went straight to the pinned member.
        assert_eq!(attempts[2].1, "glm-2");
    }

    #[tokio::test]
    async fn e2e_streaming_relays_sse_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let primary = MockServer::start().await;
        let sse = "data: {\"delta\":\"he\"}\n\ndata: {\"delta\":\"llo\"}\n\ndata: [DONE]\n\n";
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "text/event-stream")
                    .set_body_string(sse),
            )
            .expect(1)
            .mount(&primary)
            .await;

        let base = e2e(dir.path(), &[("main", &primary)], &[("main", "glm")]).await;

        let response = reqwest::Client::new()
            .post(format!("{base}/v1/chat/completions"))
            .bearer_auth("s")
            .json(&json!({
                "model": "coding",
                "messages": [{"role": "user", "content": "hi"}],
                "stream": true,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let body = response.text().await.unwrap();
        assert_eq!(body, sse);
        primary.verify().await;
    }
}
