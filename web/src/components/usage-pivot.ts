import type { ProviderInfo, SpendSeries, UsageBucket } from "../api";
import { allocatedSpend } from "./usage-math.ts";

export type Window = { from: number; to: number };
export type Measure = "spend" | "tokens" | "estimate" | "reported";
export type Cell = ReturnType<typeof emptyCell>;
export function emptyCell() {
  return {
    attempts: 0,
    input: 0,
    output: 0,
    inputs: 0,
    outputs: 0,
    reported: 0,
    estimated: 0,
    reportedCount: 0,
    estimatedCount: 0,
    outside: 0,
  };
}
const add = (target: Cell, cell: Cell) => {
  for (const key of Object.keys(cell) as (keyof Cell)[])
    target[key] += cell[key];
};
export const missing = (c: Cell) =>
  c.attempts - c.reportedCount - c.estimatedCount - c.outside;
export function amount(c: Cell, metric: Measure) {
  if (metric === "tokens")
    return c.inputs || c.outputs ? c.input + c.output : null;
  if (metric === "reported") return c.reportedCount ? c.reported : null;
  if (metric === "estimate") return c.estimatedCount ? c.estimated : null;
  return c.reportedCount || c.estimatedCount ? c.reported + c.estimated : null;
}
// Compare like units only, with complete cost and token coverage on both sides.
export function perMillion(c: Cell) {
  const cost = amount(c, "spend"),
    tokens = c.input + c.output;
  return cost !== null &&
    tokens > 0 &&
    c.inputs === c.attempts &&
    c.outputs === c.attempts &&
    !c.outside &&
    !missing(c)
    ? (cost * 1e6) / tokens
    : null;
}
const currencies = new Set(Intl.supportedValuesOf("currency"));
export function prepareCosts(
  rows: UsageBucket[],
  providers: ProviderInfo[],
  series: SpendSeries[],
) {
  const reported = new Map(
    providers.map((p) => [p.provider_id, p.reported_cost_unit]),
  );
  const rates = new Map(
    series
      .filter((s) => s.primary_series && s.per_1000 != null)
      .map((s) => [s.provider, s]),
  );
  const units = new Set<string>();
  const prepared = rows.map((b) => {
    const provider = b.provider!,
      rate = rates.get(provider);
    const billedUnit = reported.get(provider) || `reported units (${provider})`;
    // Credits and plan units belong to a connection, not to a common currency.
    const rawUnit = rate?.unit ?? rate?.metric ?? "balance";
    const estimateUnit = currencies.has(rawUnit)
      ? rawUnit
      : `${rawUnit} (${provider})`;
    const estimate = allocatedSpend(rate, b.unpriced_tokens);
    if (b.cost != null) units.add(billedUnit);
    if (estimate !== null) units.add(estimateUnit);
    return { b, billedUnit, estimateUnit, estimate };
  });
  return {
    prepared,
    units: [...units].sort(
      (a, b) => Number(b === "USD") - Number(a === "USD") || a.localeCompare(b),
    ),
  };
}
export function makePivot(
  rows: ReturnType<typeof prepareCosts>["prepared"],
  unit: string,
  range: Window,
  bucket: number,
  selected: Window | null,
) {
  const origin = Math.floor(range.from / bucket) * bucket;
  const step =
    bucket * Math.max(1, Math.ceil((range.to - origin) / (160 * bucket)));
  const bins = Array.from(
    { length: Math.ceil((range.to - origin) / step) },
    (_, i) => ({
      from: Math.max(range.from, origin + i * step),
      to: Math.min(range.to, origin + (i + 1) * step),
      cell: emptyCell(),
    }),
  );
  const total = emptyCell(),
    groups = new Map<string, Cell>();
  for (const { b, billedUnit, estimateUnit, estimate } of rows) {
    const cell = emptyCell();
    Object.assign(cell, {
      attempts: b.attempts,
      input: b.input_tokens ?? 0,
      output: b.output_tokens ?? 0,
      inputs: b.input_reports,
      outputs: b.output_reports,
    });
    if (b.cost != null) {
      if (billedUnit === unit) {
        cell.reported = b.cost;
        cell.reportedCount = b.cost_reports;
      } else cell.outside += b.cost_reports;
    }
    if (estimate !== null) {
      if (estimateUnit === unit) {
        cell.estimated = estimate;
        cell.estimatedCount = b.estimable_attempts;
      } else cell.outside += b.estimable_attempts;
    }
    const bin = bins[Math.floor((b.bucket_unix - origin) / step)];
    if (!bin) continue;
    add(bin.cell, cell);
    add(total, cell);
    if (selected && (bin.from < selected.from || bin.to > selected.to))
      continue;
    const group = groups.get(b.group) ?? emptyCell();
    add(group, cell);
    groups.set(b.group, group);
  }
  return { total, groups, bins, step };
}
export function calendarDay(yesterday: boolean, now = new Date()): Window {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const to = yesterday ? +start / 1000 : Math.floor(+now / 60000) * 60 + 60;
  if (yesterday) start.setDate(start.getDate() - 1);
  return { from: +start / 1000, to };
}
export function localInput(unix: number) {
  const d = new Date(unix * 1000);
  return new Date(+d - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
const digits = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 6,
});
const integers = new Intl.NumberFormat();
export const number = (n: number | null) =>
  n === null
    ? "—"
    : Number.isInteger(n)
      ? integers.format(n)
      : digits.format(n);
export const cash = (n: number | null, unit: string) =>
  n == null ? "—" : `${number(n)} ${unit}`;
