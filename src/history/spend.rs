// Statistical spend attribution (provider-usage-attribution §7).
// A pure calibration over one observation series: how much of a
// subscription resource was observably spent between two balance
// snapshots, matched against the tokens the same provider burned.
//
// This is an estimate, never a bill: the windows are moments when the
// proxy happened to look, not the provider's billing periods.

use crate::storage::balances::Observation;

/// What the calibration can say about one series.
#[derive(Debug, Clone, PartialEq)]
pub struct SpendEstimate {
    /// 1000 × sum(C) / sum(T) in the series' own unit. None when no
    /// interval produced an observable spend or no tokens were recorded.
    pub per_1000: Option<f64>,
    /// The series unit, kept verbatim ("USD", "credit", "token").
    pub unit: Option<String>,
    /// Intervals whose spend entered the calibration.
    pub intervals: usize,
    /// Observable spend C summed over usable intervals.
    pub spent: f64,
    /// Tokens T summed over the same intervals.
    pub tokens: u64,
}

fn parse(value: &Option<String>) -> Option<f64> {
    value.as_deref().and_then(|text| text.parse::<f64>().ok())
}

/// How one series reports spend, decided from the fields the driver
/// actually filled (§7.3: extracting meaning stays close to the data).
/// `remaining` wins when both fields exist (tokenator writes both):
/// a top-up grows both, and only the remaining rule drops the interval
/// instead of booking the top-up as spend. The counter path stays for
/// series that report usage alone.
enum SeriesKind {
    /// `remaining` shrinks as the resource is spent; a growth reading
    /// (top-up, refund, reset) contributes nothing for its interval.
    Remaining,
    /// `usage` accumulates; a drop means the counter was reset and that
    /// interval contributes nothing either.
    UsageCounter,
    /// No comparable field: no estimate.
    Unusable,
}

fn classify_series(series: &[Observation]) -> SeriesKind {
    if series.iter().any(|o| parse(&o.remaining).is_some()) {
        SeriesKind::Remaining
    } else if series.iter().any(|o| parse(&o.usage).is_some()) {
        SeriesKind::UsageCounter
    } else {
        SeriesKind::Unusable
    }
}

/// Observable spend between two adjacent readings, or None when the pair
/// carries no spend: a growth/reset crossing, or a missing value (an
/// unknown is never compared as zero).
fn pair_spend(kind: &SeriesKind, before: Option<f64>, now: Option<f64>) -> Option<f64> {
    let (before, now) = (before?, now?);
    match kind {
        SeriesKind::Remaining => (now < before).then_some(before - now),
        SeriesKind::UsageCounter => (now >= before).then_some(now - before),
        SeriesKind::Unusable => None,
    }
}

/// Calibrate one series. Observations must already be one series (same
/// provider/resource/metric/unit/window) in chronological order;
/// `BalanceStore::history` returns them that way. `tokens_between`
/// supplies known attempt tokens for the provider in the half-open
/// interval between two readings; `None` means unknown — the interval
/// then joins no calibration: its spend is not divided against a
/// partial token sample (spec §7.3).
pub fn calibrate<F>(series: &[Observation], mut tokens_between: F) -> SpendEstimate
where
    F: FnMut(&str, i64, i64) -> Option<u64>,
{
    let kind = classify_series(series);
    let mut out = SpendEstimate {
        per_1000: None,
        unit: series.first().and_then(|o| o.unit.clone()),
        intervals: 0,
        spent: 0.0,
        tokens: 0,
    };
    if series.len() < 2 {
        return out;
    }
    let provider = series[0].provider_id.as_str();
    for pair in series.windows(2) {
        let (prev, current) = (&pair[0], &pair[1]);
        let field = |o: &Observation| match kind {
            SeriesKind::Remaining => parse(&o.remaining),
            _ => parse(&o.usage),
        };
        if let Some(spend) = pair_spend(&kind, field(prev), field(current))
            && let Some(tokens) =
                tokens_between(provider, prev.observed_at_unix, current.observed_at_unix)
        {
            out.spent += spend;
            out.tokens += tokens;
            out.intervals += 1;
        }
    }
    if out.tokens > 0 {
        out.per_1000 = Some(1000.0 * out.spent / out.tokens as f64);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(remaining: Option<&str>, usage: Option<&str>, at: i64) -> Observation {
        Observation {
            provider_id: "p".into(),
            resource: "coding-plan".into(),
            metric: "credits".into(),
            unit: Some("credit".into()),
            limit: None,
            usage: usage.map(str::to_owned),
            remaining: remaining.map(str::to_owned),
            window: Some("5h".into()),
            resets_at_unix: None,
            observed_at_unix: at,
        }
    }

    fn no_tokens(_: &str, _: i64, _: i64) -> Option<u64> {
        Some(0)
    }

    #[test]
    fn the_pinning_example_from_the_spec() {
        // 100 → 90 → 120 → 110: spend 10 and 10; the growth crossing
        // contributes nothing (spec §7.3).
        let series = [
            obs(Some("100"), None, 1_000),
            obs(Some("90"), None, 2_000),
            obs(Some("120"), None, 3_000),
            obs(Some("110"), None, 4_000),
        ];
        let estimate = calibrate(&series, |_, _, _| Some(50_000));
        assert_eq!(estimate.intervals, 2);
        assert_eq!(estimate.spent, 20.0);
        assert_eq!(estimate.tokens, 100_000);
        assert_eq!(estimate.per_1000, Some(0.2));
    }

    #[test]
    fn a_growth_interval_excludes_its_tokens_from_t() {
        let series = [
            obs(Some("100"), None, 1_000),
            obs(Some("90"), None, 2_000),
            obs(Some("150"), None, 3_000),
        ];
        let estimate = calibrate(&series, |_, from, _| {
            (from != 2_000).then_some(10_000).or(Some(999_999))
        });
        // Only the 100→90 pair is usable; the top-up interval's tokens
        // must not enter the denominator.
        assert_eq!(estimate.tokens, 10_000);
    }

    #[test]
    fn a_usage_counter_spends_by_growth_and_ignores_a_reset() {
        let series = [
            obs(None, Some("0"), 1_000),
            obs(None, Some("40"), 2_000),
            obs(None, Some("70"), 3_000),
            obs(None, Some("10"), 4_000), // counter reset
            obs(None, Some("30"), 5_000),
        ];
        let estimate = calibrate(&series, |_, from, _| {
            (from == 1_000 || from == 4_000)
                .then_some(1_000)
                // zero tokens are known tokens, not unknown ones
                .or(Some(0))
        });
        assert_eq!(estimate.intervals, 3);
        assert_eq!(estimate.spent, 90.0);
    }

    #[test]
    fn zero_tokens_or_one_snapshot_means_no_estimate() {
        let one = [obs(Some("100"), None, 1_000)];
        assert_eq!(calibrate(&one, no_tokens).per_1000, None);

        let two = [obs(Some("100"), None, 1_000), obs(Some("90"), None, 2_000)];
        let estimate = calibrate(&two, no_tokens);
        assert_eq!(estimate.per_1000, None);
        assert_eq!(estimate.spent, 10.0); // spend stays visible
    }

    #[test]
    fn unknown_values_never_become_zero() {
        // A NULL remaining in the middle must not read as a free window.
        let series = [
            obs(Some("100"), None, 1_000),
            obs(None, None, 2_000),
            obs(Some("95"), None, 3_000),
        ];
        let estimate = calibrate(&series, |_, from, _| (from == 2_000).then_some(999_999));
        // Both pairs involve the NULL reading: nothing is comparable.
        assert_eq!(estimate.intervals, 0);
        assert_eq!(estimate.per_1000, None);
    }

    #[test]
    fn unknown_tokens_drop_the_interval_from_both_c_and_t() {
        // A storage failure must not read as free tokens: the interval
        // joins neither the spend nor the denominator (spec §7.3).
        let series = [
            obs(Some("100"), None, 1_000),
            obs(Some("90"), None, 2_000),
            obs(Some("80"), None, 3_000),
        ];
        let estimate = calibrate(&series, |_, from, _| (from != 1_000).then_some(10_000));
        assert_eq!(estimate.intervals, 1);
        assert_eq!(estimate.spent, 10.0);
        assert_eq!(estimate.tokens, 10_000);
    }

    #[test]
    fn a_series_with_both_fields_skips_topups_by_remaining() {
        // tokenator shape: usage and remaining both present. A top-up
        // grows both; the remaining rule drops the whole interval
        // instead of booking the usage growth as spend.
        let series = [
            obs(Some("1000"), Some("0"), 1_000),
            obs(Some("900"), Some("100"), 2_000),
            obs(Some("1500"), Some("700"), 3_000), // top-up: skip
            obs(Some("1400"), Some("800"), 4_000),
        ];
        let estimate = calibrate(&series, |_, _, _| Some(1_000));
        assert_eq!(estimate.intervals, 2);
        assert_eq!(estimate.spent, 200.0);
    }
}
