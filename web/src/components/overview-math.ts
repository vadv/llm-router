import type { Ban, Pool, RequestRecord, UsageBucket } from "../api";

export const PERIODS = { "1h": 3600, "24h": 86400, "7d": 604800 } as const;
export type Period = keyof typeof PERIODS;

export function overviewPeriod(value: string | null): Period {
  return value && Object.hasOwn(PERIODS, value) ? (value as Period) : "24h";
}

// A member not on the ban list is not proof that an upstream can serve a call.
export function poolCoverage(pools: Pool[], bans: Ban[]) {
  const memberId = (provider: string, model: string) => JSON.stringify([provider, model]);
  const blocked = new Set(bans.map((b) => memberId(b.provider_id, b.upstream_id)));
  return pools
    .map((pool) => ({
      name: pool.name,
      total: pool.members.length,
      free: pool.members.filter((m) => !blocked.has(memberId(m.provider_id, m.upstream_id))).length,
    }))
    .sort(
      (a, b) =>
        Number(a.free !== 0) - Number(b.free !== 0) ||
        Number(a.free === a.total) - Number(b.free === b.total) ||
        a.name.localeCompare(b.name),
    );
}

export function recentOutcomes(rows: RequestRecord[]) {
  const finished = rows.filter((row) => row.outcome !== null);
  const ok = finished.filter((row) => row.outcome === "ok").length;
  const errors = finished.filter((row) => row.outcome === "error").length;
  const cancels = finished.filter((row) => row.outcome === "client_cancel").length;
  return {
    count: finished.length,
    ok,
    errors,
    cancels,
    rate: finished.length ? (100 * ok) / finished.length : null,
  };
}

// Bucket boundaries are UTC hours. Only fill idle hours for a complete result.
export function trafficHours(buckets: UsageBucket[], start: number, end: number) {
  const hours = new Map<number, { unix: number; attempts: number; errors: number }>();
  for (let unix = Math.floor(start / 3600) * 3600; unix < end; unix += 3600) {
    hours.set(unix, { unix, attempts: 0, errors: 0 });
  }
  for (const bucket of buckets) {
    const hour = hours.get(bucket.bucket_unix);
    if (hour) {
      hour.attempts += bucket.attempts;
      hour.errors += bucket.errors;
    }
  }
  return [...hours.values()];
}
