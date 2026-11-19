// Compact request history (requests.sqlite, new schema per
// docs/history-storage-spec.md §5). A COMPLETED request summary is
// inserted atomically with all its attempts in one transaction — there
// are no running rows and no updates. Unknown values stay NULL, never
// zero. Previews are short by construction; full bodies are never
// stored here. Access to files stays restricted: user text is sensitive.

use rusqlite::Connection;

use super::StorageError;
use crate::history::RequestSummary;

/// Filters for the history listing (management API).
#[derive(Debug, Clone, Default)]
pub struct RequestFilter {
    pub limit: i64,
    pub since_unix: Option<i64>,
    pub to_unix: Option<i64>,
    pub metamodel: Option<String>,
    pub key_alias: Option<String>,
    pub outcome: Option<String>,
    pub before_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub family: Option<String>,
    pub attempt_window: bool,
}

#[derive(serde::Serialize, Debug)]
pub struct RequestActivity {
    pub from_unix: Option<i64>,
    pub to_unix: i64,
    pub as_of_unix: i64,
    pub step_secs: i64,
    pub buckets: Vec<RequestBucket>,
}

#[derive(serde::Serialize, Debug)]
pub struct RequestBucket {
    pub start: i64,
    pub total: i64,
    pub ok: i64,
    pub errors: i64,
    pub cancels: i64,
    pub retried: i64,
    pub peak_per_minute: i64,
    pub first_start: i64,
    pub last_start: i64,
}

type SqlParams = Vec<Box<dyn rusqlite::ToSql>>;

impl RequestFilter {
    fn selection(&self) -> (String, SqlParams) {
        let mut sql = String::from(" FROM requests WHERE 1 = 1");
        let mut params: SqlParams = Vec::new();
        if let Some(since_unix) = self.since_unix.filter(|_| !self.attempt_window) {
            params.push(Box::new(since_unix));
            sql.push_str(&format!(" AND started_at_unix >= ?{}", params.len()));
        }
        if let Some(to) = self.to_unix.filter(|_| !self.attempt_window) {
            params.push(Box::new(to));
            sql.push_str(&format!(" AND started_at_unix < ?{}", params.len()));
        }
        if let Some(metamodel) = &self.metamodel {
            params.push(Box::new(metamodel.clone()));
            sql.push_str(&format!(" AND metamodel = ?{}", params.len()));
        }
        if let Some(key_alias) = &self.key_alias {
            params.push(Box::new(key_alias.clone()));
            sql.push_str(&format!(" AND key_alias = ?{}", params.len()));
        }
        if let Some(outcome) = &self.outcome {
            params.push(Box::new(outcome.clone()));
            sql.push_str(&format!(" AND outcome = ?{}", params.len()));
        }
        // Match one attempt, but return the whole request so fallback stays visible.
        if self.provider.is_some()
            || self.model.is_some()
            || self.family.is_some()
            || self.attempt_window
        {
            sql.push_str(" AND EXISTS (SELECT 1 FROM attempts a WHERE a.request_id = requests.id");
            for (column, value) in [
                ("a.provider_id", &self.provider),
                ("a.upstream_id", &self.model),
                ("model_family(a.upstream_id)", &self.family),
            ] {
                if let Some(value) = value {
                    params.push(Box::new(value.clone()));
                    sql.push_str(&format!(" AND {column} = ?{}", params.len()));
                }
            }
            if self.attempt_window {
                for (op, bound) in [(">=", self.since_unix), ("<", self.to_unix)] {
                    if let Some(bound) = bound {
                        params.push(Box::new(bound));
                        sql.push_str(&format!(" AND a.started_at_unix {op} ?{}", params.len()));
                    }
                }
            }
            sql.push(')');
        }
        (sql, params)
    }
}

/// Spend per time bucket and group (management usage chart).
#[derive(Debug, Clone, PartialEq)]
pub enum UsageGroup {
    Provider,
    Model,
    Family,
    Metamodel,
    Key,
}

#[derive(Debug, Default, Clone)]
pub struct UsageFilter {
    pub family: Option<String>,
    pub split_provider: bool,
    pub since_unix: Option<i64>,
    pub to_unix: Option<i64>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub pool: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UsageQuery {
    pub filter: UsageFilter,
    pub bucket_seconds: i64,
    pub group_by: UsageGroup,
    pub limit: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct UsageBucket {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub bucket_unix: i64,
    pub group: String,
    #[serde(flatten)]
    pub stats: UsageStats,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct UsageStats {
    pub requests: i64,
    pub attempts: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub errors: i64,
    /// Client hangups: neither a clean success nor a provider failure.
    pub cancels: i64,
    pub unknown_tokens: i64,
    /// Sum of the cost the upstream reported. None when nobody reported it.
    pub cost: Option<f64>,
    pub cost_reports: i64,
    pub estimable_attempts: i64,
    /// Tokens from attempts with both counts but no recorded cost.
    pub unpriced_tokens: Option<i64>,
    pub ok: i64,
    pub input_reports: i64,
    pub output_reports: i64,
    pub mean_duration_ms: Option<f64>,
    pub duration_reports: i64,
    pub output_tps: Option<f64>,
    pub speed_reports: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsagePage {
    pub buckets: Vec<UsageBucket>,
    pub unpriced_by_provider: std::collections::BTreeMap<String, i64>,
    pub unpriced_providers_truncated: bool,
    pub truncated: bool,
    pub totals: UsageStats,
}

/// A stored attempt as the management API reads it back.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredHistoryAttempt {
    pub id: i64,
    pub provider_id: String,
    pub upstream_id: String,
    pub started_at_unix: i64,
    pub finished_at_unix: Option<i64>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub error_class: Option<String>,
    pub duration_ms: Option<i64>,
    pub switch_reason: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub response_preview: Option<String>,
    pub response_truncated: bool,
    pub tool_count: Option<u32>,
    pub tool_names: Vec<String>,
    pub tool_names_truncated: bool,
    pub tool_list_truncated: bool,
    pub issues: Vec<String>,
}

/// A stored completed request with its attempts.
#[derive(Debug, Clone, PartialEq)]
pub struct StoredHistoryRequest {
    pub id: String,
    pub key_alias: String,
    pub metamodel: String,
    pub started_at_unix: i64,
    pub finished_at_unix: Option<i64>,
    pub outcome: Option<String>,
    pub input_preview: Option<String>,
    pub input_truncated: bool,
    pub declared_tools: Option<u32>,
    pub issues: Vec<String>,
    pub attempts: Vec<StoredHistoryAttempt>,
}

pub struct HistoryStore {
    conn: Connection,
}

fn codes_to_json(codes: &[crate::history::ExtractIssue]) -> String {
    serde_json::to_string(&codes.iter().map(|c| c.as_str()).collect::<Vec<_>>())
        .unwrap_or_else(|_| "[]".to_string())
}

fn json_to_codes(text: Option<String>) -> Vec<String> {
    text.and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

// Keep long ranges bounded without cutting empty time off either end of the chart.
pub(crate) fn activity_step(span: i64) -> i64 {
    [60, 900, 3600, 86400, 604800]
        .into_iter()
        .find(|s| span / s < 168)
        .unwrap_or((span / 168 / 86400 + 1) * 86400)
}

impl HistoryStore {
    pub fn new(conn: Connection) -> Result<Self, StorageError> {
        use rusqlite::functions::FunctionFlags;
        conn.create_scalar_function(
            "model_family",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |ctx| Ok(crate::model::knowledge_key(ctx.get_raw(0).as_str()?)),
        )
        .map_err(|e| StorageError(format!("register model family: {e}")))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS requests (
                 id               TEXT PRIMARY KEY,
                 key_alias        TEXT NOT NULL,
                 metamodel        TEXT NOT NULL,
                 started_at_unix  INTEGER NOT NULL,
                 finished_at_unix INTEGER,
                 outcome          TEXT,
                 input_preview    TEXT,
                 input_truncated  INTEGER NOT NULL DEFAULT 0,
                 declared_tools   INTEGER,
                 issues           TEXT NOT NULL DEFAULT '[]'
             );
             CREATE TABLE IF NOT EXISTS attempts (
                 id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                 request_id          TEXT NOT NULL,
                 provider_id         TEXT NOT NULL,
                 upstream_id         TEXT NOT NULL,
                 started_at_unix     INTEGER NOT NULL,
                 finished_at_unix    INTEGER,
                 result              TEXT,
                 error               TEXT,
                 switch_reason       TEXT,
                 error_class          TEXT,
                 duration_ms          INTEGER,
                 input_tokens        INTEGER,
                 output_tokens       INTEGER,
                 cost                REAL,
                 response_preview    TEXT,
                 response_truncated  INTEGER NOT NULL DEFAULT 0,
                 tool_count          INTEGER,
                 tool_names          TEXT NOT NULL DEFAULT '[]',
                 tool_names_truncated INTEGER NOT NULL DEFAULT 0,
                 tool_list_truncated INTEGER NOT NULL DEFAULT 0,
                 issues              TEXT NOT NULL DEFAULT '[]'
             );
             CREATE INDEX IF NOT EXISTS idx_attempts_request
                 ON attempts (request_id);
             CREATE INDEX IF NOT EXISTS idx_attempts_provider_time
                 ON attempts (provider_id, finished_at_unix);
             CREATE INDEX IF NOT EXISTS idx_requests_started
                 ON requests (started_at_unix);
             PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|e| StorageError(format!("create history tables: {e}")))?;
        // Older databases predate the per-attempt timing and error-class
        // columns; a duplicate-column error only means they are there.
        let _ = conn.execute("ALTER TABLE attempts ADD COLUMN error_class TEXT", []);
        let _ = conn.execute("ALTER TABLE attempts ADD COLUMN duration_ms INTEGER", []);
        Ok(HistoryStore { conn })
    }

    /// Insert completed request summaries; one transaction covers each
    /// request AND all its attempts, so a batch failure drops whole
    /// summaries instead of half-written ones.
    pub fn insert_summaries(&mut self, batch: &[RequestSummary]) -> Result<(), StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin history batch: {e}")))?;
        for request in batch {
            tx.execute(
                "INSERT INTO requests (id, key_alias, metamodel, started_at_unix,
                     finished_at_unix, outcome, input_preview, input_truncated,
                     declared_tools, issues)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    request.id,
                    request.key_alias,
                    request.metamodel,
                    request.started_at_unix,
                    request.finished_at_unix,
                    request.outcome,
                    request.input.as_ref().map(|p| p.text.clone()),
                    request.input.as_ref().map(|p| p.truncated).unwrap_or(false),
                    request.declared_tools,
                    codes_to_json(&request.issues),
                ],
            )
            .map_err(|e| StorageError(format!("insert request '{}': {e}", request.id)))?;
            for attempt in &request.attempts {
                tx.execute(
                    "INSERT INTO attempts (request_id, provider_id, upstream_id,
                         started_at_unix, finished_at_unix, result, error,
                         error_class, duration_ms, switch_reason,
                         input_tokens, output_tokens, cost, response_preview,
                         response_truncated, tool_count, tool_names,
                         tool_names_truncated, tool_list_truncated, issues)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                         ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
                    rusqlite::params![
                        request.id,
                        attempt.provider_id,
                        attempt.upstream_id,
                        attempt.started_at_unix,
                        attempt.finished_at_unix,
                        attempt.result,
                        attempt.error,
                        attempt.error_class,
                        attempt.duration_ms,
                        attempt.switch_reason,
                        attempt.input_tokens,
                        attempt.output_tokens,
                        attempt.cost,
                        attempt.response.as_ref().map(|p| p.text.clone()),
                        attempt
                            .response
                            .as_ref()
                            .map(|p| p.truncated)
                            .unwrap_or(false),
                        attempt.tool_calls.count,
                        serde_json::to_string(&attempt.tool_calls.names)
                            .unwrap_or_else(|_| "[]".to_string()),
                        attempt.tool_calls.truncated_names,
                        attempt.tool_calls.truncated_list,
                        codes_to_json(&attempt.issues),
                    ],
                )
                .map_err(|e| StorageError(format!("insert attempt '{}': {e}", request.id)))?;
            }
        }
        tx.commit()
            .map_err(|e| StorageError(format!("commit history batch: {e}")))?;
        Ok(())
    }

    /// Newest-first page of completed requests with all their attempts.
    pub fn list(&self, filter: &RequestFilter) -> Result<Vec<StoredHistoryRequest>, StorageError> {
        let (source, mut params) = filter.selection();
        let mut sql = format!(
            "SELECT id, key_alias, metamodel, started_at_unix, finished_at_unix,
                    outcome, input_preview, input_truncated, declared_tools, issues{source}"
        );
        if let Some(before_id) = &filter.before_id {
            params.push(Box::new(before_id.clone()));
            sql.push_str(&format!(" AND id < ?{}", params.len()));
        }
        params.push(Box::new(filter.limit));
        sql.push_str(&format!(
            " ORDER BY started_at_unix DESC, id DESC LIMIT ?{}",
            params.len()
        ));
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| StorageError(format!("list history: {e}")))?;
        let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |row| {
                Ok(StoredHistoryRequest {
                    id: row.get(0)?,
                    key_alias: row.get(1)?,
                    metamodel: row.get(2)?,
                    started_at_unix: row.get(3)?,
                    finished_at_unix: row.get(4)?,
                    outcome: row.get(5)?,
                    input_preview: row.get(6)?,
                    input_truncated: row.get::<_, i64>(7)? != 0,
                    declared_tools: row.get::<_, Option<i64>>(8)?.map(|v| v as u32),
                    issues: json_to_codes(row.get(9)?),
                    attempts: Vec::new(),
                })
            })
            .map_err(|e| StorageError(format!("query history: {e}")))?;
        let mut requests = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError(format!("list history rows: {e}")))?;
        for request in &mut requests {
            request.attempts = self.attempts_of(&request.id)?;
        }
        Ok(requests)
    }

    /// Count each saved call once. Minute counts give an exact peak even in a coarse chart.
    pub fn request_activity(
        &self,
        filter: &RequestFilter,
        step: Option<i64>,
        now: i64,
    ) -> Result<RequestActivity, StorageError> {
        let (source, params) = filter.selection();
        // Size archive bins from indexed endpoints, not from how long the router has been idle.
        let step = match step {
            Some(step) => step,
            None => {
                let bounds = format!("SELECT (SELECT started_at_unix{source} ORDER BY started_at_unix LIMIT 1),
                                             (SELECT started_at_unix{source} ORDER BY started_at_unix DESC LIMIT 1)");
                let (lo, hi): (Option<i64>, Option<i64>) = self
                    .conn
                    .query_row(&bounds, rusqlite::params_from_iter(&params), |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })
                    .map_err(|e| StorageError(format!("read archive bounds: {e}")))?;
                activity_step(hi.unwrap_or(0) - lo.unwrap_or(0))
            }
        };
        let sql = format!("WITH minutes AS (
              SELECT started_at_unix / 60 * 60 AS minute, COUNT(*) AS n,
                COUNT(*) FILTER (WHERE outcome = 'ok') AS ok,
                COUNT(*) FILTER (WHERE outcome = 'error') AS errors,
                COUNT(*) FILTER (WHERE outcome = 'client_cancel') AS cancels,
                SUM(EXISTS (SELECT 1 FROM attempts a WHERE a.request_id=requests.id LIMIT 1 OFFSET 1)) AS retried,
                MIN(started_at_unix) AS first_start, MAX(started_at_unix) AS last_start
              {source} GROUP BY minute)
            SELECT minute / {step} * {step} AS bucket, SUM(n), SUM(ok), SUM(errors), SUM(cancels),
                   SUM(retried), MAX(n), MIN(first_start), MAX(last_start)
            FROM minutes GROUP BY bucket ORDER BY bucket");
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| StorageError(format!("prepare request activity: {e}")))?;
        let buckets = stmt
            .query_map(rusqlite::params_from_iter(&params), |r| {
                Ok(RequestBucket {
                    start: r.get(0)?,
                    total: r.get(1)?,
                    ok: r.get(2)?,
                    errors: r.get(3)?,
                    cancels: r.get(4)?,
                    retried: r.get(5)?,
                    peak_per_minute: r.get(6)?,
                    first_start: r.get(7)?,
                    last_start: r.get(8)?,
                })
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(|e| StorageError(format!("read request activity: {e}")))?;
        Ok(RequestActivity {
            from_unix: filter
                .since_unix
                .or_else(|| buckets.first().map(|b| b.first_start)),
            to_unix: if filter.since_unix.is_some() {
                filter.to_unix.unwrap_or(now + 1)
            } else {
                buckets.last().map_or(now + 1, |b| b.last_start + 1)
            },
            as_of_unix: now,
            step_secs: step,
            buckets,
        })
    }

    /// Known input+output tokens of the provider's attempts finishing in
    /// [from_unix, to_unix). Unknown token counts are skipped, not zero.
    pub fn tokens_between(
        &self,
        provider_id: &str,
        from_unix: i64,
        to_unix: i64,
    ) -> Result<u64, StorageError> {
        self.conn
            .query_row(
                "SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0)
                 FROM attempts
                 WHERE provider_id = ?1
                   AND finished_at_unix >= ?2
                   AND finished_at_unix < ?3",
                rusqlite::params![provider_id, from_unix, to_unix],
                |row| row.get::<_, i64>(0),
            )
            .map(|tokens| tokens.max(0) as u64)
            .map_err(|e| StorageError(format!("sum attempt tokens: {e}")))
    }

    pub fn attempts_of(&self, request_id: &str) -> Result<Vec<StoredHistoryAttempt>, StorageError> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT id, provider_id, upstream_id, started_at_unix, finished_at_unix,
                    result, error, error_class, duration_ms, switch_reason,
                    input_tokens, output_tokens, cost,
                    response_preview, response_truncated, tool_count, tool_names,
                    tool_names_truncated, tool_list_truncated, issues
             FROM attempts WHERE request_id = ?1 ORDER BY id",
            )
            .map_err(|e| StorageError(format!("list attempts: {e}")))?;
        let rows = stmt
            .query_map([request_id], |row| {
                Ok(StoredHistoryAttempt {
                    id: row.get(0)?,
                    provider_id: row.get(1)?,
                    upstream_id: row.get(2)?,
                    started_at_unix: row.get(3)?,
                    finished_at_unix: row.get(4)?,
                    result: row.get(5)?,
                    error: row.get(6)?,
                    error_class: row.get(7)?,
                    duration_ms: row.get(8)?,
                    switch_reason: row.get(9)?,
                    input_tokens: row.get::<_, Option<i64>>(10)?.map(|v| v as u64),
                    output_tokens: row.get::<_, Option<i64>>(11)?.map(|v| v as u64),
                    cost: row.get(12)?,
                    response_preview: row.get(13)?,
                    response_truncated: row.get::<_, i64>(14)? != 0,
                    tool_count: row.get::<_, Option<i64>>(15)?.map(|v| v as u32),
                    tool_names: serde_json::from_str(&row.get::<_, String>(16).unwrap_or_default())
                        .unwrap_or_default(),
                    tool_names_truncated: row.get::<_, i64>(17)? != 0,
                    tool_list_truncated: row.get::<_, i64>(18)? != 0,
                    issues: json_to_codes(row.get(19)?),
                })
            })
            .map_err(|e| StorageError(format!("query attempts: {e}")))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| StorageError(format!("list attempt rows: {e}")))
    }

    /// Retention: delete whole requests (with attempts) that STARTED
    /// before the cutoff; the cutoff can never hit a live request
    /// because only completed summaries are stored.
    pub fn purge_older_than(&mut self, cutoff_unix: i64) -> Result<u64, StorageError> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| StorageError(format!("begin purge: {e}")))?;
        let deleted =
            tx.execute(
                "DELETE FROM requests WHERE started_at_unix < ?1",
                [cutoff_unix],
            )
            .map_err(|e| StorageError(format!("purge requests: {e}")))? as u64;
        tx.execute(
            "DELETE FROM attempts WHERE request_id NOT IN (SELECT id FROM requests)",
            [],
        )
        .map_err(|e| StorageError(format!("purge attempts: {e}")))?;
        tx.commit()
            .map_err(|e| StorageError(format!("commit purge: {e}")))?;
        Ok(deleted)
    }

    pub fn ping(&self) -> bool {
        self.conn
            .query_row("SELECT 1", [], |row| row.get::<_, i64>(0))
            .is_ok()
    }

    /// Spend per time bucket and group, counted in SQL so a month of
    /// history never travels to the browser as raw requests. Unknown
    /// usage stays unknown: `SUM` over NULL is NULL.
    pub fn usage_buckets(&self, query: &UsageQuery) -> Result<UsagePage, StorageError> {
        // Fixed expressions, never user text: the group is chosen by the enum.
        let group_expr = match query.group_by {
            UsageGroup::Provider => "a.provider_id",
            UsageGroup::Model => "a.provider_id || '/' || a.upstream_id",
            UsageGroup::Metamodel => "r.metamodel",
            UsageGroup::Key => "r.key_alias",
            UsageGroup::Family => "model_family(a.upstream_id)",
        };
        let f = &query.filter;
        // Only fixed column names enter the SQL. All filter values are bound.
        let mut source = String::from(
            " FROM attempts a JOIN requests r ON r.id = a.request_id WHERE a.started_at_unix >= ?",
        );
        let since = f.since_unix.unwrap_or(0);
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&since];
        if let Some(to) = &f.to_unix {
            source.push_str(" AND a.started_at_unix < ?");
            args.push(to);
        }
        for (column, value) in [
            ("a.provider_id", &f.provider),
            ("a.upstream_id", &f.model),
            ("model_family(a.upstream_id)", &f.family),
            ("r.key_alias", &f.key),
            ("r.metamodel", &f.pool),
        ] {
            if let Some(value) = value {
                source.push_str(&format!(" AND {column} = ?"));
                args.push(value);
            }
        }
        let timed = "a.result = 'ok' AND a.output_tokens IS NOT NULL AND a.duration_ms > 0";
        let unpriced =
            "a.cost IS NULL AND a.input_tokens IS NOT NULL AND a.output_tokens IS NOT NULL";
        let measures = format!(
            "COUNT(DISTINCT a.request_id), COUNT(*), SUM(a.input_tokens), SUM(a.output_tokens),
             COUNT(*) FILTER (WHERE a.result = 'error'), COUNT(*) FILTER (WHERE a.result = 'client_cancel'),
             COUNT(*) FILTER (WHERE a.input_tokens IS NULL AND a.output_tokens IS NULL),
             SUM(a.cost), COUNT(a.cost), COUNT(*) FILTER (WHERE a.result = 'ok'),
             COUNT(a.input_tokens), COUNT(a.output_tokens), AVG(a.duration_ms), COUNT(a.duration_ms),
             1000.0 * TOTAL(a.output_tokens) FILTER (WHERE {timed}) / SUM(a.duration_ms) FILTER (WHERE {timed}),
             COUNT(*) FILTER (WHERE {timed}), SUM(a.input_tokens + a.output_tokens) FILTER (WHERE {unpriced}), COUNT(*) FILTER (WHERE {unpriced})"
        );
        let read = |row: &rusqlite::Row<'_>| -> rusqlite::Result<UsageStats> {
            Ok(UsageStats {
                requests: row.get(0)?,
                attempts: row.get(1)?,
                input_tokens: row.get(2)?,
                output_tokens: row.get(3)?,
                errors: row.get(4)?,
                cancels: row.get(5)?,
                unknown_tokens: row.get(6)?,
                cost: row.get(7)?,
                cost_reports: row.get(8)?,
                ok: row.get(9)?,
                input_reports: row.get(10)?,
                output_reports: row.get(11)?,
                mean_duration_ms: row.get(12)?,
                duration_reports: row.get(13)?,
                output_tps: row.get(14)?,
                speed_reports: row.get(15)?,
                unpriced_tokens: row.get(16)?,
                estimable_attempts: row.get(17)?,
            })
        };
        let totals = self
            .conn
            .query_row(&format!("SELECT {measures}{source}"), args.as_slice(), read)
            .map_err(|e| StorageError(format!("count usage: {e}")))?;
        // Full-period token totals, independent of chart grouping or bucket truncation.
        let mut unpriced_by_provider = std::collections::BTreeMap::new();
        let mut unpriced_providers_truncated = false;
        if let Some(tokens) = totals.unpriced_tokens {
            if let Some(provider) = &f.provider {
                unpriced_by_provider.insert(provider.clone(), tokens);
            } else {
                let sql = format!(
                    "SELECT a.provider_id, SUM(a.input_tokens + a.output_tokens){source}
                    AND {unpriced} GROUP BY a.provider_id ORDER BY a.provider_id LIMIT 2001"
                );
                let mut load = || -> rusqlite::Result<()> {
                    let mut stmt = self.conn.prepare(&sql)?;
                    let mut rows = stmt.query(args.as_slice())?;
                    while let Some(row) = rows.next()? {
                        if unpriced_by_provider.len() == 2000 {
                            unpriced_providers_truncated = true;
                            break;
                        }
                        unpriced_by_provider.insert(row.get(0)?, row.get(1)?);
                    }
                    Ok(())
                };
                load().map_err(|e| StorageError(format!("sum unpriced tokens: {e}")))?;
            }
        }
        let step = query.bucket_seconds;
        let cap = query.limit.saturating_add(1);
        let connection = if f.split_provider {
            "a.provider_id"
        } else {
            "NULL"
        };
        let sql = format!(
            "SELECT {measures}, (a.started_at_unix / {step}) * {step} AS bucket,
                           {group_expr} AS grp, {connection} AS connection {source}
                           GROUP BY bucket, grp, connection ORDER BY bucket DESC, grp, connection LIMIT ?"
        );
        args.push(&cap);
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| StorageError(format!("prepare usage: {e}")))?;
        let mut rows = stmt
            .query_map(args.as_slice(), |row| {
                Ok(UsageBucket {
                    stats: read(row)?,
                    bucket_unix: row.get(18)?,
                    group: row.get(19)?,
                    provider: row.get(20)?,
                })
            })
            .map_err(|e| StorageError(format!("query usage: {e}")))?;
        let mut buckets = Vec::new();
        for row in rows.by_ref() {
            let bucket = row.map_err(|e| StorageError(format!("read usage: {e}")))?;
            buckets.push(bucket);
        }
        let truncated = buckets.len() as i64 >= cap;
        if truncated {
            buckets.pop();
        }
        Ok(UsagePage {
            unpriced_by_provider,
            unpriced_providers_truncated,
            buckets,
            truncated,
            totals,
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::history::AttemptSummary;

    use super::*;
    use crate::history::{ExtractIssue, Preview, ToolCallsSummary};

    fn store() -> HistoryStore {
        HistoryStore::new(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn sample(id: &str, started: i64, attempts: usize) -> RequestSummary {
        RequestSummary {
            id: id.to_owned(),
            key_alias: "m5".to_owned(),
            metamodel: "glm".to_owned(),
            started_at_unix: started,
            finished_at_unix: started + 9,
            outcome: "ok".to_owned(),
            input: Some(Preview {
                text: "вопрос".to_owned(),
                truncated: false,
            }),
            declared_tools: Some(2),
            issues: vec![ExtractIssue::EventTooLarge],
            attempts: (0..attempts)
                .map(|i| AttemptSummary {
                    provider_id: "zai".to_owned(),
                    upstream_id: format!("glm-5.{i}"),
                    started_at_unix: started + i as i64,
                    finished_at_unix: started + i as i64 + 1,
                    result: if i + 1 == attempts { "ok" } else { "error" }.to_owned(),
                    error: (i + 1 != attempts).then(|| "timeout".to_owned()),
                    error_class: None,
                    duration_ms: None,
                    switch_reason: (i + 1 != attempts).then(|| "ban".to_owned()),
                    input_tokens: (i == 0).then_some(11),
                    output_tokens: (i == 0).then_some(22),
                    cost: (i == 0).then_some(0.5),
                    response: (i + 1 == attempts).then(|| Preview {
                        text: "ответ".to_owned(),
                        truncated: true,
                    }),
                    tool_calls: ToolCallsSummary {
                        count: Some(3),
                        names: vec!["a".to_owned(), "b".to_owned()],
                        truncated_names: true,
                        truncated_list: false,
                    },
                    issues: vec![],
                })
                .collect(),
        }
    }

    #[test]
    fn activity_counts_calls_before_paging_and_preserves_minute_peaks() {
        let mut store = store();
        let mut failed = sample("b", 61, 1);
        failed.outcome = "error".into();
        let mut cancel = sample("c", 120, 1);
        cancel.outcome = "client_cancel".into();
        let mut unknown = sample("d", 121, 0);
        unknown.outcome = "unknown".into();
        store
            .insert_summaries(&[
                sample("a", 60, 2),
                failed,
                cancel,
                unknown,
                sample("e", 180, 1),
            ])
            .unwrap();
        let mut f = RequestFilter {
            since_unix: Some(60),
            to_unix: Some(180),
            limit: 1,
            ..Default::default()
        };
        let activity = store.request_activity(&f, Some(900), 179).unwrap();
        let b = &activity.buckets[0];
        assert_eq!(
            (
                b.total,
                b.ok,
                b.errors,
                b.cancels,
                b.retried,
                b.peak_per_minute,
                b.last_start
            ),
            (4, 1, 1, 1, 1, 2, 121)
        );
        f.model = Some("glm-5.1".into());
        f.provider = Some("zai".into());
        assert_eq!(
            store.request_activity(&f, Some(60), 179).unwrap().buckets[0].total,
            1
        );
        assert_eq!(store.list(&f).unwrap()[0].id, "a");
        f.provider = Some("not present".into());
        assert!(
            store
                .request_activity(&f, Some(60), 179)
                .unwrap()
                .buckets
                .is_empty()
        );
        let archive = store
            .request_activity(&RequestFilter::default(), None, 86400)
            .unwrap();
        assert_eq!((archive.from_unix, archive.to_unix), (Some(60), 181));
    }

    #[test]
    fn batch_inserts_and_reads_back_compactly() {
        let mut store = store();
        store
            .insert_summaries(&[sample("r1", 100, 2), sample("r2", 200, 1)])
            .unwrap();
        let page = store
            .list(&RequestFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.len(), 2);
        // Newest first.
        assert_eq!(page[0].id, "r2");
        let r1 = &page[1];
        assert_eq!(r1.input_preview.as_deref(), Some("вопрос"));
        assert!(!r1.input_truncated);
        assert_eq!(r1.declared_tools, Some(2));
        assert_eq!(r1.issues, ["event_too_large"]);
        assert_eq!(r1.attempts.len(), 2);
        let last = r1.attempts.last().unwrap();
        assert_eq!(last.result.as_deref(), Some("ok"));
        assert_eq!(last.response_preview.as_deref(), Some("ответ"));
        assert!(last.response_truncated);
        assert_eq!(last.tool_names, ["a", "b"]);
        assert!(last.tool_names_truncated);
        assert_eq!(last.tool_count, Some(3));
        let first = &r1.attempts[0];
        assert_eq!(first.input_tokens, Some(11));
        assert_eq!(first.cost, Some(0.5));
        assert_eq!(first.error.as_deref(), Some("timeout"));
    }

    #[test]
    fn duplicate_request_id_rejects_whole_batch_atomically() {
        let mut store = store();
        store.insert_summaries(&[sample("r1", 100, 1)]).unwrap();
        // Same id again -> constraint failure -> nothing from this batch.
        let result = store.insert_summaries(&[sample("r9", 300, 1), sample("r1", 100, 1)]);
        assert!(result.is_err());
        assert_eq!(
            store
                .list(&RequestFilter {
                    limit: 10,
                    ..Default::default()
                })
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn unknown_values_stay_null_not_zero() {
        let mut store = store();
        let mut summary = sample("r1", 100, 1);
        summary.attempts[0].input_tokens = None;
        summary.attempts[0].output_tokens = None;
        summary.attempts[0].cost = None;
        summary.attempts[0].response = None;
        summary.attempts[0].tool_calls = ToolCallsSummary::default();
        summary.input = None;
        summary.declared_tools = None;
        store.insert_summaries(&[summary]).unwrap();
        let row = &store
            .list(&RequestFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap()[0];
        assert!(row.input_preview.is_none());
        assert_eq!(row.declared_tools, None);
        let attempt = &row.attempts[0];
        assert!(attempt.input_tokens.is_none());
        assert!(attempt.cost.is_none());
        assert!(attempt.response_preview.is_none());
        assert!(attempt.tool_count.is_none());
        assert!(attempt.tool_names.is_empty());
    }

    #[test]
    fn unpriced_tokens_exclude_reported_zero_and_unknown_counts() {
        let mut store = store();
        let mut req = sample("mixed", 100, 4);
        for (a, (provider, cost, output)) in req.attempts.iter_mut().zip([
            ("p", Some(0.0), Some(20)),
            ("p", None, Some(20)),
            ("p", None, None),
            ("q", None, Some(40)),
        ]) {
            a.provider_id = provider.into();
            a.cost = cost;
            a.input_tokens = Some(10);
            a.output_tokens = output;
        }
        store.insert_summaries(&[req]).unwrap();
        let mut query = UsageQuery {
            filter: UsageFilter::default(),
            bucket_seconds: 3600,
            group_by: UsageGroup::Provider,
            limit: 1,
        };
        let page = store.usage_buckets(&query).unwrap();
        assert!(page.truncated);
        assert_eq!(page.totals.cost, Some(0.0));
        assert_eq!(page.totals.unpriced_tokens, Some(80));
        assert_eq!(page.unpriced_by_provider["p"], 30);
        assert_eq!(page.unpriced_by_provider["q"], 50);
        query.filter.provider = Some("p".into());
        let selected = store.usage_buckets(&query).unwrap();
        assert_eq!(selected.totals.unpriced_tokens, Some(30));
        assert_eq!(selected.buckets[0].stats.unpriced_tokens, Some(30));
    }

    #[test]
    fn compare_model_aliases_by_connection_and_trace_the_same_attempt_window() {
        let mut store = store();
        let mut request = sample("compare", 10, 3);
        for (a, (p, m, start, cost)) in request.attempts.iter_mut().zip([
            ("direct", "model-4.1", 61, None),
            ("proxy", "vendor/model-4-1", 62, Some(0.0)),
            ("direct", "model-4.1", 63, None),
        ]) {
            a.provider_id = p.into();
            a.upstream_id = m.into();
            a.started_at_unix = start;
            a.cost = cost;
            a.input_tokens = Some(1);
            a.output_tokens = Some(1);
        }
        store.insert_summaries(&[request]).unwrap();
        let filter = UsageFilter {
            since_unix: Some(61),
            to_unix: Some(63),
            family: Some("model-4-1".into()),
            split_provider: true,
            ..Default::default()
        };
        let page = store
            .usage_buckets(&UsageQuery {
                filter,
                bucket_seconds: 60,
                group_by: UsageGroup::Family,
                limit: 20,
            })
            .unwrap();
        assert_eq!(
            (
                page.totals.requests,
                page.totals.attempts,
                page.totals.estimable_attempts
            ),
            (1, 2, 1)
        );
        assert_eq!(page.buckets.len(), 2);
        assert!(
            page.buckets
                .iter()
                .all(|b| b.group == "model-4-1" && b.bucket_unix == 60)
        );
        assert_eq!(page.buckets[0].provider.as_deref(), Some("direct"));
        assert_eq!(page.buckets[1].stats.cost, Some(0.0));
        let mut f = RequestFilter {
            since_unix: Some(62),
            to_unix: Some(63),
            attempt_window: true,
            provider: Some("proxy".into()),
            family: Some("model-4-1".into()),
            limit: 10,
            ..Default::default()
        };
        assert_eq!(store.list(&f).unwrap().len(), 1);
        f.provider = Some("direct".into());
        assert!(store.list(&f).unwrap().is_empty());
    }

    #[test]
    fn usage_speed_pairs_output_with_its_own_successful_duration() {
        let mut store = store();
        let mut request = sample("timed", 100, 5);
        for (a, (result, ms, output)) in request.attempts.iter_mut().zip([
            ("ok", Some(100), Some(1)),
            ("ok", Some(900), Some(99)),
            ("ok", None, Some(300)),
            ("ok", Some(100), None),
            ("client_cancel", Some(100), Some(900)),
        ]) {
            a.result = result.into();
            a.duration_ms = ms;
            a.output_tokens = output;
        }
        store.insert_summaries(&[request]).unwrap();
        let totals = store
            .usage_buckets(&UsageQuery {
                filter: UsageFilter::default(),
                bucket_seconds: 3600,
                group_by: UsageGroup::Model,
                limit: 1,
            })
            .unwrap()
            .totals;
        assert_eq!(totals.speed_reports, 2);
        assert_eq!(totals.output_tps, Some(100.0));
        assert_eq!(totals.duration_reports, 4);
        assert_eq!(totals.mean_duration_ms, Some(300.0));
    }

    #[test]
    fn usage_buckets_count_cancels_separately_from_errors() {
        let mut store = store();
        let mut cancelled = sample("c1", 100, 1);
        cancelled.attempts[0].result = "client_cancel".to_owned();
        let mut errored = sample("e1", 110, 1);
        errored.attempts[0].result = "error".to_owned();
        store.insert_summaries(&[cancelled, errored]).unwrap();

        let page = store
            .usage_buckets(&UsageQuery {
                filter: UsageFilter::default(),
                bucket_seconds: 3_600,
                group_by: UsageGroup::Provider,
                limit: 100,
            })
            .unwrap();
        let bucket = &page.buckets[0].stats;
        // A cancel is neither a provider error nor a clean success.
        assert_eq!(bucket.errors, 1);
        assert_eq!(bucket.cancels, 1);
        assert_eq!(bucket.attempts, 2);
    }

    #[test]
    fn error_class_and_duration_survive_the_roundtrip_and_migration() {
        // A database written before the columns existed upgrades in place.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE requests (
                 id TEXT PRIMARY KEY, key_alias TEXT NOT NULL,
                 metamodel TEXT NOT NULL, started_at_unix INTEGER NOT NULL,
                 finished_at_unix INTEGER, outcome TEXT, input_preview TEXT,
                 input_truncated INTEGER NOT NULL DEFAULT 0,
                 declared_tools INTEGER, issues TEXT NOT NULL DEFAULT '[]');
             CREATE TABLE attempts (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 request_id TEXT NOT NULL, provider_id TEXT NOT NULL,
                 upstream_id TEXT NOT NULL, started_at_unix INTEGER NOT NULL,
                 finished_at_unix INTEGER, result TEXT, error TEXT,
                 switch_reason TEXT, input_tokens INTEGER, output_tokens INTEGER,
                 cost REAL, response_preview TEXT,
                 response_truncated INTEGER NOT NULL DEFAULT 0,
                 tool_count INTEGER, tool_names TEXT NOT NULL DEFAULT '[]',
                 tool_names_truncated INTEGER NOT NULL DEFAULT 0,
                 tool_list_truncated INTEGER NOT NULL DEFAULT 0,
                 issues TEXT NOT NULL DEFAULT '[]');",
        )
        .unwrap();
        let mut store = HistoryStore::new(conn).unwrap();
        // Opening the old database also adds the provider/time index the
        // spend calibration relies on.
        let indexed: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_attempts_provider_time'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(indexed, 1);

        let mut summary = sample("t1", 100, 1);
        summary.attempts[0].error = Some("quota gone".to_owned());
        summary.attempts[0].error_class = Some("quota_exhausted".to_owned());
        summary.attempts[0].duration_ms = Some(2_500);
        store.insert_summaries(&[summary]).unwrap();
        let row = &store
            .list(&RequestFilter {
                limit: 1,
                ..Default::default()
            })
            .unwrap()[0];
        assert_eq!(
            row.attempts[0].error_class.as_deref(),
            Some("quota_exhausted")
        );
        assert_eq!(row.attempts[0].duration_ms, Some(2_500));
    }

    #[test]
    fn purge_deletes_whole_requests_before_cutoff() {
        let mut store = store();
        store
            .insert_summaries(&[sample("old", 100, 2), sample("new", 200, 1)])
            .unwrap();
        assert_eq!(store.purge_older_than(150).unwrap(), 1);
        let page = store
            .list(&RequestFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, "new");
        assert!(store.attempts_of("old").unwrap().is_empty());
    }

    #[test]
    fn member_filter_matches_one_attempt_and_returns_the_full_trace() {
        let mut store = store();
        let mut call = sample("r1", 100, 2);
        call.attempts[1].provider_id = "backup".into();
        store
            .insert_summaries(&[call, sample("r2", 101, 1)])
            .unwrap();
        let list = |provider: &str, model: &str| {
            store
                .list(&RequestFilter {
                    provider: Some(provider.into()),
                    model: Some(model.into()),
                    limit: 1,
                    ..Default::default()
                })
                .unwrap()
        };
        let found = list("backup", "glm-5.1");
        assert_eq!(found[0].id, "r1");
        assert_eq!(found[0].attempts.len(), 2);
        assert!(list("backup", "glm-5.0").is_empty());
    }

    #[test]
    fn cursor_pagination_newest_first() {
        let mut store = store();
        let batch: Vec<RequestSummary> = (0..5)
            .map(|i| sample(&format!("r{i}"), 100 + i, 1))
            .collect();
        store.insert_summaries(&batch).unwrap();
        let first = store
            .list(&RequestFilter {
                limit: 2,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            first.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["r4", "r3"]
        );
        let second = store
            .list(&RequestFilter {
                limit: 2,
                before_id: Some("r3".to_owned()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            second.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["r2", "r1"]
        );
    }
}
