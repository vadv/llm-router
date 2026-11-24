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

/// Amount spent per day, and over how many hours that was measured.
export type Pace = {
  perDay: number;
  hours: number;
};

/// The pace of a reading, from how what is left changes over time. It is
/// measured back to the last refill only: a reset or a top-up is a rise in
/// what is left, and the fall before it belongs to a window that ended. A
/// rise counts as a refill from a tenth of the limit (or of the most that
/// was left): smaller ones are a request giving its share back. Needs an
/// hour of readings: a few minutes would turn noise into a confident date.
export function pace(row: Observation, history: Observation[]): Pace | null {
  const points: { unix: number; left: number }[] = [];
  for (const point of history) {
    const left = balanceReading(point).left;
    if (left !== null) points.push({ unix: point.observed_at_unix, left });
  }
  const last = points.at(-1);
  if (!last) return null;
  // A rise smaller than this is jitter, not a refill.
  const jitter =
    Math.max(balanceReading(row).limit ?? 0, ...points.map((point) => point.left)) * 0.1;
  let first = points.length - 1;
  for (let index = points.length - 2; index >= 0; index--) {
    if (points[index].left < points[index + 1].left - jitter) break;
    first = index;
  }
  const hours = (last.unix - points[first].unix) / 3600;
  if (hours < 1) return null;
  return { perDay: ((points[first].left - last.left) / hours) * 24, hours };
}

/// Whether what is left will last, at the measured pace. The same for a
/// balance and for a quota: the question is what runs out first, the amount
/// or the window.
export type Outlook =
  // Nothing left to spend.
  | { kind: "exhausted"; resetsAt: number | null }
  // It cannot be judged: no amount is reported; the last reading is more
  // than a day old; no reading of the last day names an amount; or there is
  // less than an hour of readings since the last refill.
  | {
      kind: "unknown";
      why: "amount" | "stale" | "none" | "refill";
      resetsAt: number | null;
    }
  // Nothing was spent over the measured hours.
  | { kind: "quiet"; resetsAt: number | null; hours: number }
  // At this pace it is empty before the reset. `shortfall` is what would
  // be missing had the window lasted to its reset.
  | { kind: "short"; pace: Pace; runsOutAt: number; resetsAt: number; shortfall: number }
  // At this pace something is left at the reset, `spare` of it (`spareShare`
  // of the limit), or, with no reset to wait for, it lasts until `runsOutAt`.
  | {
      kind: "lasts";
      pace: Pace;
      runsOutAt: number;
      resetsAt: number | null;
      spare: number | null;
      spareShare: number | null;
    };

const DAY = 86_400;

/// How far back the pace of a reading is measured: the pace of the last
/// day, and a reading older than that is one the provider stopped sending.
export const LAST_DAY = 26 * 3600;

export function limitOutlook(
  row: Observation,
  history: Observation[],
  now: number,
): Outlook {
  const { left, limit, percentLeft } = balanceReading(row);
  const resetsAt =
    row.resets_at_unix !== null && row.resets_at_unix > now
      ? row.resets_at_unix
      : null;
  // A reading the provider stopped sending says nothing about now, whatever
  // its amounts: it is named as stale before anything is read of it.
  if (now - row.observed_at_unix > LAST_DAY) {
    return { kind: "unknown", why: "stale", resetsAt };
  }
  if (left === null) return { kind: "unknown", why: "amount", resetsAt };
  if (left <= 0 || percentLeft === 0) return { kind: "exhausted", resetsAt };
  const rate = pace(row, history);
  if (rate === null) {
    const why = history.some((point) => balanceReading(point).left !== null) ? "refill" : "none";
    return { kind: "unknown", why, resetsAt };
  }
  if (rate.perDay <= 0) {
    return { kind: "quiet", resetsAt, hours: rate.hours };
  }
  const runsOutAt = now + (left / rate.perDay) * DAY;
  if (resetsAt === null) {
    return { kind: "lasts", pace: rate, runsOutAt, resetsAt: null, spare: null, spareShare: null };
  }
  if (runsOutAt < resetsAt) {
    return {
      kind: "short",
      pace: rate,
      runsOutAt,
      resetsAt,
      shortfall: ((resetsAt - runsOutAt) / DAY) * rate.perDay,
    };
  }
  const spare = left - ((resetsAt - now) / DAY) * rate.perDay;
  return {
    kind: "lasts",
    pace: rate,
    runsOutAt,
    resetsAt,
    spare,
    spareShare: limit !== null && limit > 0 ? Math.max(0, spare / limit) : null,
  };
}

/// The order of the Limits page: what is empty, what will not last, what
/// runs dry next, then what lasts. Within a class the sooner comes first.
/// Unknown readings come last: nothing can be said of them.
export function outlookRank(outlook: Outlook): number {
  const at = (group: number, unix: number) => group * 1e11 + unix;
  switch (outlook.kind) {
    case "exhausted":
      return 0;
    case "short":
      return at(1, outlook.runsOutAt);
    case "lasts":
      if (outlook.resetsAt === null) return at(2, outlook.runsOutAt);
      return at(outlook.spareShare !== null && outlook.spareShare < 0.1 ? 3 : 4, outlook.resetsAt);
    case "quiet":
      return 5e11;
    case "unknown":
      return 6e11;
  }
}

/// Too little would be left at the reset for the verdict to read as a calm one.
export const TIGHT_SPARE = 0.1;
