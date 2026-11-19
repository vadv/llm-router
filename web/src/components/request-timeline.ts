import type { RequestActivity } from "../api";

export type CallInterval = { from: number; to: number };

// Only a successful report supplies the time domain. Missing bins inside it mean no saved calls.
export function callTimeline(report: RequestActivity) {
  const { from_unix: from, to_unix: to, step_secs: step } = report;
  if (from === null || to <= from || step <= 0) return [];
  const base = Math.floor(from / step) * step;
  const rows = new Map(report.buckets.map((b) => [b.start, b]));
  return Array.from({ length: Math.ceil((to - base) / step) }, (_, i) => {
    const start = base + i * step,
      b = rows.get(start);
    return {
      start,
      from: Math.max(from, start),
      to: Math.min(to, start + step),
      total: b?.total ?? 0,
      ok: b?.ok ?? 0,
      errors: b?.errors ?? 0,
      cancels: b?.cancels ?? 0,
      other: b ? b.total - b.ok - b.errors - b.cancels : 0,
      retried: b?.retried ?? 0,
      open: start <= report.as_of_unix && start + step > report.as_of_unix + 1,
    };
  });
}
