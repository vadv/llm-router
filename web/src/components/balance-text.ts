import type { Observation } from "../api";
import { compact, money } from "../format";

/// How a reading's amounts are written: percent for a ratio, the unit the
/// connection named, and nothing for money besides its currency.
export function unitOf(row: Observation): string {
  if (row.metric === "ratio") return "%";
  if (row.unit === "token" || row.unit === "request") return `${row.unit}s`;
  return row.unit ?? (row.metric === "money" ? "" : row.metric);
}

/// An amount as the connection reports it: money with its decimals, the
/// rest compact.
export const numberOf = (row: Observation, n: number): string =>
  row.metric === "money" || ["CNY", "USD"].includes(row.unit ?? "")
    ? money(n)
    : compact(n);
