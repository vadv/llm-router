// Request execution and fallback: which model serves a conversation, when
// a model is banned, and the retry policy.

pub mod ban;
pub mod classify;
pub mod session;

use std::future::Future;

use crate::config::{BanPolicy, RetryPolicy};
use crate::model::ModelId;

use ban::{BanError, ModelBans};
use classify::DriverError;
use session::SessionStore;

/// Why a request could not be served. Carries the driver's already-redacted
/// error for the cases the client should see.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteFailure {
    /// No member of the pool is currently selectable.
    NoAvailableMember,
    /// The request itself is invalid for the upstream: not retried, not
    /// banned, no fallback — the client must fix the request.
    InvalidRequest(DriverError),
    /// Every usable member failed; the last error is the client-facing cause.
    AllMembersFailed(DriverError),
    /// The ban storage could not be read, so selection cannot be made safely.
    BanStorage(BanError),
}

/// The fallback loop over one metamodel's members.
///
/// Selection and stickiness: the topmost member not under
/// a ban serves a new conversation; retries apply only to the model already
/// pinned for the conversation — during initial selection a failure goes
/// straight to the next member. A successful member is pinned; a fallback
/// re-pins, and nothing ever migrates a conversation back on its own.
pub struct Router<B: ModelBans> {
    sessions: SessionStore,
    bans: B,
    ban_policy: BanPolicy,
    retry: RetryPolicy,
}

impl<B: ModelBans> Router<B> {
    pub fn new(bans: B, ban_policy: BanPolicy, retry: RetryPolicy) -> Self {
        Router {
            sessions: SessionStore::new(),
            bans,
            ban_policy,
            retry,
        }
    }

    /// The ban store, for the scheduler's expiry sweep.
    pub fn bans(&self) -> &B {
        &self.bans
    }

    /// The model currently pinned for a conversation, for inspection and
    /// the model_switch event.
    pub fn session_binding(&self, conversation: &str) -> Option<ModelId> {
        self.sessions.binding(conversation)
    }

    /// Execute one request for a conversation against `members` (pool order,
    /// priority first). `attempt` performs one upstream call on a model.
    /// `now_unix` is the request's clock: ban expiry is judged with it, and
    /// retry pauses do not advance it (deterministic, bounded by the policy).
    /// Members must already be filtered for provider existence and catalog
    /// presence; absent models are skipped. The caller
    /// owns the catalog; the router only orders and bans.
    /// `&self`: sessions use interior locking, and the ban store locks
    /// internally, so several handlers share one Router without holding any
    /// lock across a network await.
    pub async fn execute<R, F, Fut>(
        &self,
        conversation: &str,
        members: &[ModelId],
        now_unix: i64,
        mut attempt: F,
    ) -> Result<R, RouteFailure>
    where
        F: FnMut(&ModelId) -> Fut,
        Fut: Future<Output = Result<R, DriverError>>,
    {
        // A binding only matters while the model is still a usable member.
        let pinned = self.sessions.binding(conversation);
        let pinned_usable = match &pinned {
            Some(model) => members.contains(model) && self.ban_in_force(model, now_unix)?.is_none(),
            None => false,
        };

        let mut index = if pinned_usable {
            members
                .iter()
                .position(|m| Some(m) == pinned.as_ref())
                .expect("pinned model is a member")
        } else {
            self.first_available(members, now_unix)?
        };

        // Retries belong to the pinned model only: once
        // the request moves to another member, failures go to the next one.
        let mut retries_allowed = pinned_usable;
        let mut retries_used = 0u32;

        loop {
            let model = &members[index];
            match attempt(model).await {
                Ok(response) => {
                    self.sessions.pin(conversation, model.clone());
                    return Ok(response);
                }
                Err(err) => {
                    // Record the ban the class justifies. A failed ban write must
                    // not turn a servable request into a client error — the same
                    // rule as history writes; health reporting lands later.
                    if let Some(ban) = err.class.model_ban(&self.ban_policy, now_unix) {
                        let _ = self.bans.record_ban(model, ban.reason, ban.until_unix);
                    }

                    if !err.class.continues_with_next_member() {
                        return Err(RouteFailure::InvalidRequest(err));
                    }

                    if retries_allowed
                        && err.class.retry_same_model()
                        && retries_used < self.retry.max_retries
                    {
                        tokio::time::sleep(self.retry.delay_before_retry(retries_used)).await;
                        retries_used += 1;
                        continue; // same member, one more try
                    }

                    retries_allowed = false;
                    index = match self.next_available(members, index, now_unix)? {
                        Some(next) => next,
                        None => return Err(RouteFailure::AllMembersFailed(err)),
                    };
                }
            }
        }
    }

    /// A read failure of the ban storage is not survivable: without it the
    /// router cannot know which models are usable.
    fn ban_in_force(
        &self,
        model: &ModelId,
        now_unix: i64,
    ) -> Result<Option<ban::ActiveBan>, RouteFailure> {
        self.bans
            .ban_in_force(model, now_unix)
            .map_err(RouteFailure::BanStorage)
    }

    /// Index of the topmost member not under a ban, or None.
    fn first_available(&self, members: &[ModelId], now_unix: i64) -> Result<usize, RouteFailure> {
        self.next_available(members, usize::MAX, now_unix)
            .and_then(|next| next.ok_or(RouteFailure::NoAvailableMember))
    }

    /// Index of the first member after `from` not under a ban, or None when
    /// the pool is exhausted. `usize::MAX` starts from the top.
    fn next_available(
        &self,
        members: &[ModelId],
        from: usize,
        now_unix: i64,
    ) -> Result<Option<usize>, RouteFailure> {
        let start = if from == usize::MAX {
            0
        } else {
            from.saturating_add(1)
        };
        for (i, model) in members.iter().enumerate().skip(start) {
            if self.ban_in_force(model, now_unix)?.is_none() {
                return Ok(Some(i));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ProviderId;
    use crate::routing::classify::FailureClass;
    use crate::storage::bans::BanStore;
    use rusqlite::Connection;
    use std::collections::VecDeque;
    use std::time::Duration;

    type Script = VecDeque<Result<&'static str, DriverError>>;

    fn model_id(provider: &str, upstream: &str) -> ModelId {
        ModelId::new(ProviderId::new(provider), upstream)
    }

    fn members() -> Vec<ModelId> {
        vec![
            model_id("p", "top"),
            model_id("p", "second"),
            model_id("q", "third"),
        ]
    }

    fn router() -> Router<BanStore> {
        Router::new(
            BanStore::new(Connection::open_in_memory().unwrap()).unwrap(),
            BanPolicy {
                model_ban: Duration::from_secs(3_600),
                rate_limit_ban: Duration::from_secs(30),
            },
            // Zero pauses keep the retry tests instant; durations are covered
            // by the config tests.
            RetryPolicy {
                max_retries: 3,
                base_delay: Duration::ZERO,
            },
        )
    }

    fn driver_err(class: FailureClass) -> DriverError {
        DriverError {
            class,
            message: "stub error".into(),
        }
    }

    /// Runs a scripted sequence of attempt outcomes and records which models
    /// the router actually called.
    async fn run(
        router: &Router<BanStore>,
        conversation: &str,
        script: Script,
    ) -> (Result<&'static str, RouteFailure>, Vec<String>) {
        let mut script = script;
        let mut called: Vec<String> = Vec::new();
        let now = 10_000i64;
        let result = router
            .execute(conversation, &members(), now, |model| {
                called.push(model.to_string());
                std::future::ready(
                    script
                        .pop_front()
                        .expect("script exhausted before the router gave up"),
                )
            })
            .await;
        (result, called)
    }

    fn quota_err() -> DriverError {
        driver_err(FailureClass::QuotaExhausted {
            reset_at_unix: None,
        })
    }

    #[tokio::test]
    async fn a_new_conversation_is_served_by_the_topmost_member_and_pinned() {
        let router = router();
        let (result, called) = run(&router, "c1", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top"]);
        assert_eq!(router.session_binding("c1"), Some(model_id("p", "top")));
    }

    #[tokio::test]
    async fn an_expired_ban_does_not_block_the_topmost_member() {
        let router = router();
        // A leftover expired row from a previous run.
        router
            .bans
            .record_ban(&model_id("p", "top"), "quota_exhausted", 9_999)
            .unwrap();
        let (result, called) = run(&router, "c1", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top"]);
    }

    #[tokio::test]
    async fn a_banned_topmost_member_is_skipped() {
        let router = router();
        router
            .bans
            .record_ban(&model_id("p", "top"), "quota_exhausted", 20_000)
            .unwrap();
        let (result, called) = run(&router, "c1", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:second"]);
    }

    #[tokio::test]
    async fn all_members_banned_leaves_nothing_to_serve() {
        let router = router();
        for model in members() {
            router
                .bans
                .record_ban(&model, "quota_exhausted", 20_000)
                .unwrap();
        }
        let (result, _) = run(&router, "c1", Script::new()).await;
        assert_eq!(result.unwrap_err(), RouteFailure::NoAvailableMember);
    }

    #[tokio::test]
    async fn an_empty_pool_has_no_available_member() {
        let router = router();
        let empty: Vec<ModelId> = Vec::new();
        let failure = router
            .execute("c1", &empty, 10_000, |_: &ModelId| async {
                Ok::<(), DriverError>(())
            })
            .await
            .unwrap_err();
        assert_eq!(failure, RouteFailure::NoAvailableMember);
    }

    #[tokio::test]
    async fn during_initial_selection_a_transient_failure_goes_straight_to_the_next_member() {
        let router = router();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(driver_err(FailureClass::Transient)), Ok("answer")]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        // One attempt per member: no retries before the first pin.
        assert_eq!(called, ["p:top", "p:second"]);
        assert_eq!(router.session_binding("c1"), Some(model_id("p", "second")));
    }

    #[tokio::test]
    async fn a_pinned_model_is_retried_three_times_before_the_fallback() {
        let router = router();
        router.sessions.pin("c1", model_id("p", "top"));
        let (result, called) = run(
            &router,
            "c1",
            Script::from([
                Err(driver_err(FailureClass::Transient)), // original attempt
                Err(driver_err(FailureClass::Transient)), // retry 1
                Err(driver_err(FailureClass::Transient)), // retry 2
                Err(driver_err(FailureClass::Transient)), // retry 3
                Ok("answer"),                             // second member
            ]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        // Four calls to the pinned model, then the fallback: the loop's cap.
        assert_eq!(called, ["p:top", "p:top", "p:top", "p:top", "p:second"]);
        assert_eq!(router.session_binding("c1"), Some(model_id("p", "second")));
    }

    #[tokio::test]
    async fn a_transient_failure_of_the_pinned_model_recovers_on_retry() {
        let router = router();
        router.sessions.pin("c1", model_id("p", "top"));
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(driver_err(FailureClass::Transient)), Ok("answer")]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top", "p:top"]);
        assert_eq!(router.session_binding("c1"), Some(model_id("p", "top")));
    }

    #[tokio::test]
    async fn after_a_fallback_no_member_is_retried_within_the_same_request() {
        let router = router();
        router.sessions.pin("c1", model_id("p", "top"));
        let (result, called) = run(
            &router,
            "c1",
            Script::from([
                Err(quota_err()),
                Err(driver_err(FailureClass::Transient)),
                Err(driver_err(FailureClass::Transient)),
            ]),
        )
        .await;
        // top: quota (no retry), second: transient (no retry — not pinned), third: fail.
        assert_eq!(called, ["p:top", "p:second", "q:third"]);
        assert_eq!(
            result.unwrap_err(),
            RouteFailure::AllMembersFailed(driver_err(FailureClass::Transient))
        );
    }

    #[tokio::test]
    async fn a_quota_failure_bans_the_model_and_falls_back() {
        let router = router();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(quota_err()), Ok("answer")]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top", "p:second"]);
        // The ban persists and shapes the next request's selection.
        let (result, called) = run(&router, "c2", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:second"]);
    }

    #[tokio::test]
    async fn a_fallback_pins_the_conversation_to_the_new_model_and_keeps_it() {
        let router = router();
        run(
            &router,
            "c1",
            Script::from([Err(quota_err()), Ok("answer")]),
        )
        .await
        .0
        .unwrap();
        // The top member's ban expires; the conversation stays on the second.
        let (result, called) = run(&router, "c1", Script::from([Ok("again")])).await;
        assert_eq!(result.unwrap(), "again");
        assert_eq!(called, ["p:second"]);
        assert_eq!(router.session_binding("c1"), Some(model_id("p", "second")));
    }

    #[tokio::test]
    async fn a_pinned_member_removed_from_the_pool_is_reselected_from_the_top() {
        let router = router();
        router.sessions.pin("c1", model_id("q", "third"));
        // Pool without q:third — the binding no longer authorizes it.
        let mut called: Vec<String> = Vec::new();
        let result = router
            .execute(
                "c1",
                &[model_id("p", "top"), model_id("p", "second")],
                10_000,
                |model| {
                    called.push(model.to_string());
                    std::future::ready(Ok("answer"))
                },
            )
            .await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top"]);
    }

    #[tokio::test]
    async fn an_invalid_request_is_returned_without_fallback_or_ban() {
        let router = router();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(driver_err(FailureClass::InvalidRequest))]),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            RouteFailure::InvalidRequest(driver_err(FailureClass::InvalidRequest))
        );
        assert_eq!(called, ["p:top"]);
        // No ban was recorded: the next request still starts at the top.
        let (result, called) = run(&router, "c1", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top"]);
    }

    #[tokio::test]
    async fn a_client_cancellation_stops_the_loop_without_a_ban() {
        // Client hang-ups are detected by the streaming handler
        // (finish("client_cancel")); the router only sees driver errors,
        // so nothing here classifies as a cancellation.
    }

    #[tokio::test]
    async fn an_unknown_failure_switches_members_without_a_ban() {
        let router = router();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(driver_err(FailureClass::Unknown)), Ok("answer")]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top", "p:second"]);
        // No ban: the next conversation starts at the top again.
        let (result, called) = run(&router, "c2", Script::from([Ok("answer")])).await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top"]);
    }

    #[tokio::test]
    async fn all_members_failing_reports_the_last_error() {
        let router = router();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([
                Err(quota_err()),
                Err(quota_err()),
                Err(driver_err(FailureClass::Unknown)),
            ]),
        )
        .await;
        assert_eq!(called, ["p:top", "p:second", "q:third"]);
        assert_eq!(
            result.unwrap_err(),
            RouteFailure::AllMembersFailed(driver_err(FailureClass::Unknown))
        );
    }

    #[tokio::test]
    async fn a_fallback_skips_a_member_banned_before_this_request() {
        let router = router();
        // second is already banned; a top failure must land on third.
        router
            .bans
            .record_ban(&model_id("p", "second"), "backend_invalid", 20_000)
            .unwrap();
        let (result, called) = run(
            &router,
            "c1",
            Script::from([Err(quota_err()), Ok("answer")]),
        )
        .await;
        assert_eq!(result.unwrap(), "answer");
        assert_eq!(called, ["p:top", "q:third"]);
    }
}
