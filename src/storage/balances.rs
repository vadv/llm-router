// Append-only history of balance and subscription observations.
// One row per reported indicator. NULL means unknown:
// an indicator the upstream did not report is never a zero.

use std::sync::Mutex;

use rusqlite::Connection;

use crate::storage::StorageError;

/// One observation as a driver reported it. Amounts are kept verbatim
/// strings: the upstream's own representation, no re-typed number and no
/// invented precision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub provider_id: String,
    /// What the indicator describes, e.g. "coding-plan" or "api-credits".
    pub resource: String,
    /// The kind of indicator, e.g. "money", "tokens", "credits".
    pub metric: String,
    /// Currency or unit, e.g. "USD", "token"; None if not reported.
    pub unit: Option<String>,
    pub limit: Option<String>,
    pub usage: Option<String>,
    pub remaining: Option<String>,
    /// Usage window as reported, e.g. "5h", "weekly".
    pub window: Option<String>,
    pub resets_at_unix: Option<i64>,
    pub observed_at_unix: i64,
}

/// Identifies the indicator line inside one connection: the same
/// resource/metric/window from the same provider is one row series.
type SeriesKey = (String, String, String, Option<String>, Option<String>);

fn series_key(o: &Observation) -> SeriesKey {
    (
        o.provider_id.clone(),
        o.resource.clone(),
        o.metric.clone(),
        o.unit.clone(),
        o.window.clone(),
    )
}

/// The stable display order of latest observations across providers.
fn display_order(o: &Observation) -> (&str, &str, &str, Option<&str>, Option<&str>) {
    (
        o.provider_id.as_str(),
        o.resource.as_str(),
        o.metric.as_str(),
        o.window.as_deref(),
        o.unit.as_deref(),
    )
}

/// Which series a history read wants. Every `None` means "no restriction".
/// An empty `window` selects the series that report no window at all, so an
/// all-time balance stays reachable. `unit` belongs to the series identity:
/// one connection can report the same balance in two currencies.
#[derive(Debug, Default, Clone, Copy)]
pub struct HistoryFilter<'a> {
    pub provider_id: Option<&'a str>,
    pub resource: Option<&'a str>,
    pub metric: Option<&'a str>,
    pub window: Option<&'a str>,
    pub unit: Option<&'a str>,
    pub since_unix: Option<i64>,
    pub to_unix: Option<i64>,
}

pub struct BalanceStore {
    conn: Mutex<Connection>,
}

impl BalanceStore {
    /// Takes ownership of a balances database connection and ensures the schema.
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS balance_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                provider_id TEXT NOT NULL,
                resource     TEXT NOT NULL,
                metric       TEXT NOT NULL,
                unit         TEXT,
                amount_limit   TEXT,
                amount_usage   TEXT,
                amount_remaining TEXT,
                window       TEXT,
                resets_at_unix INTEGER,
                observed_at_unix INTEGER NOT NULL
            )",
            [],
        )
        .map_err(|e| StorageError(format!("create balance_observations: {e}")))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_balance_provider_time
                ON balance_observations(provider_id, observed_at_unix)",
            [],
        )
        .map_err(|e| StorageError(format!("create idx_balance_provider_time: {e}")))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_balance_time
                ON balance_observations(observed_at_unix)",
            [],
        )
        .map_err(|e| StorageError(format!("create idx_balance_time: {e}")))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Append one observation. The history is never rewritten.
    pub fn append(&self, observation: &Observation) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        let changed = conn
            .execute(
                "INSERT INTO balance_observations
                 (provider_id, resource, metric, unit,
                  amount_limit, amount_usage, amount_remaining,
                  window, resets_at_unix, observed_at_unix)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    observation.provider_id,
                    observation.resource,
                    observation.metric,
                    observation.unit,
                    observation.limit,
                    observation.usage,
                    observation.remaining,
                    observation.window,
                    observation.resets_at_unix,
                    observation.observed_at_unix,
                ],
            )
            .map_err(|e| StorageError(format!("insert observation: {e}")))?;
        if changed != 1 {
            return Err(StorageError("insert observation wrote no row".into()));
        }
        Ok(())
    }

    /// The most recent observation of each indicator of every connection
    /// (`None`) or of one connection. An empty history is an empty list,
    /// not a zero balance. The order is stable:
    /// (provider_id, resource, metric, window, unit).
    pub fn latest(&self, provider_id: Option<&str>) -> Result<Vec<Observation>, StorageError> {
        let mut latest: std::collections::HashMap<SeriesKey, Observation> =
            std::collections::HashMap::new();
        let filter = HistoryFilter {
            provider_id,
            ..HistoryFilter::default()
        };
        for row in self.history(&filter, i64::MAX)? {
            // history() yields oldest first; the last row of each series
            // is the newest.
            latest.insert(series_key(&row), row);
        }
        let mut out: Vec<Observation> = latest.into_values().collect();
        out.sort_by(|a, b| display_order(a).cmp(&display_order(b)));
        Ok(out)
    }

    /// Trivial query for health checks.
    pub fn ping(&self) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }

    /// The most recent points of the selected series, oldest first, for
    /// charts. The filter narrows the series before `limit` cuts them, so a
    /// chart of one window is not crowded out by the other windows of the
    /// same connection. `limit` is already bounded by the handler.
    pub fn history(
        &self,
        filter: &HistoryFilter<'_>,
        limit: i64,
    ) -> Result<Vec<Observation>, StorageError> {
        let conn = self.conn.lock().unwrap();
        // Inner: newest N of the selected series; outer: ascending for the
        // timeline.
        let mut stmt = conn
            .prepare(
                "SELECT provider_id, resource, metric, unit,
                        amount_limit, amount_usage, amount_remaining,
                        window, resets_at_unix, observed_at_unix
                 FROM (SELECT * FROM balance_observations
                       WHERE (?1 IS NULL OR provider_id = ?1)
                         AND (?2 IS NULL OR resource = ?2)
                         AND (?3 IS NULL OR metric = ?3)
                         AND (?4 IS NULL OR window IS NULLIF(?4, ''))
                         AND (?5 IS NULL OR unit IS NULLIF(?5, ''))
                         AND observed_at_unix >= ?6 AND observed_at_unix < ?8
                       ORDER BY observed_at_unix DESC, id DESC LIMIT ?7)
                 ORDER BY observed_at_unix ASC, id ASC",
            )
            .map_err(|e| StorageError(format!("select observations: {e}")))?;
        let rows = stmt
            .query_map(
                rusqlite::params![
                    filter.provider_id,
                    filter.resource,
                    filter.metric,
                    filter.window,
                    filter.unit,
                    filter.since_unix.unwrap_or(0),
                    limit,
                    filter.to_unix.unwrap_or(i64::MAX)
                ],
                |row| {
                    Ok(Observation {
                        provider_id: row.get(0)?,
                        resource: row.get(1)?,
                        metric: row.get(2)?,
                        unit: row.get(3)?,
                        limit: row.get(4)?,
                        usage: row.get(5)?,
                        remaining: row.get(6)?,
                        window: row.get(7)?,
                        resets_at_unix: row.get(8)?,
                        observed_at_unix: row.get(9)?,
                    })
                },
            )
            .map_err(|e| StorageError(format!("select observations: {e}")))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| StorageError(format!("read observation: {e}")))?);
        }
        Ok(out)
    }

    /// Retention: delete observations older than the cutoff. Returns the
    /// number of removed rows. Old rows can not be part of any latest
    /// view — `latest` keeps the newest point of every series.
    pub fn purge_older_than(&self, cutoff_unix: i64) -> Result<u64, StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM balance_observations WHERE observed_at_unix < ?1",
            [cutoff_unix],
        )
        .map(|n| n as u64)
        .map_err(|e| StorageError(format!("purge observations: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> BalanceStore {
        BalanceStore::new(rusqlite::Connection::open_in_memory().unwrap()).unwrap()
    }

    fn observation(metric: &str, usage: Option<&str>, observed_at_unix: i64) -> Observation {
        Observation {
            provider_id: "zai".into(),
            resource: "coding-plan".into(),
            metric: metric.into(),
            unit: None,
            limit: None,
            usage: usage.map(str::to_owned),
            remaining: None,
            window: None,
            resets_at_unix: None,
            observed_at_unix,
        }
    }

    #[test]
    fn latest_returns_the_most_recent_row_per_indicator() {
        let store = store();
        store
            .append(&observation("credits", Some("10"), 100))
            .unwrap();
        store
            .append(&observation("credits", Some("4"), 200))
            .unwrap();
        store.append(&observation("tokens", None, 150)).unwrap();

        let latest = store.latest(Some("zai")).unwrap();
        assert_eq!(latest.len(), 2);
        let credits = latest.iter().find(|o| o.metric == "credits").unwrap();
        assert_eq!(credits.usage.as_deref(), Some("4"));
        assert_eq!(credits.observed_at_unix, 200);
    }

    #[test]
    fn unreported_amounts_stay_unknown_not_zero() {
        let store = store();
        store.append(&observation("money", None, 100)).unwrap();

        let latest = store.latest(Some("zai")).unwrap();
        assert_eq!(latest.len(), 1);
        let money = &latest[0];
        assert_eq!(money.usage, None);
        assert_eq!(money.limit, None);
        assert_eq!(money.remaining, None);
    }

    #[test]
    fn history_is_oldest_first_and_bounded() {
        let store = store();
        for at in [10, 20, 30] {
            store
                .append(&observation("credits", Some("1"), at))
                .unwrap();
        }

        let only_zai = HistoryFilter {
            provider_id: Some("zai"),
            ..HistoryFilter::default()
        };
        let history = store.history(&only_zai, 2).unwrap();
        assert_eq!(
            history
                .iter()
                .map(|o| o.observed_at_unix)
                .collect::<Vec<_>>(),
            [20, 30]
        );
        let since = store
            .history(
                &HistoryFilter {
                    since_unix: Some(20),
                    ..only_zai
                },
                10,
            )
            .unwrap();
        assert_eq!(
            since.iter().map(|o| o.observed_at_unix).collect::<Vec<_>>(),
            [20, 30]
        );
        let since_now = store
            .history(
                &HistoryFilter {
                    since_unix: Some(31),
                    ..only_zai
                },
                10,
            )
            .unwrap();
        assert!(since_now.is_empty());
    }

    #[test]
    fn history_selects_one_series_before_the_limit_cuts_it() {
        let store = store();
        // Two windows of one connection, interleaved. A chart of the 5h
        // window must not be crowded out by the newer daily points.
        for at in [10, 20, 30] {
            let mut five_hour = observation("tokens", Some("5"), at);
            five_hour.window = Some("5h".into());
            store.append(&five_hour).unwrap();
            let mut daily = observation("tokens", Some("9"), at + 1);
            daily.window = Some("24h".into());
            store.append(&daily).unwrap();
        }

        let five_hours = HistoryFilter {
            provider_id: Some("zai"),
            resource: Some("coding-plan"),
            metric: Some("tokens"),
            window: Some("5h"),
            ..HistoryFilter::default()
        };
        let points = store.history(&five_hours, 3).unwrap();
        assert_eq!(
            points
                .iter()
                .map(|o| o.observed_at_unix)
                .collect::<Vec<_>>(),
            [10, 20, 30]
        );
        assert!(points.iter().all(|o| o.window.as_deref() == Some("5h")));

        // An empty window selects the series that report no window at all.
        let all_time = observation("credits", Some("1"), 40);
        store.append(&all_time).unwrap();
        let account = HistoryFilter {
            provider_id: Some("zai"),
            metric: Some("credits"),
            window: Some(""),
            ..HistoryFilter::default()
        };
        let credits = store.history(&account, 10).unwrap();
        assert_eq!(credits.len(), 1);
        assert_eq!(credits[0].observed_at_unix, 40);

        // An unknown series is empty, not a silent fallback to everything.
        let unknown = HistoryFilter {
            window: Some("1h"),
            ..account
        };
        assert!(store.history(&unknown, 10).unwrap().is_empty());
    }

    #[test]
    fn history_keeps_two_currencies_of_one_balance_apart() {
        let store = store();
        // One connection reports its account in CNY and in USD: same
        // resource, metric and window, different unit.
        for (unit, amount) in [("CNY", "419"), ("USD", "9")] {
            let mut row = observation("money", Some(amount), 100);
            row.resource = "account".into();
            row.unit = Some(unit.into());
            store.append(&row).unwrap();
        }

        let usd = HistoryFilter {
            provider_id: Some("zai"),
            resource: Some("account"),
            metric: Some("money"),
            window: Some(""),
            unit: Some("USD"),
            ..HistoryFilter::default()
        };
        let points = store.history(&usd, 10).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].usage.as_deref(), Some("9"));

        // Without the unit both currencies land in one series.
        let mixed = HistoryFilter { unit: None, ..usd };
        assert_eq!(store.history(&mixed, 10).unwrap().len(), 2);
    }

    #[test]
    fn observations_of_other_connections_are_invisible() {
        let store = store();
        store
            .append(&observation("credits", Some("1"), 100))
            .unwrap();

        assert!(store.latest(Some("other")).unwrap().is_empty());
        let other = HistoryFilter {
            provider_id: Some("other"),
            ..HistoryFilter::default()
        };
        assert!(store.history(&other, 10).unwrap().is_empty());
    }

    #[test]
    fn latest_without_provider_covers_every_connection_in_a_stable_order() {
        let store = store();
        // Inserted out of order: the answer must not depend on it.
        let zai = observation("credits", Some("1"), 100);
        let mut deepseek = observation("credits", Some("2"), 100);
        deepseek.provider_id = "deepseek".into();
        deepseek.resource = "api-credits".into();
        let mut openrouter = observation("money", Some("3"), 100);
        openrouter.provider_id = "openrouter".into();
        openrouter.resource = "key".into();
        for o in [&zai, &deepseek, &openrouter] {
            store.append(o).unwrap();
        }

        let latest = store.latest(None).unwrap();
        assert_eq!(
            latest
                .iter()
                .map(|o| o.provider_id.as_str())
                .collect::<Vec<_>>(),
            ["deepseek", "openrouter", "zai"]
        );
        // Same series of different providers stay separate rows.
        let mut again = observation("credits", Some("9"), 200);
        again.provider_id = "deepseek".into();
        again.resource = "api-credits".into();
        store.append(&again).unwrap();
        let latest = store.latest(None).unwrap();
        assert_eq!(latest.len(), 3);
        let deepseek = latest.iter().find(|o| o.provider_id == "deepseek").unwrap();
        assert_eq!(deepseek.usage.as_deref(), Some("9"));
    }

    #[test]
    fn purge_removes_old_observations_and_keeps_recent_ones() {
        let store = store();
        store
            .append(&observation("credits", Some("1"), 100))
            .unwrap();
        store
            .append(&observation("credits", Some("2"), 300))
            .unwrap();

        let removed = store.purge_older_than(200).unwrap();
        assert_eq!(removed, 1);
        let latest = store.latest(None).unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].observed_at_unix, 300);
        // A second sweep is a no-op, not an error.
        assert_eq!(store.purge_older_than(200).unwrap(), 0);
    }

    #[test]
    fn equal_timestamps_are_ordered_by_row_order() {
        let store = store();
        store
            .append(&observation("credits", Some("1"), 100))
            .unwrap();
        store
            .append(&observation("credits", Some("2"), 100))
            .unwrap();

        let latest = store.latest(Some("zai")).unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].usage.as_deref(), Some("2"));
    }

    #[test]
    fn windows_separate_indicator_series() {
        let store = store();
        let mut five_hour = observation("tokens", Some("100"), 100);
        five_hour.window = Some("5h".into());
        let mut weekly = observation("tokens", Some("1000"), 100);
        weekly.window = Some("weekly".into());
        store.append(&five_hour).unwrap();
        store.append(&weekly).unwrap();

        assert_eq!(store.latest(Some("zai")).unwrap().len(), 2);
    }
}
