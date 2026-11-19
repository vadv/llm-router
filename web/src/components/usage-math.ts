// Aggregation of the usage buckets, kept apart from the page so the sums,
// the ranking and the unknown-amount rules can be tested without a browser.

import type { SpendSeries, UsageBucket, UsagePeriod, UsageStats } from "../api";

export type Metric = "tokens" | "attempts" | "errors" | "cost";

// Use the same rank colours in the plot and the breakdown table.
const COLORS = ["teal", "grape", "orange", "cyan", "yellow", "pink", "lime", "indigo"].map(
  (name) => `var(--mantine-color-${name}-5)`,
);
const OTHER_COLOR = "var(--mantine-color-gray-5)";
/// More bands than this are unreadable, so the tail becomes one honest band.
const MAX_BANDS = 7;

export type Totals = {
  attempts: number;
  input: number;
  output: number;
  /// How many buckets reported each direction at all. Without this a group
  /// that never reports tokens would read as a measured zero.
  inputReports: number;
  outputReports: number;
  errors: number;
  unknown: number;
  cost: number;
  costReports: number;
  unpricedTokens: number | null;
};

export const EMPTY: Totals = {
  attempts: 0,
  input: 0,
  output: 0,
  inputReports: 0,
  outputReports: 0,
  errors: 0,
  unknown: 0,
  cost: 0,
  costReports: 0,
  unpricedTokens: null,
};

function add(target: Totals, bucket: UsageBucket): Totals {
  return {
    attempts: target.attempts + bucket.attempts,
    input: target.input + (bucket.input_tokens ?? 0),
    output: target.output + (bucket.output_tokens ?? 0),
    inputReports: target.inputReports + (bucket.input_tokens === null ? 0 : 1),
    outputReports: target.outputReports + (bucket.output_tokens === null ? 0 : 1),
    errors: target.errors + bucket.errors,
    unknown: target.unknown + bucket.unknown_tokens,
    cost: target.cost + (bucket.cost ?? 0),
    costReports: target.costReports + bucket.cost_reports,
    unpricedTokens: bucket.unpriced_tokens == null ? target.unpricedTokens : (target.unpricedTokens ?? 0) + bucket.unpriced_tokens,
  };
}

export function sumBuckets(buckets: UsageBucket[]): Totals {
  return buckets.reduce(add, EMPTY);
}

/// The value of one bucket for the chosen metric. Null stays null: an
/// unreported amount is a gap in the chart, never a zero band.
export function valueOf(bucket: UsageBucket, metric: Metric): number | null {
  if (metric === "attempts") return bucket.attempts;
  if (metric === "errors") return bucket.errors;
  if (metric === "cost") return bucket.cost;
  return knownTokens(bucket.input_tokens, bucket.output_tokens);
}

export function knownTokens(input: number | null, output: number | null): number | null {
  return input === null && output === null ? null : (input ?? 0) + (output ?? 0);
}

export function errorPercent({ errors, ok }: Pick<UsageStats, "errors" | "ok">): number | null {
  return ok + errors ? 100 * errors / (ok + errors) : null;
}

export function allocatedSpend(series: SpendSeries | undefined, tokens: number | null): number | null {
  const rate = series?.per_1000;
  if (!series?.primary_series || rate == null || tokens == null) return null;
  const amount = rate * (tokens / 1000);
  return Number.isFinite(amount) ? amount : null;
}

const spendFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 });

export function spendText(value: number | null | undefined, series: SpendSeries | undefined) {
  return value == null || !series ? "—" : `${spendFormat.format(value)} ${series.unit || series.metric}`;
}

export function providerEstimates(tokensByProvider: Record<string, number>, series: SpendSeries[]) {
  const rates = new Map(series.filter(s => s.primary_series && s.per_1000 != null).map(s => [s.provider, s]));
  return Object.entries(tokensByProvider).map(([provider, tokens]) => {
    const rate = rates.get(provider);
    return { provider, tokens, rate, amount: allocatedSpend(rate, tokens) };
  });
}

export type Leader = { group: string; color: string; totals: Totals };

export function rankGroups(buckets: UsageBucket[], metric: Metric): Leader[] {
  const byGroup = new Map<string, Totals>();
  for (const bucket of buckets) {
    byGroup.set(bucket.group, add(byGroup.get(bucket.group) ?? EMPTY, bucket));
  }
  const weight = (totals: Totals) =>
    metric === "attempts"
      ? totals.attempts
      : metric === "errors"
        ? totals.errors
        : metric === "cost"
          ? totals.cost
          : totals.input + totals.output;
  return [...byGroup.entries()]
    .sort((a, b) => weight(b[1]) - weight(a[1]) || a[0].localeCompare(b[0]))
    .map(([group, totals], index) => ({
      group,
      color: index < MAX_BANDS ? COLORS[index % COLORS.length] : OTHER_COLOR,
      totals,
    }));
}

export type UsagePoint = {
  unix: number;
  from: number;
  to: number;
  attempts: number;
  value: number | null;
  partial: boolean;
};

// Stack observed values, not estimates. Keep coverage to distinguish a
// quiet hour, a reported zero and an attempt with no token or cost report.
export function buildSeries(
  buckets: UsageBucket[],
  leaders: Leader[],
  metric: Metric,
  stepSeconds: number,
  period: UsagePeriod = {},
) {
  if (!buckets.length || !(stepSeconds > 0)) return [];
  const stamps = buckets.map((b) => b.bucket_unix);
  const start = period.sinceUnix ?? Math.min(...stamps);
  const end = period.toUnix ?? Math.max(...stamps) + stepSeconds;
  if (end <= start) return [];
  const origin = Math.floor(start / stepSeconds) * stepSeconds;
  // Fold long archives into wider columns without dropping any observations.
  const step = stepSeconds * Math.max(1, Math.ceil((end - origin) / (180 * stepSeconds)));
  const count = Math.ceil((end - origin) / step);
  const names = leaders.slice(0, MAX_BANDS).map((l) => l.group);
  const tail = leaders.length - names.length;
  const indices = new Map(names.map((name, i) => [name, i]));
  if (tail) names.push(`other (${tail})`);
  const bands = names.map((label, index) => ({
    label, color: leaders[index].color, step,
    points: Array.from({ length: count }, (_, n): UsagePoint => {
      const unix = origin + n * step;
      return { unix, from: Math.max(unix, start), to: Math.min(unix + step, end),
        attempts: 0, value: null, partial: false };
    }),
  }));
  for (const b of buckets) {
    const band = bands[indices.get(b.group) ?? MAX_BANDS];
    const p = band.points[Math.floor((b.bucket_unix - origin) / step)];
    if (!p) continue;
    p.attempts += b.attempts;
    const v = valueOf(b, metric);
    if (v !== null) p.value = (p.value ?? 0) + v;
    if (metric === "tokens") p.partial ||= b.input_reports < b.attempts || b.output_reports < b.attempts;
    if (metric === "cost") p.partial ||= b.cost_reports < b.attempts;
  }
  for (const band of bands) {
    if (band.points.some((p) => p.value !== null)) {
      for (const p of band.points) if (!p.attempts && p.value === null) p.value = 0;
    }
  }
  return bands;
}