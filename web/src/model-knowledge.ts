// A small shared cache for researched model cards. Model identity belongs to
// the core: each card answer carries `key` and `catalog_entries`, and the live
// catalog carries `knowledge_key` per row. The UI never computes a key — it
// caches by the upstream id it asked with and coalesces aliases using the
// core's own catalog_entries, so one card is fetched once per group.

import { useCallback, useSyncExternalStore } from "react";
import { api, type ModelKnowledge } from "./api";

export type KnowledgeState = {
  data: ModelKnowledge | null;
  error: string | null;
  loading: boolean;
};

const EMPTY: KnowledgeState = { data: null, error: null, loading: false };
const states = new Map<string, KnowledgeState>();
const listeners = new Map<string, Set<() => void>>();
const inFlight = new Map<string, Promise<void>>();

// upstream id -> the upstream id whose cached state it shares. Filled only
// from a card answer's catalog_entries, never from a client-side rule.
const aliases = new Map<string, string>();

// A page that filters or counts cards needs one subscription for all keys.
// It also re-renders hover targets when a new alias mapping arrives.
let version = 0;
const versionListeners = new Set<() => void>();
function subscribeVersion(listener: () => void) {
  versionListeners.add(listener);
  return () => {
    versionListeners.delete(listener);
  };
}
export function useKnowledgeVersion(): number {
  return useSyncExternalStore(subscribeVersion, () => version, () => 0);
}

function bumpVersion() {
  version += 1;
  versionListeners.forEach((listener) => listener());
}

/// Resolve an upstream id to the cache entry that already holds its card.
/// The mapping is learned from the core, so an alias never needs a second GET.
export function knowledgeId(upstreamId: string): string {
  return aliases.get(upstreamId) ?? upstreamId;
}

export function knowledgeSnapshot(upstreamId: string): KnowledgeState {
  return states.get(knowledgeId(upstreamId)) ?? EMPTY;
}

/// `key` is already resolved by the caller; resolving it again here could
/// follow an alias map that points at a different cached entry.
function update(key: string, patch: Partial<KnowledgeState>) {
  states.set(key, { ...(states.get(key) ?? EMPTY), ...patch });
  listeners.get(key)?.forEach((listener) => listener());
  bumpVersion();
}

function subscribe(upstreamId: string, listener: () => void) {
  const key = knowledgeId(upstreamId);
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(key);
  };
}

/// Register the aliases the core reported for a freshly loaded card. All
/// those ids share one cached answer; identities come from the API only.
function registerAliases(data: ModelKnowledge, primary: string) {
  let changed = false;
  for (const entry of data.catalog_entries) {
    const id = entry.upstream_id;
    if (id === primary || aliases.has(id) || states.has(id)) continue;
    aliases.set(id, primary);
    changed = true;
  }
  if (changed) bumpVersion();
}

/// Load a card on demand. Repeated calls while one request is in flight are
/// collapsed. A failed read keeps the error so a hover does not retry on
/// every mouse move; `force` explicitly retries (used after a collection).
export function ensureKnowledge(upstreamId: string, force = false): void {
  if (!upstreamId) return;
  const key = knowledgeId(upstreamId);
  const current = knowledgeSnapshot(key);
  if (current.loading || inFlight.has(key)) return;
  if (!force && (current.data !== null || current.error !== null)) return;

  update(key, { loading: true, error: null });
  const job = api
    .modelKnowledge(upstreamId)
    .then((data) => {
      registerAliases(data, key);
      update(key, { data, error: null, loading: false });
    })
    .catch((failure: unknown) =>
      update(key, {
        loading: false,
        error: failure instanceof Error ? failure.message : String(failure),
      }),
    )
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, job);
}

/// Drop a cached card after a successful collection so the next read shows
/// the new one. Nothing is guessed locally.
export function invalidateKnowledge(upstreamId: string) {
  const key = knowledgeId(upstreamId);
  states.delete(key);
  listeners.get(key)?.forEach((listener) => listener());
  bumpVersion();
}

/// Subscribe one component to the card of a model. The snapshot is a stable
/// object, which is what useSyncExternalStore needs; the version subscription
/// re-binds it when the core teaches us a new alias.
export function useKnowledge(upstreamId: string | null | undefined): KnowledgeState {
  useKnowledgeVersion();
  const key = upstreamId ? knowledgeId(upstreamId) : "";
  const listen = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  return useSyncExternalStore(
    listen,
    () => knowledgeSnapshot(key),
    () => EMPTY,
  );
}
