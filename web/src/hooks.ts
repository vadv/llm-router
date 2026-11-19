// Shared client behaviour: the refresh cadence, polling resources, the hash
// router, and a one-second clock for relative times.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError } from "./api";

// ---- Refresh cadence: one control in the header, used by every page. ----

const CADENCE_STORAGE = "llm-router.cadence";
export const CADENCES = [0, 5_000, 10_000, 30_000] as const;

let cadence = readStoredCadence();
const cadenceListeners = new Set<() => void>();

function readStoredCadence(): number {
  const stored = Number(localStorage.getItem(CADENCE_STORAGE));
  return (CADENCES as readonly number[]).includes(stored) ? stored : 10_000;
}

export function setCadence(next: number) {
  cadence = next;
  localStorage.setItem(CADENCE_STORAGE, String(next));
  cadenceListeners.forEach((listener) => listener());
}

function subscribeCadence(listener: () => void) {
  cadenceListeners.add(listener);
  return () => cadenceListeners.delete(listener);
}

export function useCadence(): number {
  return useSyncExternalStore(subscribeCadence, () => cadence);
}

// ---- Resources ----

export type Resource<T> = {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  updatedAt: number | null;
  reload: () => void;
};

/// Fetch now, then again on the shared cadence while the tab is visible.
/// A failed poll keeps the last good data and shows the error instead.
export function usePoll<T>(load: () => Promise<T>, deps: unknown[] = [], poll = true): Resource<T> {
  const interval = useCadence();
  const [state, setState] = useState<{
    data: T | undefined;
    error: string | null;
    loading: boolean;
    updatedAt: number | null;
  }>({ data: undefined, error: null, loading: true, updatedAt: null });
  const generation = useRef(0);
  // The loader closes over page-local state; deps decide when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const refresh = useCallback(async () => {
    const ticket = ++generation.current;
    try {
      const data = await run();
      if (generation.current === ticket) {
        setState({ data, error: null, loading: false, updatedAt: Date.now() });
      }
    } catch (error) {
      if (generation.current === ticket) {
        setState((previous) => ({
          ...previous,
          loading: false,
          error: error instanceof ApiError ? error.message : String(error),
        }));
      }
    }
  }, [run]);

  useEffect(() => {
    void refresh();
    const timer = poll && interval > 0 ? window.setInterval(() => !document.hidden && void refresh(), interval) : null;
    const onVisible = () => !document.hidden && void refresh();
    if (poll) document.addEventListener("visibilitychange", onVisible);
    return () => {
      generation.current += 1;
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, interval, poll]);

  return { ...state, reload: refresh };
}

/// Re-render once a second so "12s ago" stays true.
export function useNow(stepMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs);
    return () => window.clearInterval(timer);
  }, [stepMs]);
  return now;
}

// ---- Hash router: one URL per tab, browser back/forward keeps working. ----

export const ROUTES = [
  "overview",
  "usage",
  "balances",
  "providers",
  "pools",
  "history",
  "activity",
  "wiki",
  "chat",
] as const;
export type Route = (typeof ROUTES)[number];

export function routeParam(name: string): string | null {
  return new URLSearchParams(window.location.hash.split("?")[1]).get(name) || null;
}

function readRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "").split("?")[0];
  return (ROUTES as readonly string[]).includes(raw) ? (raw as Route) : "overview";
}

function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const navigate = useCallback((next: Route) => {
    window.location.hash = `#/${next}`;
  }, []);
  return { route: readRoute(hash), hash, navigate };
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · llm-router`;
  }, [title]);
}