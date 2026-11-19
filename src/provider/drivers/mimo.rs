// Xiaomi MiMo Token Plan driver: OpenAI-compatible Chat Completions with a
// dynamic catalog plus the plan's documented credits endpoint
// GET {base}/platform/token_plan (Bearer tp- key), so the subscription
// balance is provider-reported, not guessed.

use crate::config::HttpTimeouts;
use crate::provider::driver::{
    BoxFuture, CatalogMode, DiscoveredModel, Driver, Indicator, InferenceRequest, LocalState,
    UpstreamResponse,
};
use crate::provider::drivers::openai::{
    AuthKind, ChatCompletionsTransport, TransportFailure, parse_openai_models,
};
use crate::routing::classify::{DriverError, FailureClass};
use serde_json::Value;

/// Reason string cap for history: enough to diagnose, never a body dump.
const MESSAGE_LIMIT: usize = 200;

pub struct MimoDriver {
    transport: ChatCompletionsTransport,
}

impl MimoDriver {
    pub fn new(base_url: &str, api_key: &str, timeouts: HttpTimeouts) -> Self {
        MimoDriver {
            transport: ChatCompletionsTransport::new(base_url, Some(api_key), timeouts),
        }
    }
}

impl Driver for MimoDriver {
    fn catalog_mode(&self) -> CatalogMode {
        CatalogMode::Dynamic
    }

    fn fetch_catalog(&self) -> BoxFuture<'_, Result<Vec<DiscoveredModel>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_models()
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            parse_openai_models(&value).map_err(|reason| DriverError {
                class: FailureClass::Transient,
                message: format!("mimo catalog: {reason}"),
            })
        })
    }

    fn fetch_observations(&self) -> BoxFuture<'_, Result<Option<Vec<Indicator>>, DriverError>> {
        Box::pin(async {
            let value = self
                .transport
                .get_json(
                    &format!("{}/platform/token_plan", self.transport.base_url),
                    self.transport.timeouts.catalog,
                    AuthKind::Bearer,
                )
                .await
                .map_err(|failure| classify(failure, now_unix()))?;
            parse_token_plan(&value)
                .map(Some)
                .map_err(|reason| DriverError {
                    class: FailureClass::Transient,
                    message: format!("mimo token_plan: {reason}"),
                })
        })
    }

    fn fetch_local_state(&self) -> BoxFuture<'_, Result<Option<LocalState>, DriverError>> {
        Box::pin(async { Ok(None) })
    }

    fn execute<'a>(
        &'a self,
        model: &'a str,
        request: &'a InferenceRequest,
    ) -> BoxFuture<'a, Result<UpstreamResponse, DriverError>> {
        Box::pin(async {
            self.transport
                .execute(model, request)
                .await
                .map_err(|failure| classify(failure, now_unix()))
        })
    }
}

/// The plan reports integer credits for the current billing period; the
/// amounts stay verbatim strings, no invented precision.
fn parse_token_plan(value: &Value) -> Result<Vec<Indicator>, String> {
    let quota = value
        .get("quota")
        .ok_or_else(|| "no quota object".to_string())?;
    let credits = |field: &str| {
        quota
            .get(field)
            .and_then(Value::as_i64)
            .map(|amount| amount.to_string())
    };
    if credits("remaining_credits").is_none() && credits("total_credits").is_none() {
        return Err("quota has no credits fields".to_string());
    }
    Ok(vec![Indicator {
        resource: "token_plan".into(),
        metric: "credits".into(),
        unit: None,
        limit: credits("total_credits"),
        usage: credits("used_credits"),
        remaining: credits("remaining_credits"),
        window: Some("period".into()),
        resets_at_unix: None,
    }])
}

/// Plan error meaning by status: 402 keeps the OpenAI money meaning,
/// 429 is short-lived pressure.
fn classify(failure: TransportFailure, now_unix: i64) -> DriverError {
    let class = match &failure {
        TransportFailure::MalformedBody => FailureClass::InvalidRequest,
        TransportFailure::Network(_)
        | TransportFailure::FirstByteTimeout
        | TransportFailure::AttemptTimeout => FailureClass::Transient,
        TransportFailure::Http {
            status,
            retry_after,
            ..
        } => match status.as_u16() {
            402 => FailureClass::QuotaExhausted {
                reset_at_unix: None,
            },
            401 | 403 => FailureClass::InvalidBackend,
            400 => FailureClass::UpstreamBadRequest,
            404 | 413 | 422 => FailureClass::InvalidRequest,
            429 => rate_limited(retry_after.as_deref(), now_unix),
            500..=599 => FailureClass::Transient,
            _ => FailureClass::Unknown,
        },
    };
    let message = match &failure {
        TransportFailure::Http { status, body, .. } => {
            format!(
                "mimo upstream {}: {}",
                status.as_u16(),
                super::error_excerpt(body, MESSAGE_LIMIT)
            )
        }
        TransportFailure::MalformedBody => "request body is not a JSON object".into(),
        TransportFailure::Network(err) => format!("mimo network: {err}"),
        TransportFailure::FirstByteTimeout => "mimo first byte timeout".into(),
        TransportFailure::AttemptTimeout => "mimo attempt budget exhausted".into(),
    };
    DriverError { class, message }
}

fn rate_limited(retry_after: Option<&str>, now_unix: i64) -> FailureClass {
    let retry_after_unix = retry_after
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|secs| *secs > 0)
        .map(|secs| now_unix + secs);
    FailureClass::RateLimited { retry_after_unix }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn driver(server: &MockServer) -> MimoDriver {
        MimoDriver::new(&format!("{}/v1", server.uri()), "tp-test", timeouts())
    }

    fn timeouts() -> HttpTimeouts {
        HttpTimeouts {
            connect: std::time::Duration::from_secs(5),
            first_byte: std::time::Duration::from_secs(5),
            total_attempt: std::time::Duration::from_secs(10),
            catalog: std::time::Duration::from_secs(5),
            catalog_connect: std::time::Duration::from_secs(5),
            local_state: std::time::Duration::from_secs(2),
        }
    }

    #[test]
    fn parse_token_plan_reads_period_credits() {
        let indicators = parse_token_plan(&json!({"object": "token_plan", "quota": {
            "total_credits": 10_000_000,
            "used_credits": 1_500_000,
            "remaining_credits": 8_500_000
        }}))
        .unwrap();
        assert_eq!(indicators.len(), 1);
        assert_eq!(indicators[0].resource, "token_plan");
        assert_eq!(indicators[0].metric, "credits");
        assert_eq!(indicators[0].limit.as_deref(), Some("10000000"));
        assert_eq!(indicators[0].usage.as_deref(), Some("1500000"));
        assert_eq!(indicators[0].remaining.as_deref(), Some("8500000"));
    }

    #[test]
    fn parse_token_plan_rejects_body_without_quota() {
        assert!(parse_token_plan(&json!({"object": "token_plan"})).is_err());
        assert!(parse_token_plan(&json!({"quota": {}})).is_err());
    }

    #[tokio::test]
    async fn fetch_observations_reads_plan_credits_with_bearer_auth() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/platform/token_plan"))
            .and(header("Authorization", "Bearer tp-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "object": "token_plan",
                "quota": {
                    "total_credits": 10_000_000,
                    "used_credits": 1_500_000,
                    "remaining_credits": 8_500_000
                }
            })))
            .mount(&server)
            .await;

        let indicators = driver(&server).fetch_observations().await.unwrap().unwrap();
        assert_eq!(indicators.len(), 1);
        assert_eq!(indicators[0].remaining.as_deref(), Some("8500000"));
    }
}
