// Pure helpers for model-shaped strings. The core owns model identity: every
// catalog row carries `knowledge_key` and every card answer carries `key`.
// The UI treats those as opaque strings and never re-implements the core's
// normalization rule.
// The .ts extension keeps this module loadable by the Node self-checks.
import { canonicalVendor } from "./model-facts.ts";

/// Group API rows by the key the core assigned. No key is computed here.
export function groupByKnowledgeKey<T extends { knowledge_key: string }>(rows: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const list = groups.get(row.knowledge_key) ?? [];
    list.push(row);
    groups.set(row.knowledge_key, list);
  }
  return groups;
}

/// Usage groups by "provider/upstream_id" for the model grouping. The id may
/// itself contain slashes, so only the first one separates the provider.
export function splitModelGroup(group: string): { providerId: string; upstreamId: string } | null {
  const at = group.indexOf("/");
  if (at <= 0 || at === group.length - 1) return null;
  return { providerId: group.slice(0, at), upstreamId: group.slice(at + 1) };
}

/// Balance resources are usually accounts ("credits", "subscription"). Only
/// model-shaped resources get a knowledge hover; a hover on "account" would
/// be noise.
export function looksLikeModelId(resource: string): boolean {
  if (resource.includes("/") || resource.includes(":") || /^cursor-/i.test(resource)) return true;
  return /[0-9]/.test(resource);
}

/// Sources come from a researched card, so only http(s) links are rendered.
/// Anything else (javascript:, data:, garbage) is shown as plain text.
export function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// By canonical vendor, so every spelling of one vendor gets one colour.
const VENDOR_COLORS: [string, string][] = [
  ["Anthropic", "orange"],
  ["OpenAI", "teal"],
  ["Google", "blue"],
  ["DeepSeek", "indigo"],
  ["Z.ai", "cyan"],
  ["Alibaba", "violet"],
  ["Moonshot AI", "grape"],
  ["Meta", "pink"],
  ["xAI", "yellow"],
  ["NVIDIA", "green"],
  ["Microsoft", "lime"],
];
const PALETTE = ["teal", "blue", "grape", "cyan", "orange", "violet", "pink", "green"];

/// A stable badge colour for a vendor. Vendors the list does not name still
/// get a stable colour from their name instead of an arbitrary one.
export function vendorColor(vendor: string | null | undefined): string {
  if (!vendor) return "gray";
  const name = canonicalVendor(vendor) ?? vendor;
  const hit = VENDOR_COLORS.find(([known]) => known === name);
  if (hit) return hit[1];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return PALETTE[hash % PALETTE.length];
}
