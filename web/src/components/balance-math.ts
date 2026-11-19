import type { Observation } from "../api";

/// One unit of a collapsed group of indicators. Amounts of different units
/// never share a sum or a bar: one account can report both CNY and USD.
/// Rows without a reported amount stay out of the sum, so a balance that
/// reports only what is left does not read as 0 / 0. `usage`/`limit` are set
/// when the upstream reports a counter, otherwise `remaining` is set.
export type GroupPart = {
  unit: string;
  usage: number | null;
  limit: number | null;
  remaining: number | null;
};

export type BalanceRisk = "ok" | "low" | "exhausted";

/// Percent is the share still available. Ratio readings arrive as shares used.
export function balanceReading(row: Observation) {
  const usage = finite(row.usage);
  const ratio = row.metric === "ratio";
  const used = ratio && usage !== null ? usage * 100 : usage;
  const limit = ratio ? 100 : finite(row.limit);
  const reported = finite(row.remaining);
  const left = ratio && reported !== null ? reported * 100 : reported ??
    (limit !== null && limit > 0 && used !== null ? Math.max(0, limit - used) : null);
  const percentLeft = limit !== null && limit > 0 && left !== null
    ? Math.max(0, Math.min(100, 100 * left / limit)) : null;
  return { left, used, limit, percentLeft };
}

/// Repeat identical window readings once, but keep access to each resource's history.
export function readingGroups(rows: Observation[]): Observation[][] {
  const groups = new Map<string, Observation[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.provider_id, row.window, row.metric, row.unit,
      row.usage, row.limit, row.remaining, row.resets_at_unix, row.window === null ? row.resource : null]);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/// Current-state risk from the latest snapshot. A forecast needs history,
/// so it is applied by the page where the series is already loaded.
export function balanceRisk(
  row: Observation,
  days: number | null = null,
): BalanceRisk {
  const usage = finite(row.usage);
  const limit = finite(row.limit);
  const left = finite(row.remaining);
  // Ratio metrics carry the usage fraction without a limit field. Treat the
  // fraction as a zero-to-one balance so a full quota is visibly exhausted.
  const isRatio = row.metric === "ratio" && usage !== null;
  const ratioUsage = isRatio ? usage : null;
  // These quotas are reported as used and left until a reset. The used
  // value is spend, not the remaining balance; only remaining == 0 is empty.
  const quota =
    row.window !== null &&
    (row.metric === "requests" || row.metric === "tokens");
  const fraction =
    isRatio && ratioUsage !== null
      ? ratioUsage
      : limit !== null && limit > 0 && usage !== null
        ? usage / limit
        : quota && left !== null && limit !== null && limit > 0
          ? 1 - left / limit
          : null;
  if (
    (fraction !== null && fraction >= 1) ||
    (left !== null && left <= 0)
  ) {
    return "exhausted";
  }
  if (
    (fraction !== null && fraction >= 0.85) ||
    (days !== null && days < 7)
  ) {
    return "low";
  }
  return "ok";
}

export function groupAmounts(rows: Observation[]): {
  parts: GroupPart[];
  percent: number | null;
  shared: boolean;
} {
  // One account counter can be reported once per model: OpenRouter copies
  // its account-wide free-model limit onto every free model. Identical
  // amounts are therefore counted once, never added up, and the caller says
  // so. The expanded rows still show every model.
  const unique = new Map<string, Observation>();
  for (const row of rows) {
    const signature = `${row.metric}|${row.window ?? ""}|${row.unit ?? ""}|${row.limit}|${row.usage}|${row.remaining}`;
    if (!unique.has(signature)) unique.set(signature, row);
  }
  const shared = unique.size < rows.length;
  const counted = [...unique.values()];
  const units = [...new Set(counted.map((row) => row.unit ?? ""))];
  const parts: GroupPart[] = [];
  let percent: number | null = null;
  for (const unit of units) {
    const group = counted.filter((row) => (row.unit ?? "") === unit);
    const measured = group.filter(
      (row) => finite(row.usage) !== null && finite(row.limit) !== null,
    );
    if (measured.length > 0) {
      const usage = measured.reduce(
        (sum, row) => sum + (finite(row.usage) ?? 0),
        0,
      );
      const limit = measured.reduce(
        (sum, row) => sum + (finite(row.limit) ?? 0),
        0,
      );
      parts.push({ unit, usage, limit, remaining: null });
      if (units.length === 1 && limit > 0)
        percent = Math.min(100, (usage / limit) * 100);
      continue;
    }
    const left = group.filter((row) => finite(row.remaining) !== null);
    if (left.length > 0) {
      const remaining = left.reduce(
        (sum, row) => sum + (finite(row.remaining) ?? 0),
        0,
      );
      parts.push({ unit, usage: null, limit: null, remaining });
    }
  }
  return { parts, percent, shared };
}

/// A decimal string from an upstream. Anything that is not a finite number
/// stays unknown: a malformed amount must not become a zero or a NaN sum.
function finite(value: string | null): number | null {
  if (value === null || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/// Amount spent per day, from the reported remaining amount. Needs two
/// finite points; a rising series (a top-up) gives a negative rate, which
/// is not a burn. The lookback is two days: with the request capped at 500
/// points and a 10-minute schedule that is what the caller can deliver,
/// and the forecast below needs a full day of measured change.
function measuredWindow(
  history: Observation[],
  lookbackSec: number,
): {
  first: { unix: number; value: number };
  last: { unix: number; value: number };
  days: number;
} | null {
  const now = Math.floor(Date.now() / 1000);
  const recent = history.flatMap((point) => {
    const value = finite(point.remaining);
    return value !== null && point.observed_at_unix >= now - lookbackSec
      ? [{ unix: point.observed_at_unix, value }] : [];
  });
  if (recent.length < 2) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const days = (last.unix - first.unix) / 86_400;
  return days > 0 ? { first, last, days } : null;
}

export function burnPerDay(
  current: Observation,
  history: Observation[],
): number | null {
  if (
    !["money", "credits"].includes(current.metric) ||
    current.remaining === null
  )
    return null;
  const window = measuredWindow(history, 2 * 24 * 3600);
  if (window === null) return null;
  // A few minutes of history extrapolate a cent of change into a confident
  // yearly rate. Wait for an hour of observations before forecasting.
  if (window.days < 1 / 24) return null;
  return (window.first.value - window.last.value) / window.days;
}

/// "How long does the current amount last at the current burn rate?"
/// The forecast is for money only: a window counter refills itself.
export function daysLeft(
  current: Observation,
  history: Observation[],
): number | null {
  if (current.window === "daily") return null;
  const burn = burnPerDay(current, history);
  const left = finite(current.remaining);
  if (burn === null || burn <= 0 || left === null) return null;
  // "608 days left" from one hour of history is a guess dressed as a number.
  // The rate must be measured over a full day of finite observations, not
  // merely spanned by records with unknown amounts at the ends.
  const window = measuredWindow(history, 2 * 24 * 3600);
  if (window === null || window.days < 1) return null;
  return left / burn;
}
