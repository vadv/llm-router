// Classification of upstream failures. The driver recognizes the meaning
// from the response (status, structured code, body, headers); routing owns
// the consequences: retry the pinned model, record a model ban, continue
// with the next member, or return an error to the client. Recognition rules
// live with each driver — an HTTP status alone never decides here.

use std::time::Duration;

use crate::config::BanPolicy;

/// What the driver recognized in a failure. The variants carry deadlines the
/// driver already validated (units, meaning); None never invents a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureClass {
    /// Recognized quota/balance/subscription exhaustion. Retrying cannot
    /// fix it; the provider-reported reset time replaces the configured
    /// ban duration when it is known and still in the future.
    QuotaExhausted { reset_at_unix: Option<i64> },
    /// Recognized short-term rate limit, distinct from an exhausted
    /// subscription. Retry-After as validated by the driver, if any.
    RateLimited { retry_after_unix: Option<i64> },
    /// Broken backend: rejected credentials, missing entitlement.
    /// Ban the model; the failure is not the request's fault.
    InvalidBackend,
    /// Recognized transient failure: timeout, overload, upstream gateway
    /// error. Worth retrying the same model before switching.
    Transient,
    /// The request itself is malformed for the upstream. Not retried on
    /// another member, not a reason to ban the model.
    InvalidRequest,
    /// This member rejected the request with HTTP 400. Another may accept it.
    UpstreamBadRequest,
    /// Nothing recognizable. No invented cause: no ban, no retry — only a
    /// switch to the next member.
    Unknown,
}

/// A failed attempt as reported by a driver. The message is already
/// redacted by the driver: no credentials, no auth headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriverError {
    pub class: FailureClass,
    pub message: String,
}

/// The ban to record for the failing model, if the class calls for one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelBan {
    pub reason: &'static str,
    pub until_unix: i64,
}

/// Rate-limit exclusions stay short: the proven cooldown ceiling.
const RATE_LIMIT_BAN_CAP: Duration = Duration::from_secs(300);

impl FailureClass {
    /// Short stable label for the history attempt column; the router's
    /// own classification, never re-parsed from the message.
    pub fn as_str(&self) -> &'static str {
        match self {
            FailureClass::QuotaExhausted { .. } => "quota_exhausted",
            FailureClass::RateLimited { .. } => "rate_limited",
            FailureClass::InvalidBackend => "invalid_backend",
            FailureClass::Transient => "transient",
            FailureClass::InvalidRequest => "invalid_request",
            FailureClass::UpstreamBadRequest => "upstream_bad_request",
            FailureClass::Unknown => "unknown",
        }
    }

    /// Only a recognized transient failure of the pinned model is retried;
    /// the same failure on the initial selection goes to the next member.
    pub fn retry_same_model(&self) -> bool {
        matches!(self, FailureClass::Transient)
    }

    /// Whether the request continues with the next member of the pool.
    /// A malformed request is the request's problem, and a cancelled
    /// request has nobody to answer to.
    pub fn continues_with_next_member(&self) -> bool {
        !matches!(self, FailureClass::InvalidRequest)
    }

    /// The ban this failure justifies, with its deadline. `now_unix` and the
    /// policy come from the caller; durations come from the config. Defaults
    /// are 3600 s for a model ban and 30 s for a rate limit.
    pub fn model_ban(&self, policy: &BanPolicy, now_unix: i64) -> Option<ModelBan> {
        match self {
            FailureClass::QuotaExhausted { reset_at_unix } => {
                // A known future reset replaces the configured duration; a
                // past or unknown one falls back to it.
                let until = reset_at_unix
                    .filter(|reset| *reset > now_unix)
                    .unwrap_or(now_unix + policy.model_ban.as_secs() as i64);
                Some(ModelBan {
                    reason: "quota_exhausted",
                    until_unix: until,
                })
            }
            FailureClass::RateLimited { retry_after_unix } => {
                // A validated Retry-After wins while it stays under the cap.
                let default_until = now_unix + policy.rate_limit_ban.as_secs() as i64;
                let cap_until = now_unix + RATE_LIMIT_BAN_CAP.as_secs() as i64;
                let until = retry_after_unix
                    .filter(|at| *at > now_unix && *at <= cap_until)
                    .unwrap_or(default_until);
                Some(ModelBan {
                    reason: "rate_limited",
                    until_unix: until,
                })
            }
            FailureClass::InvalidBackend => Some(ModelBan {
                reason: "backend_invalid",
                until_unix: now_unix + policy.model_ban.as_secs() as i64,
            }),
            FailureClass::Transient
            | FailureClass::InvalidRequest
            | FailureClass::UpstreamBadRequest
            | FailureClass::Unknown => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> BanPolicy {
        BanPolicy {
            model_ban: Duration::from_secs(3_600),
            rate_limit_ban: Duration::from_secs(30),
        }
    }

    const NOW: i64 = 10_000;

    #[test]
    fn only_transient_failures_retry_the_pinned_model() {
        let classes = [
            FailureClass::QuotaExhausted {
                reset_at_unix: None,
            },
            FailureClass::RateLimited {
                retry_after_unix: None,
            },
            FailureClass::InvalidBackend,
            FailureClass::Transient,
            FailureClass::InvalidRequest,
            FailureClass::Unknown,
        ];
        for class in classes {
            assert_eq!(
                class.retry_same_model(),
                class == FailureClass::Transient,
                "retry decision for {class:?}"
            );
        }
    }

    #[test]
    fn an_upstream_bad_request_switches_without_retry_or_ban() {
        let class = FailureClass::UpstreamBadRequest;
        assert!(class.continues_with_next_member());
        assert!(!class.retry_same_model());
        assert_eq!(class.model_ban(&policy(), NOW), None);
    }

    #[test]
    fn only_client_side_failures_stop_the_fallback_loop() {
        assert!(!FailureClass::InvalidRequest.continues_with_next_member());
        for class in [
            FailureClass::QuotaExhausted {
                reset_at_unix: None,
            },
            FailureClass::RateLimited {
                retry_after_unix: None,
            },
            FailureClass::InvalidBackend,
            FailureClass::Transient,
            FailureClass::Unknown,
        ] {
            assert!(class.continues_with_next_member(), "{class:?}");
        }
    }

    #[test]
    fn quota_ban_uses_a_future_reset_and_falls_back_to_the_configured_duration() {
        let known = FailureClass::QuotaExhausted {
            reset_at_unix: Some(NOW + 500),
        };
        assert_eq!(
            known.model_ban(&policy(), NOW).unwrap().until_unix,
            NOW + 500
        );

        let past = FailureClass::QuotaExhausted {
            reset_at_unix: Some(NOW - 1),
        };
        assert_eq!(
            past.model_ban(&policy(), NOW).unwrap().until_unix,
            NOW + 3_600
        );

        let unknown = FailureClass::QuotaExhausted {
            reset_at_unix: None,
        };
        assert_eq!(
            unknown.model_ban(&policy(), NOW).unwrap().until_unix,
            NOW + 3_600
        );
    }

    #[test]
    fn rate_limit_ban_honors_a_capped_retry_after() {
        let within = FailureClass::RateLimited {
            retry_after_unix: Some(NOW + 60),
        };
        assert_eq!(
            within.model_ban(&policy(), NOW).unwrap().until_unix,
            NOW + 60
        );

        // Beyond the cap: fall back to the configured short ban.
        let beyond = FailureClass::RateLimited {
            retry_after_unix: Some(NOW + 3_600),
        };
        assert_eq!(
            beyond.model_ban(&policy(), NOW).unwrap().until_unix,
            NOW + 30
        );

        let past = FailureClass::RateLimited {
            retry_after_unix: Some(NOW - 5),
        };
        assert_eq!(past.model_ban(&policy(), NOW).unwrap().until_unix, NOW + 30);

        let none = FailureClass::RateLimited {
            retry_after_unix: None,
        };
        assert_eq!(none.model_ban(&policy(), NOW).unwrap().until_unix, NOW + 30);
    }

    #[test]
    fn invalid_backend_gets_the_model_ban_duration() {
        let ban = FailureClass::InvalidBackend
            .model_ban(&policy(), NOW)
            .unwrap();
        assert_eq!(ban.reason, "backend_invalid");
        assert_eq!(ban.until_unix, NOW + 3_600);
    }

    #[test]
    fn transient_request_and_cancel_failures_never_ban() {
        for class in [
            FailureClass::Transient,
            FailureClass::InvalidRequest,
            FailureClass::Unknown,
        ] {
            assert_eq!(class.model_ban(&policy(), NOW), None, "{class:?}");
        }
    }
}
