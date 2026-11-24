// Display helpers. Times arrive as unix seconds; nothing here invents data.

import type { Attempt } from "./api";

/// Badge colors for the event kinds the core emits. Keep one list so a new
/// kind does not get a gray badge on one page and a colored one on another.
export const EVENT_KIND_COLOR: Record<string, string> = {
  ban_recorded: "orange",
  ban_expired: "teal",
  catalog_error: "red",
  balance_error: "red",
  server_started: "grape",
  model_switch: "indigo",
  all_models_failed: "red",
  knowledge_card: "teal",
  knowledge_error: "red",
  retention_purged: "gray",
};

export function ago(unixSeconds: number | null | undefined, now: number): string {
  if (unixSeconds === null || unixSeconds === undefined || unixSeconds <= 0) return "never";
  const seconds = Math.round(now / 1000 - unixSeconds);
  // Bans and quotas expire in the future, so the same scale reads forward.
  if (seconds < -5) return `in ${duration(-seconds)}`;
  if (seconds < 5) return "just now";
  return `${duration(seconds)} ago`;
}

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.round(days / 30)}mo`;
}

export function clock(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) return "—";
  return new Date(unixSeconds * 1000).toLocaleString([], { hour12: false });
}

/// Wall time between two unix-second instants; null when the end is unknown.
export function span(start: number, end: number | null): string | null {
  if (end === null) return null;
  const ms = Math.max(0, (end - start) * 1000);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function uptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/// Time left to a job that keeps its pace. Nothing until a few units are
/// done: after one, the figure swings too much to be worth reading.
export function eta(
  startedUnix: number | null | undefined,
  done: number,
  total: number,
  nowUnix: number = Math.floor(Date.now() / 1000),
): string | null {
  if (!startedUnix || done < 5 || total <= done) return null;
  const seconds = Math.round(((total - done) * Math.max(1, nowUnix - startedUnix)) / done);
  return `about ${uptime(seconds)} left`;
}

const SCALES = ["", "K", "M", "B", "T"];

/// A count as short as it reads: "943K", "9.43B", never "9426.5M".
export function compact(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const abs = Math.abs(value);
  if (abs < 1000) {
    if (abs >= 1) return value.toFixed(2).replace(/\.?0+$/, "");
    return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  let scale = 0;
  while (abs >= 1000 ** (scale + 1) && scale < SCALES.length - 1) scale += 1;
  // Three digits that matter, whatever the size: 943, 94.3, 9.43.
  const scaled = value / 1000 ** scale;
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  const text = scaled.toFixed(digits);
  // Only a fraction loses its zeros: "10M" must not become "1M".
  return `${digits > 0 ? text.replace(/0+$/, "").replace(/\.$/, "") : text}${SCALES[scale]}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// "Nov 13, 2025" from a day, "Nov 2025" from a month, "—" from nothing.
export function dateLabel(date: string | null | undefined): string {
  if (!date || !/^\d{4}-\d{2}(-\d{2})?$/.test(date)) return "—";
  const [year, month, day] = date.split("-");
  const name = MONTHS[Number(month) - 1];
  return name ? `${name}${day ? ` ${Number(day)},` : ""} ${year}` : "—";
}

/// A score as the card wrote it: 92, 84.5, 0.039.
export function scoreText(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  return value.toFixed(Math.abs(value) < 1 ? 3 : Math.abs(value) < 10 ? 2 : 1);
}

export function contextWindow(tokens: number | null | undefined): string {
  if (!tokens) return "unknown";
  // 1,048,576 reads "1M", 262,144 reads "262K": two digits, no false precision.
  if (tokens >= 999_500) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/// Amounts from the core are upstream strings; keep them as text unless a
/// progress bar needs a ratio.
export function ratio(used: string | null, limit: string | null): number | null {
  const usedValue = used === null ? NaN : Number(used);
  const limitValue = limit === null ? NaN : Number(limit);
  if (!Number.isFinite(usedValue) || !Number.isFinite(limitValue) || limitValue <= 0) return null;
  return Math.min(100, Math.max(0, (usedValue / limitValue) * 100));
}/// Money keeps the cents the upstream reported; only sub-cent amounts need more digits.
/// need the four decimals the driver sends.
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs > 0 && abs < 0.0001) return value.toPrecision(2);
  if (abs !== 0 && abs < 0.01) return value.toFixed(4);
  return value.toFixed(2);
}

/// Tokens per second: output_tokens divided by wall-clock duration.
/// Only meaningful for completed attempts with output tokens and >0 duration.
export function tps(attempt: Attempt): number | null {
  if (
    attempt.finished_at_unix === null ||
    attempt.output_tokens === null ||
    attempt.output_tokens < 0
  ) {
    return null;
  }
  const seconds = attempt.duration_ms == null
    ? attempt.finished_at_unix - attempt.started_at_unix
    : attempt.duration_ms / 1000;
  if (seconds <= 0) return null;
  return attempt.output_tokens / seconds;
}

/// Format TPS as a string: "42.3" or "—".
export function tpsFormat(attempt: Attempt): string {
  const value = tps(attempt);
  if (value === null) return "—";
  if (value < 10) return value.toFixed(1);
  if (value < 100) return value.toFixed(0);
  return Math.round(value).toString();
}

/// Extract a numeric cost from usage_extra, if the upstream reported one.
/// OpenRouter sends { cost: number }; other upstreams may vary.
export function usageCost(attempt: Attempt): number | null {
  return attempt.cost;
}

/// Pretty-print a JSON string with indentation. Falls back to the raw
/// string if it is not valid JSON.
export function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
