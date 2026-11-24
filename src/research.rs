// "Research every card": one background job at a time walks the catalog and
// asks the researcher for each model. Progress is a handful of atomics, so
// the dashboard reads it without waiting for the worker, and the job
// outlives the page that started it.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use serde_json::json;

use crate::api::ApiState;
use crate::config::KnowledgeConfig;
use crate::model::ProviderId;
use crate::provider::knowledge::research_card;
use crate::storage::events::event_kind::{KNOWLEDGE_CARD, KNOWLEDGE_ERROR};
use crate::storage::knowledge::NewCard;

/// Cards researched at the same time. Two keeps a long run from hammering
/// the researcher while still finishing a catalog in an evening.
const WORKERS: usize = 2;
/// Failures kept for the status answer, so a whole run can be retried from
/// it; the event log has them all as well.
const KEPT_ERRORS: usize = 500;
/// How long a card waits for its second try after the researcher failed
/// on a timeout, a reset connection or a rate limit.
const RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(20);

/// What to research: the connection to ask about, the id it lists, and
/// the key the card is stored under.
#[derive(Debug, Clone)]
pub struct Target {
    pub key: String,
    pub provider_id: String,
    pub upstream_id: String,
}

#[derive(Debug)]
pub enum StartError {
    NotConfigured,
    Running,
    Empty,
    Unavailable(String),
}

/// Progress of one run. `done` counts finished cards either way; the job
/// runs from a start time until a finish time is set.
#[derive(Debug, Default)]
pub struct ResearchProgress {
    total: AtomicUsize,
    done: AtomicUsize,
    updated: AtomicUsize,
    failed: AtomicUsize,
    skipped: AtomicUsize,
    started_at_unix: AtomicI64,
    finished_at_unix: AtomicI64,
    cancel: AtomicBool,
    /// Keys being researched right now, at most `WORKERS` of them.
    current: Mutex<Vec<String>>,
    errors: Mutex<Vec<serde_json::Value>>,
}

impl ResearchProgress {
    pub fn running(&self) -> bool {
        self.started_at_unix.load(Ordering::SeqCst) > 0
            && self.finished_at_unix.load(Ordering::SeqCst) == 0
    }

    /// The status answer of the management API.
    pub fn status(&self) -> serde_json::Value {
        let load = |counter: &AtomicUsize| counter.load(Ordering::SeqCst);
        json!({
            "running": self.running(),
            "total": load(&self.total),
            "done": load(&self.done),
            "updated": load(&self.updated),
            "failed": load(&self.failed),
            "skipped": load(&self.skipped),
            "current": self.current.lock().map(|keys| keys.clone()).unwrap_or_default(),
            "errors": self.errors.lock().map(|errors| errors.clone()).unwrap_or_default(),
            "cancel_requested": self.cancel.load(Ordering::SeqCst),
            "started_at_unix": self.started_at_unix.load(Ordering::SeqCst),
            "finished_at_unix": match self.finished_at_unix.load(Ordering::SeqCst) {
                0 => serde_json::Value::Null,
                at => json!(at),
            },
        })
    }
}

/// The current job, if the process ever ran one.
pub fn current(state: &ApiState) -> Option<Arc<ResearchProgress>> {
    state.research.lock().ok().and_then(|slot| slot.clone())
}

/// Whether the stored card of a key is younger than the configured age.
pub fn is_fresh(state: &ApiState, key: &str, max_age_secs: i64) -> bool {
    state
        .knowledge
        .get(key)
        .ok()
        .flatten()
        .is_some_and(|card| now_unix() - card.collected_at_unix < max_age_secs)
}

/// Every model of the catalog once, with the key the catalog reports for
/// it and the listing that names it most plainly.
pub fn targets(state: &ApiState) -> Result<Vec<Target>, String> {
    let models = state
        .models
        .lock()
        .map_err(|_| "catalog storage is unavailable".to_string())?
        .list_all()
        .map_err(|e| e.0)?;
    let exact: Vec<String> = models
        .iter()
        .map(|m| crate::model::knowledge_key(&m.upstream_id))
        .collect();
    let keys = crate::model::catalog_keys(&exact);
    // Two spellings are one model: both would be the same research call.
    let mut targets: HashMap<String, Target> = HashMap::new();
    for (model, exact) in models.into_iter().zip(exact) {
        let key = keys
            .get(&crate::model::knowledge_identity(&exact))
            .cloned()
            .unwrap_or(exact);
        let plainer = |current: &Target| {
            listing_rank(&model.upstream_id) < listing_rank(&current.upstream_id)
        };
        match targets.entry(key.clone()) {
            Entry::Occupied(mut slot) => {
                if plainer(slot.get()) {
                    slot.insert(Target {
                        key,
                        provider_id: model.provider_id,
                        upstream_id: model.upstream_id,
                    });
                }
            }
            Entry::Vacant(slot) => {
                slot.insert(Target {
                    key,
                    provider_id: model.provider_id,
                    upstream_id: model.upstream_id,
                });
            }
        }
    }
    let mut targets: Vec<Target> = targets.into_values().collect();
    targets.sort_by(|a, b| a.key.cmp(&b.key).then(a.provider_id.cmp(&b.provider_id)));
    Ok(targets)
}

/// How plainly a listing names its model: the plain id first, a ":free" or
/// ":batch" route next, a rolling "~vendor/model-latest" alias last. The
/// researcher gets the plainest one, so it looks up the model, not a route.
fn listing_rank(upstream_id: &str) -> u8 {
    if upstream_id.starts_with('~') {
        2
    } else if upstream_id.contains(':') {
        1
    } else {
        0
    }
}

/// Start researching the catalog in the background. `force` researches
/// fresh cards again; without it they are skipped.
pub fn start(state: &Arc<ApiState>, force: bool) -> Result<Arc<ResearchProgress>, StartError> {
    start_with_retry(state, force, RETRY_DELAY)
}

/// `start` with the wait before a retried card chosen by the caller.
fn start_with_retry(
    state: &Arc<ApiState>,
    force: bool,
    retry_delay: std::time::Duration,
) -> Result<Arc<ResearchProgress>, StartError> {
    if state.knowledge_cfg.is_none() {
        return Err(StartError::NotConfigured);
    }
    let mut slot = state
        .research
        .lock()
        .map_err(|_| StartError::Unavailable("research job state is unavailable".into()))?;
    if slot.as_ref().is_some_and(|job| job.running()) {
        return Err(StartError::Running);
    }
    let targets = targets(state).map_err(StartError::Unavailable)?;
    if targets.is_empty() {
        return Err(StartError::Empty);
    }
    let job = Arc::new(ResearchProgress::default());
    job.total.store(targets.len(), Ordering::SeqCst);
    job.started_at_unix.store(now_unix(), Ordering::SeqCst);
    *slot = Some(Arc::clone(&job));
    drop(slot);
    crate::schedule::emit(
        state.as_ref(),
        crate::storage::events::event_kind::KNOWLEDGE_RESEARCH_STARTED,
        None,
        &json!({ "total": targets.len(), "force": force }),
    );
    let worker_state = Arc::clone(state);
    tokio::spawn(run(
        worker_state,
        Arc::clone(&job),
        targets,
        force,
        retry_delay,
    ));
    Ok(job)
}

/// Ask the running job to stop after the cards already in flight.
pub fn cancel(state: &ApiState) {
    if let Some(job) = current(state) {
        job.cancel.store(true, Ordering::SeqCst);
    }
}

async fn run(
    state: Arc<ApiState>,
    job: Arc<ResearchProgress>,
    targets: Vec<Target>,
    force: bool,
    retry_delay: std::time::Duration,
) {
    futures_util::stream::iter(targets)
        .for_each_concurrent(WORKERS, |target| {
            let state = Arc::clone(&state);
            let job = Arc::clone(&job);
            async move { research_one(&state, &job, &target, force, retry_delay).await }
        })
        .await;
    job.finished_at_unix.store(now_unix(), Ordering::SeqCst);
    let status = job.status();
    crate::schedule::emit(
        &state,
        crate::storage::events::event_kind::KNOWLEDGE_RESEARCH_FINISHED,
        None,
        &json!({
            "total": status["total"], "updated": status["updated"],
            "failed": status["failed"], "skipped": status["skipped"],
            "cancelled": status["cancel_requested"],
        }),
    );
}

/// Whether a failure came from the researcher's side: the network, the HTTP
/// status, a body without an answer. Such a failure says nothing about the
/// model, so a second try may well succeed.
fn is_upstream(error: &str) -> bool {
    error.starts_with("upstream:")
}

/// Research one card, or skip it. Counts it either way, so `done` always
/// reaches `total`.
async fn research_one(
    state: &ApiState,
    job: &ResearchProgress,
    target: &Target,
    force: bool,
    retry_delay: std::time::Duration,
) {
    if job.cancel.load(Ordering::SeqCst) {
        job.skipped.fetch_add(1, Ordering::SeqCst);
        job.done.fetch_add(1, Ordering::SeqCst);
        return;
    }
    let Some(cfg) = state.knowledge_cfg.as_ref() else {
        return;
    };
    if !force && is_fresh(state, &target.key, cfg.max_age.as_secs() as i64) {
        // Fresh here, but a spelling of the same model may hold the card
        // from before this job researched one spelling per model.
        let _ = share_card(state, &target.key);
        job.skipped.fetch_add(1, Ordering::SeqCst);
        job.done.fetch_add(1, Ordering::SeqCst);
        return;
    }
    if let Ok(mut current) = job.current.lock() {
        current.push(target.key.clone());
    }
    let mut outcome = collect_card(
        state,
        cfg,
        &target.provider_id,
        &target.upstream_id,
        &target.key,
    )
    .await;
    // One more try when the researcher itself failed: a run of several
    // hours should not leave a model on an old card because of one timeout.
    // A card the researcher answered but could not get right is final; the
    // repair round inside the call already ran.
    if outcome
        .as_ref()
        .err()
        .is_some_and(|error| is_upstream(error))
        && !job.cancel.load(Ordering::SeqCst)
    {
        tokio::time::sleep(retry_delay).await;
        outcome = collect_card(
            state,
            cfg,
            &target.provider_id,
            &target.upstream_id,
            &target.key,
        )
        .await;
    }
    if let Ok(mut current) = job.current.lock() {
        current.retain(|key| key != &target.key);
    }
    job.done.fetch_add(1, Ordering::SeqCst);
    match outcome {
        Ok(_) => {
            job.updated.fetch_add(1, Ordering::SeqCst);
        }
        Err(error) => {
            job.failed.fetch_add(1, Ordering::SeqCst);
            if let Ok(mut errors) = job.errors.lock() {
                if errors.len() >= KEPT_ERRORS {
                    errors.remove(0);
                }
                errors.push(json!({ "key": target.key, "error": error }));
            }
        }
    }
}

/// What one research call left behind.
#[derive(Debug, Clone)]
pub struct Collected {
    pub card_json: String,
    pub repairs: Vec<String>,
    pub collected_at_unix: i64,
}

/// Research one model and store its card under `key`. Emits the
/// `knowledge_card` or `knowledge_error` event either way.
pub async fn collect_card(
    state: &ApiState,
    cfg: &KnowledgeConfig,
    provider_id: &str,
    upstream_id: &str,
    key: &str,
) -> Result<Collected, String> {
    let provider = state
        .providers
        .get(&ProviderId::new(cfg.provider_id.clone()));
    let Some(provider) = provider else {
        return Err("knowledge provider disappeared from the registry".into());
    };
    let generator = format!("{}/{}", cfg.provider_id, cfg.model);
    let collected =
        match research_card(provider.driver(), &cfg.model, upstream_id, provider_id).await {
            Ok(collected) => collected,
            Err(e) => {
                crate::schedule::emit(
                    state,
                    KNOWLEDGE_ERROR,
                    None,
                    &json!({ "key": key, "upstream_id": upstream_id, "error": e.0 }),
                );
                return Err(e.0);
            }
        };
    let collected_at_unix = now_unix();
    state
        .knowledge
        .upsert(&NewCard {
            key: key.to_string(),
            card_json: collected.card_json.clone(),
            collected_at_unix,
            generator: format!("{generator}+websearch"),
        })
        .map_err(|e| e.0)?;
    crate::schedule::emit(
        state,
        KNOWLEDGE_CARD,
        None,
        &json!({
            "key": key,
            "upstream_id": upstream_id,
            "provider_id": provider_id,
            "generator": generator,
        }),
    );
    let _ = share_card(state, key);
    Ok(Collected {
        card_json: collected.card_json,
        repairs: collected.repairs,
        collected_at_unix,
    })
}

/// The other keys the catalog files under the same model as `key`.
/// Providers spell one name two ways (`qwen3.7-max` and `qwen-3.7-max`),
/// and each spelling is a row of its own, shown for its own listings.
fn other_spellings(state: &ApiState, key: &str) -> Vec<String> {
    let Ok(models) = state.models.lock() else {
        return Vec::new();
    };
    let Ok(models) = models.list_all() else {
        return Vec::new();
    };
    let identity = crate::model::knowledge_identity(key);
    let mut keys: Vec<String> = models
        .iter()
        .map(|model| crate::model::knowledge_key(&model.upstream_id))
        .filter(|exact| *exact != key && crate::model::knowledge_identity(exact) == identity)
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

/// Write the card stored under `key` under the other spellings of its
/// model, wherever their own card is older. A model is researched once,
/// under one spelling; without this the other spelling keeps the card it
/// had before, and the same model reads two ways. Says how many rows were
/// brought up to date.
fn share_card(state: &ApiState, key: &str) -> Result<usize, String> {
    let others = other_spellings(state, key);
    if others.is_empty() {
        return Ok(0);
    }
    let Some(source) = state.knowledge.get(key).map_err(|e| e.0)? else {
        return Ok(0);
    };
    let mut shared = 0;
    for other in others {
        // A spelling without a row of its own already reads a sibling's.
        let older = state
            .knowledge
            .get(&other)
            .map_err(|e| e.0)?
            .is_none_or(|card| card.collected_at_unix < source.collected_at_unix);
        if older {
            state
                .knowledge
                .upsert(&NewCard {
                    key: other,
                    card_json: source.card_json.clone(),
                    collected_at_unix: source.collected_at_unix,
                    generator: source.generator.clone(),
                })
                .map_err(|e| e.0)?;
            shared += 1;
        }
    }
    Ok(shared)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::catalog::NewModel;

    fn state() -> Arc<ApiState> {
        Arc::new(crate::api::tests_support::test_state())
    }

    #[tokio::test]
    async fn targets_are_one_per_model_under_the_catalog_key() {
        let st = state();
        let listing = |upstream_id: &str| NewModel {
            upstream_id: upstream_id.into(),
            context_tokens: None,
            observed_at_unix: 1,
        };
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "tokenator",
                    vec![listing("cursor-qwen-3.7-plus"), listing("gpt-oss-20b:free")],
                )
                .unwrap();
            models
                .replace_snapshot("alibaba", vec![listing("qwen3.7-plus")])
                .unwrap();
            models
                .replace_snapshot("opencode", vec![listing("qwen3.7-plus")])
                .unwrap();
            models
                .replace_snapshot(
                    "zai",
                    vec![
                        listing("~openai/gpt-oss-20b-latest"),
                        listing("openai/gpt-oss-20b"),
                    ],
                )
                .unwrap();
        }
        let list = targets(&st).unwrap();
        let names: Vec<(&str, &str, &str)> = list
            .iter()
            .map(|t| {
                (
                    t.key.as_str(),
                    t.provider_id.as_str(),
                    t.upstream_id.as_str(),
                )
            })
            .collect();
        // Two spellings are one model, named by the listing most providers
        // use and researched through the listing that names it most plainly.
        // A rolling "~…-latest" alias is its own entry: it is looked up as
        // the pointer it is.
        assert_eq!(
            names,
            vec![
                ("gpt-oss-20b", "zai", "openai/gpt-oss-20b"),
                ("gpt-oss-20b-latest", "zai", "~openai/gpt-oss-20b-latest"),
                ("qwen3-7-plus", "alibaba", "qwen3.7-plus")
            ]
        );
        assert!(targets(&state()).unwrap().is_empty());
    }

    #[test]
    fn a_job_reports_progress_and_stops_running_when_finished() {
        let job = ResearchProgress::default();
        let idle = job.status();
        assert_eq!(idle["running"], false);
        assert!(idle["finished_at_unix"].is_null());

        job.total.store(3, Ordering::SeqCst);
        job.started_at_unix.store(100, Ordering::SeqCst);
        job.done.store(2, Ordering::SeqCst);
        job.updated.store(1, Ordering::SeqCst);
        job.failed.store(1, Ordering::SeqCst);
        job.current.lock().unwrap().push("glm-5-3".into());
        job.errors
            .lock()
            .unwrap()
            .push(json!({ "key": "kimi-k3", "error": "upstream: timeout" }));
        let running = job.status();
        assert_eq!(running["running"], true);
        assert_eq!(running["total"], 3);
        assert_eq!(running["done"], 2);
        assert_eq!(running["current"], json!(["glm-5-3"]));
        assert_eq!(running["errors"][0]["key"], "kimi-k3");

        job.finished_at_unix.store(200, Ordering::SeqCst);
        assert_eq!(job.status()["running"], false);
        assert_eq!(job.status()["finished_at_unix"], 200);
    }

    #[tokio::test]
    async fn starting_needs_a_configured_researcher_and_a_catalog() {
        let st = state();
        assert!(matches!(start(&st, false), Err(StartError::NotConfigured)));
        let mut configured = crate::api::tests_support::test_state();
        configured.knowledge_cfg = Some(KnowledgeConfig {
            provider_id: "prov".into(),
            model: "researcher".into(),
            max_age: std::time::Duration::from_secs(86_400),
        });
        let st = Arc::new(configured);
        assert!(matches!(start(&st, false), Err(StartError::Empty)));
        st.models
            .lock()
            .unwrap()
            .replace_snapshot(
                "prov",
                vec![NewModel {
                    upstream_id: "m1".into(),
                    context_tokens: None,
                    observed_at_unix: 1,
                }],
            )
            .unwrap();
        // The researcher connection is unreachable in tests: the job runs,
        // fails the one card honestly, and finishes.
        let job = start_with_retry(&st, false, std::time::Duration::from_millis(10)).unwrap();
        assert!(job.running());
        assert!(matches!(
            start_with_retry(&st, true, std::time::Duration::ZERO),
            Err(StartError::Running)
        ));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while job.running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let status = job.status();
        assert_eq!(status["running"], false);
        assert_eq!(status["done"], 1);
        assert_eq!(status["failed"], 1);
        assert_eq!(status["errors"][0]["key"], "m1");
        let events = st.events.list(10).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds[0], "knowledge_research_finished");
        assert!(kinds.contains(&"knowledge_research_started"));
        // A finished job does not block the next one.
        assert!(start_with_retry(&st, true, std::time::Duration::ZERO).is_ok());
        cancel(&st);
        assert!(job.status()["cancel_requested"].as_bool().is_some());
    }

    #[tokio::test]
    async fn a_card_whose_research_call_failed_gets_one_more_try() {
        use std::time::Duration;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        let mut configured = crate::api::tests_support::test_state();
        configured.knowledge_cfg = Some(KnowledgeConfig {
            provider_id: "prov".into(),
            model: "researcher".into(),
            max_age: Duration::from_secs(86_400),
        });
        configured.providers = crate::provider::ProviderRegistry::build(
            &[crate::config::ProviderConfig {
                provider_id: "prov".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("k".into()),
                static_models: Vec::new(),
            }],
            crate::config::HttpTimeouts::default(),
        )
        .unwrap();
        let st = Arc::new(configured);
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "prov",
                    vec![NewModel {
                        upstream_id: "m1".into(),
                        context_tokens: None,
                        observed_at_unix: 1,
                    }],
                )
                .unwrap();
        }
        // The first call fails at the researcher; the second answers a card.
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"content": "{\"description\":\"d\",\"sources\":[\"u\"]}"}}]
            })))
            .expect(1)
            .mount(&server)
            .await;
        let job = start_with_retry(&st, false, Duration::from_millis(10)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while job.running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let status = job.status();
        assert_eq!(status["running"], false);
        assert_eq!(status["done"], 1);
        assert_eq!(status["updated"], 1);
        assert_eq!(status["failed"], 0);
        assert!(status["errors"].as_array().unwrap().is_empty());
        assert!(st.knowledge.get("m1").unwrap().is_some());
        // The hiccup stays on the record; the card is what the second call wrote.
        let events = st.events.list(10).unwrap();
        let kinds: Vec<&str> = events.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == "knowledge_error")
                .count(),
            1
        );
        assert_eq!(
            kinds
                .iter()
                .filter(|kind| **kind == "knowledge_card")
                .count(),
            1
        );
        server.verify().await;
    }

    /// A catalog where one model is spelled two ways, and another model
    /// beside it that must stay out of whatever happens to the first.
    fn two_spellings() -> Arc<ApiState> {
        let st = state();
        let listing = |upstream_id: &str| NewModel {
            upstream_id: upstream_id.into(),
            context_tokens: None,
            observed_at_unix: 1,
        };
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "tokenator",
                    vec![listing("qwen-3.7-max"), listing("kimi-k3")],
                )
                .unwrap();
            models
                .replace_snapshot("alibaba", vec![listing("qwen3.7-max")])
                .unwrap();
        }
        st
    }

    fn card(key: &str, json: &str, collected_at_unix: i64) -> NewCard {
        NewCard {
            key: key.into(),
            card_json: json.into(),
            collected_at_unix,
            generator: "g".into(),
        }
    }

    #[test]
    fn a_card_reaches_the_other_spelling_of_its_model_when_that_one_is_older() {
        let st = two_spellings();
        st.knowledge
            .upsert(&card("qwen3-7-max", r#"{"v":1}"#, 100))
            .unwrap();
        st.knowledge
            .upsert(&card("qwen-3-7-max", r#"{"v":2}"#, 200))
            .unwrap();
        st.knowledge
            .upsert(&card("kimi-k3", r#"{"v":9}"#, 50))
            .unwrap();
        // Researched under one spelling; the other is brought up to date.
        assert_eq!(share_card(&st, "qwen-3-7-max").unwrap(), 1);
        let other = st.knowledge.get("qwen3-7-max").unwrap().unwrap();
        assert_eq!(other.card_json, r#"{"v":2}"#);
        assert_eq!(other.collected_at_unix, 200);
        // Equal now: nothing left to write, and the other model is untouched.
        assert_eq!(share_card(&st, "qwen-3-7-max").unwrap(), 0);
        assert_eq!(
            st.knowledge.get("kimi-k3").unwrap().unwrap().card_json,
            r#"{"v":9}"#
        );
        // A newer card on the other side is not overwritten either.
        st.knowledge
            .upsert(&card("qwen3-7-max", r#"{"v":3}"#, 300))
            .unwrap();
        assert_eq!(share_card(&st, "qwen-3-7-max").unwrap(), 0);
        assert_eq!(
            st.knowledge.get("qwen-3-7-max").unwrap().unwrap().card_json,
            r#"{"v":2}"#
        );
        // From the newer side, it does reach the older one.
        assert_eq!(share_card(&st, "qwen3-7-max").unwrap(), 1);
        assert_eq!(
            st.knowledge.get("qwen-3-7-max").unwrap().unwrap().card_json,
            r#"{"v":3}"#
        );
        // A model nobody spelled twice, or never researched, is left alone.
        assert_eq!(share_card(&st, "kimi-k3").unwrap(), 0);
        assert_eq!(share_card(&st, "never-heard-of").unwrap(), 0);
    }

    #[tokio::test]
    async fn a_fresh_card_reaches_a_stale_spelling_without_a_research_call() {
        use std::time::Duration;

        let server = wiremock::MockServer::start().await;
        let mut configured = crate::api::tests_support::test_state();
        configured.knowledge_cfg = Some(KnowledgeConfig {
            provider_id: "prov".into(),
            model: "researcher".into(),
            max_age: Duration::from_secs(86_400),
        });
        configured.providers = crate::provider::ProviderRegistry::build(
            &[crate::config::ProviderConfig {
                provider_id: "prov".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("k".into()),
                static_models: Vec::new(),
            }],
            crate::config::HttpTimeouts::default(),
        )
        .unwrap();
        let st = Arc::new(configured);
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "prov",
                    vec![
                        NewModel {
                            upstream_id: "qwen3.7-max".into(),
                            context_tokens: None,
                            observed_at_unix: 1,
                        },
                        NewModel {
                            upstream_id: "qwen-3.7-max".into(),
                            context_tokens: None,
                            observed_at_unix: 1,
                        },
                    ],
                )
                .unwrap();
        }
        // An earlier run researched the spelling that is the model's key
        // today; the other spelling kept the card from before that.
        let now = now_unix();
        st.knowledge
            .upsert(&card("qwen-3-7-max", r#"{"v":2}"#, now))
            .unwrap();
        st.knowledge
            .upsert(&card("qwen3-7-max", r#"{"v":1}"#, 100))
            .unwrap();
        let job = start_with_retry(&st, false, Duration::from_millis(10)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while job.running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let status = job.status();
        assert_eq!(status["running"], false);
        assert_eq!(status["total"], 1);
        // Nothing was researched; the old row was only brought up to date.
        assert_eq!(status["updated"], 0);
        assert_eq!(status["skipped"], 1);
        let received = server.received_requests().await.unwrap_or_default();
        let paths: Vec<&str> = received.iter().map(|request| request.url.path()).collect();
        assert!(
            !paths.contains(&"/chat/completions"),
            "researched anyway: {paths:?}"
        );
        let other = st.knowledge.get("qwen3-7-max").unwrap().unwrap();
        assert_eq!(other.card_json, r#"{"v":2}"#);
        assert_eq!(other.collected_at_unix, now);
    }

    #[tokio::test]
    async fn a_researched_card_is_written_under_every_spelling_of_its_model() {
        use std::time::Duration;
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, ResponseTemplate};

        let server = wiremock::MockServer::start().await;
        let mut configured = crate::api::tests_support::test_state();
        configured.knowledge_cfg = Some(KnowledgeConfig {
            provider_id: "prov".into(),
            model: "researcher".into(),
            max_age: Duration::from_secs(86_400),
        });
        configured.providers = crate::provider::ProviderRegistry::build(
            &[crate::config::ProviderConfig {
                provider_id: "prov".into(),
                driver: crate::config::DriverKind::Zai,
                base_url: server.uri(),
                api_key: Some("k".into()),
                static_models: Vec::new(),
            }],
            crate::config::HttpTimeouts::default(),
        )
        .unwrap();
        let st = Arc::new(configured);
        {
            let mut models = st.models.lock().unwrap();
            models
                .replace_snapshot(
                    "prov",
                    vec![
                        NewModel {
                            upstream_id: "qwen3.7-max".into(),
                            context_tokens: None,
                            observed_at_unix: 1,
                        },
                        NewModel {
                            upstream_id: "qwen-3.7-max".into(),
                            context_tokens: None,
                            observed_at_unix: 1,
                        },
                    ],
                )
                .unwrap();
        }
        st.knowledge
            .upsert(&card("qwen3-7-max", r#"{"v":1}"#, 100))
            .unwrap();
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{"message": {"content": "{\"description\":\"d\",\"sources\":[\"u\"]}"}}]
            })))
            // One model, one call: the second spelling is not researched again.
            .expect(1)
            .mount(&server)
            .await;
        let job = start_with_retry(&st, true, Duration::from_millis(10)).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while job.running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let status = job.status();
        assert_eq!(status["running"], false);
        assert_eq!(status["total"], 1);
        assert_eq!(status["updated"], 1);
        assert_eq!(status["failed"], 0);
        let researched = st.knowledge.get("qwen-3-7-max").unwrap().unwrap();
        let other = st.knowledge.get("qwen3-7-max").unwrap().unwrap();
        assert!(researched.collected_at_unix > 100);
        assert_eq!(other.card_json, researched.card_json);
        assert_eq!(other.collected_at_unix, researched.collected_at_unix);
        // The event log names the one card that was researched.
        let events = st.events.list(10).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == KNOWLEDGE_CARD)
                .count(),
            1
        );
        server.verify().await;
    }
}
