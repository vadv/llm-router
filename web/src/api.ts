// Typed access to the core HTTP API. Data calls carry the client key from
// browser storage; the static files themselves are public and hold no key.

import { mockApi } from "./mock";

const KEY_LOCAL = "llm-router.key";
const KEY_SESSION = "llm-router.key.session";

export const keyStore = {
  scope(): "browser" | "tab" | null {
    if (localStorage.getItem(KEY_LOCAL)) return "browser";
    return sessionStorage.getItem(KEY_SESSION) ? "tab" : null;
  },
  get(): string | null {
    return localStorage.getItem(KEY_LOCAL) ?? sessionStorage.getItem(KEY_SESSION);
  },
  save(key: string, persist: boolean) {
    keyStore.clear();
    (persist ? localStorage : sessionStorage).setItem(persist ? KEY_LOCAL : KEY_SESSION, key);
  },
  clear() {
    localStorage.removeItem(KEY_LOCAL);
    sessionStorage.removeItem(KEY_SESSION);
  },
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/// Called when the core rejects the presented key, so the shell can ask for it again.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: (() => void) | null) {
  onUnauthorized = handler;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = keyStore.get();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, "core is unreachable");
  }

  if (response.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "key rejected by the core");
  }
  if (!response.ok) {
    throw new ApiError(response.status, await errorMessage(response));
  }
  if (response.status === 204) return undefined as T;
  // A pool replace answers 200 with no body.
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// Two error shapes exist: management returns {error: "text"}, inference
// returns {error: {type, message}}. Neither may leak a credential.
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text || `HTTP ${response.status}`;
}

// ---- Shapes returned by the core. Null means "not reported", never zero. ----

export type Member = { provider_id: string; upstream_id: string };
export type Pool = { name: string; members: Member[] };

export type RefreshStatus = { last_success_unix: number | null; last_error: string | null };
export type LocalState = { model: string; loaded: boolean | null; slots: number | null; busy: number | null };
export type ProviderInfo = {
  reported_cost_unit?: string | null;
  provider_id: string;
  catalog: "dynamic" | "static";
  last_refresh: RefreshStatus | null;
  local_state: LocalState | null;
};

export type ProviderModel = {
  upstream_id: string;
  context_tokens: number | null;
  observed_at_unix: number;
};

// ---- Researched model cards (knowledge.sqlite). One card serves every ----
// ---- provider and alias of the same normalized knowledge key. ----

export type KnowledgeRating = {
  source: string;
  metric: string;
  value: number;
  as_of: string | null;
  note: string | null;
  /// The page that shows this number, when the researcher cited one.
  url?: string | null;
};

/// List prices per one million tokens, as the newer research schema reports
/// them. Older cards carry only the `pricing_hint` sentence.
export type KnowledgePricing = {
  currency: string | null;
  input_per_1m: number | null;
  cached_input_per_1m: number | null;
  output_per_1m: number | null;
  note: string | null;
};

/// Measured speed, with who measured it.
export type KnowledgeSpeed = {
  output_tokens_per_second: number | null;
  time_to_first_token_seconds: number | null;
  source: string | null;
  as_of: string | null;
};

export type KnowledgeCard = {
  canonical_name: string | null;
  vendor: string | null;
  release_date: string | null;
  description: string;
  use_cases: string[];
  strengths: string[];
  weaknesses: string[];
  modality: string | null;
  context_window: number | null;
  pricing_hint: string | null;
  ratings: KnowledgeRating[];
  family_line: string | null;
  sources: string[];
  // Added by the second research schema; absent (or null) on older cards.
  pricing?: KnowledgePricing | null;
  input_modalities?: string[] | null;
  output_modalities?: string[] | null;
  max_output_tokens?: number | null;
  parameters?: string | null;
  license?: string | null;
  open_weights?: boolean | null;
  knowledge_cutoff?: string | null;
  reasoning?: "always" | "optional" | "none" | null;
  tool_calling?: boolean | null;
  structured_output?: boolean | null;
  /// What an alias or a moving pointer serves, e.g. "GLM-5.3-20260930".
  snapshot?: string | null;
  /// What the model is for, from a fixed vocabulary.
  tags?: string[] | null;
  speed?: KnowledgeSpeed | null;
};

export type ModelSummary = Pick<KnowledgeCard, "canonical_name" | "vendor" | "release_date" | "ratings"> &
  // A core that predates a field leaves it out.
  Partial<
    Pick<
      KnowledgeCard,
      | "context_window"
      | "max_output_tokens"
      | "input_modalities"
      | "output_modalities"
      | "license"
      | "open_weights"
      | "pricing"
      | "pricing_hint"
      | "tags"
      | "speed"
    >
  > & {
  key: string;
  description: string | null;
  primary_use?: string | null;
  modality?: string | null;
};
export type CatalogEntry = { provider_id: string; upstream_id: string };

/// A live catalog row. `knowledge_key` is the core's normalized model name;
/// different providers and :free aliases of one model share it.
export type LiveCatalogModel = CatalogEntry & {
  context_tokens: number | null;
  knowledge_key: string;
  observed_at_unix?: number;
};

/// GET answer. `card` is null when nothing has been researched yet; GET
/// never calls an upstream, so it is safe to use from a hover.
export type ModelKnowledge = {
  key: string;
  card: KnowledgeCard | null;
  collected_at_unix: number | null;
  /// What produced the card, e.g. "deepseek/deepseek-flash+websearch".
  generator?: string | null;
  fresh: boolean;
  max_age_secs: number;
  catalog_entries: CatalogEntry[];
};

/// POST answer. A fresh card skips research with `reason: "fresh"`.
export type CollectKnowledgeResult = {
  key: string;
  collected: boolean;
  reason?: string;
  collected_at_unix?: number;
  card?: KnowledgeCard | null;
  repairs?: string[];
  catalog_entries?: CatalogEntry[];
};

export type CollectKnowledgeQuery = {
  providerId: string;
  upstreamId: string;
  force?: boolean;
};

/// Progress of "research every card". The job runs on the core, so it
/// outlives the page that started it; `done` reaches `total` either way.
export type ResearchStatus = {
  running: boolean;
  total: number;
  done: number;
  updated: number;
  failed: number;
  skipped: number;
  /// Keys being researched right now.
  current: string[];
  /// The most recent failures; the event log has them all.
  errors: { key: string; error: string }[];
  cancel_requested: boolean;
  started_at_unix: number | null;
  finished_at_unix: number | null;
};

export const IDLE_RESEARCH: ResearchStatus = {
  running: false,
  total: 0,
  done: 0,
  updated: 0,
  failed: 0,
  skipped: 0,
  current: [],
  errors: [],
  cancel_requested: false,
  started_at_unix: null,
  finished_at_unix: null,
};

export type Observation = {
  provider_id: string;
  resource: string;
  metric: string;
  unit: string | null;
  limit: string | null;
  usage: string | null;
  remaining: string | null;
  window: string | null;
  resets_at_unix: number | null;
  observed_at_unix: number;
};

export type Attempt = {
  duration_ms?: number | null;
  provider_id: string;
  upstream_id: string;
  started_at_unix: number;
  finished_at_unix: number | null;
  result: string | null;
  error: string | null;
  switch_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /// Reported cost, only when the upstream sent a numeric field. Null when
  /// nobody reported it: the router holds no prices of its own.
  cost: number | null;
  response_preview: string | null;
  response_truncated: boolean;
  // The core sends tool_count/tool_names; unknown tool data stays null.
  tool_count: number | null;
  tool_names: string[] | null;
  tool_names_truncated: boolean;
  tool_list_truncated: boolean;
  issues: string[] | null;
};

export type RequestRecord = {
  id: string;
  metamodel: string;
  key_alias: string;
  started_at_unix: number;
  finished_at_unix: number | null;
  outcome: string | null;
  /// First 80 characters of the request text, as the client sent it.
  /// Sensitive; the full body is not stored.
  input_preview: string | null;
  input_truncated: boolean;
  declared_tools: number | null;
  issues: string[] | null;
  attempts: Attempt[];
};

/// Server-side history query. `before_id` is the cursor for older pages.
export type RequestBucket = { start: number; total: number; ok: number; errors: number; cancels: number; retried: number; peak_per_minute: number; first_start: number; last_start: number };
export type RequestActivity = { from_unix: number | null; to_unix: number; as_of_unix: number; step_secs: number; buckets: RequestBucket[] };
export type RequestQuery = {
  family?: string;
  attemptWindow?: boolean;
  toUnix?: number;
  limit: number;
  beforeId?: string;
  provider?: string;
  model?: string;
  sinceUnix?: number;
  metamodel?: string;
  keyAlias?: string;
  outcome?: string;
};

export type Ban = {
  provider_id: string;
  upstream_id: string;
  reason: string;
  expires_at_unix: number;
};

/// One line of the core event log. `detail` is whatever JSON the core wrote.
export type EventRecord = {
  id: number;
  ts_unix: number;
  kind: string;
  provider_id: string | null;
  detail: unknown;
};

export type RefreshWhat = "all" | "catalog" | "balances";

export type ComponentHealth = { ok: boolean; detail?: string; count?: number };
export type Health = {
  status: "ok" | "degraded";
  uptime_unix: number;
  components: {
    catalog?: ComponentHealth;
    balances?: ComponentHealth;
    events?: ComponentHealth;
    knowledge?: ComponentHealth;
    requests?: ComponentHealth;
    providers?: ComponentHealth;
    schedule?: ComponentHealth & { providers?: Record<string, RefreshStatus> };
  };
};

export type MetaModel = { id: string; context_length?: number };
/// Which series a history read wants. An empty `window` selects the series
/// that report no window at all (an account balance with no reset).
export type ObservationQuery = {
  providerId: string;
  resource?: string;
  metric?: string;
  window?: string;
  unit?: string;
  sinceUnix?: number;
  limit?: number;
};
export type UsageGroupBy = "provider" | "model" | "family" | "metamodel" | "key";
export type UsageFilters = Partial<Record<"provider" | "model" | "family" | "key" | "pool", string>>;
export type UsagePeriod = { sinceUnix?: number; toUnix?: number };
export type UsageQuery = UsagePeriod & UsageFilters & {
  bucket: "minute" | "hour" | "day";
  splitProvider?: boolean;
  groupBy: UsageGroupBy;
  limit?: number;
};
/// One bucket of one group. `requests` counts client calls, `attempts` counts
/// upstream calls, so a failover stays visible. Token sums are null when no
/// attempt in the bucket reported tokens; `unknown_tokens` counts those
/// attempts, so an unknown amount never reads as a real zero. `cost` is only
/// what the upstream reported as a number, and `cost_reports` says how many
/// attempts reported it.
export type UsageStats = {
  ok: number;
  cancels: number;
  input_reports: number;
  output_reports: number;
  mean_duration_ms: number | null;
  duration_reports: number;
  output_tps: number | null;
  speed_reports: number;
  requests: number;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  errors: number;
  unknown_tokens: number;
  cost: number | null;
  cost_reports: number;
  estimable_attempts: number;
  unpriced_tokens: number | null;
};

export type UsageBucket = UsageStats & { bucket_unix: number; group: string; provider?: string };

export type SpendSeries = {
  provider: string; resource: string; metric: string; unit: string | null; window: string | null;
  primary_series?: boolean; per_1000?: number | null; intervals?: number; tokens?: number;
  first_observed_unix?: number; last_observed_unix?: number; note?: string;
};
export type SpendPage = { series: SpendSeries[]; truncated: boolean };

/// One page of buckets. `truncated` means the range holds more rows than the
/// limit: the buckets are the newest ones and their sums are not range
/// totals. `calls` is the distinct client calls of the whole range; summing
/// the per-group `requests` would count a failover twice.
export type UsagePage = {
  buckets: UsageBucket[];
  totals: UsageStats;
  unpriced_by_provider: Record<string, number>;
  unpriced_providers_truncated: boolean;
  bucket_seconds: number;
  truncated: boolean;
  calls: number;
};

async function healthCall(): Promise<Health> {
  // The core answers 503 with the same body while a component is down.
  const key = keyStore.get();
  const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
  let response: Response;
  try {
    response = await fetch("/health", { headers });
  } catch {
    throw new ApiError(0, "core is unreachable");
  }
  const text = await response.text();
  let body: Health | undefined;
  try {
    body = JSON.parse(text) as Health;
  } catch {
    body = undefined;
  }
  if (!body || !body.status || !body.components) {
    throw new ApiError(response.status, text || `HTTP ${response.status}`);
  }
  return body;
}

export type Api = {
  health: () => Promise<Health>;
  pools: () => Promise<Pool[]>;
  putPool: (name: string, members: Member[], createOnly?: boolean) => Promise<void>;
  deletePool: (name: string) => Promise<void>;
  providers: () => Promise<ProviderInfo[]>;
  providerModels: (providerId: string) => Promise<ProviderModel[]>;
  observations: (providerId?: string) => Promise<Observation[]>;
  observationHistory: (query: ObservationQuery) => Promise<Observation[]>;
  usage: (query: UsageQuery) => Promise<UsagePage>;
  usageSpend: (provider: string | undefined, period: UsagePeriod) => Promise<SpendPage>;
  requests: (query: RequestQuery) => Promise<RequestRecord[]>;
  requestActivity: (filters: Partial<RequestQuery>, period: string) => Promise<RequestActivity>;
  refresh: (what: RefreshWhat) => Promise<Record<string, RefreshStatus>>;
  bans: () => Promise<Ban[]>;
  events: (limit?: number) => Promise<EventRecord[]>;
  models: () => Promise<MetaModel[]>;
  catalog: () => Promise<LiveCatalogModel[]>;
  modelSummaries: (keys: string[], signal?: AbortSignal) => Promise<ModelSummary[]>;
  modelKnowledge: (upstreamId: string) => Promise<ModelKnowledge>;
  collectKnowledge: (query: CollectKnowledgeQuery) => Promise<CollectKnowledgeResult>;
  researchStatus: () => Promise<ResearchStatus>;
  startResearch: (force: boolean) => Promise<ResearchStatus>;
  cancelResearch: () => Promise<ResearchStatus>;
};

function usagePeriodParams(period: UsagePeriod): URLSearchParams {
  const params = new URLSearchParams();
  if (period.sinceUnix !== undefined) params.set("since_unix", String(period.sinceUnix));
  if (period.toUnix !== undefined) params.set("to_unix", String(period.toUnix));
  return params;
}

function requestSelection(query: Partial<RequestQuery>) {
  const params = new URLSearchParams();
  if (query.provider) params.set("provider", query.provider);
  if (query.model) params.set("model", query.model);
  if (query.family) params.set("family", query.family);
  if (query.attemptWindow) params.set("attempt_window", "1");
  if (query.metamodel) params.set("metamodel", query.metamodel);
  if (query.keyAlias) params.set("key_alias", query.keyAlias);
  if (query.outcome) params.set("outcome", query.outcome);
  return params;
}

const realApi: Api = {
  health: healthCall,

  pools: () => call<{ pools: Pool[] }>("/v1/management/pools").then((r) => r.pools),
  putPool: (name: string, members: Member[], createOnly = false) =>
    call<void>(`/v1/management/pools/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: createOnly ? { "If-None-Match": "*" } : undefined,
      body: JSON.stringify({ members }),
    }),
  deletePool: (name: string) =>
    call<void>(`/v1/management/pools/${encodeURIComponent(name)}`, { method: "DELETE" }),

  providers: () => call<{ providers: ProviderInfo[] }>("/v1/management/providers").then((r) => r.providers),
  providerModels: (providerId: string) =>
    call<{ models: ProviderModel[] }>(
      `/v1/management/providers/${encodeURIComponent(providerId)}/models`,
    ).then((r) => r.models),

  observations: (providerId?: string) =>
    call<{ observations: Observation[] }>(
      `/v1/management/observations${providerId ? `?provider_id=${encodeURIComponent(providerId)}` : ""}`,
    ).then((r) => r.observations),

  requests: (query: RequestQuery) => {
    const params = requestSelection(query);
    params.set("limit", String(query.limit));
    if (query.beforeId) params.set("before_id", query.beforeId);
    if (query.sinceUnix !== undefined) params.set("since_unix", String(query.sinceUnix));
    if (query.toUnix !== undefined) params.set("to_unix", String(query.toUnix));
    return call<{ requests: RequestRecord[] }>(`/v1/management/requests?${params}`).then(
      (r) => r.requests,
    );
  },

  requestActivity: (query, period) => {
    const params = requestSelection(query);
    if (query.sinceUnix !== undefined && query.toUnix !== undefined) {
      params.set("since_unix", String(query.sinceUnix));
      params.set("to_unix", String(query.toUnix));
    } else params.set("period", period);
    return call<RequestActivity>(`/v1/management/requests/activity?${params}`);
  },

  observationHistory: (query: ObservationQuery) => {
    const params = new URLSearchParams({
      provider_id: query.providerId,
      limit: String(query.limit ?? 500),
    });
    if (query.resource !== undefined) params.set("resource", query.resource);
    if (query.metric !== undefined) params.set("metric", query.metric);
    // An empty window or unit is meaningful: it selects the series without one.
    if (query.window !== undefined) params.set("window", query.window);
    if (query.unit !== undefined) params.set("unit", query.unit);
    if (query.sinceUnix !== undefined) params.set("since_unix", String(query.sinceUnix));
    return call<{ observations: Observation[] }>(`/v1/management/observations?${params}`).then(
      (r) => r.observations,
    );
  },

  usage: (query: UsageQuery) => {
    const params = usagePeriodParams(query);
    params.set("bucket", query.bucket);
    params.set("group_by", query.groupBy);
    params.set("limit", String(query.limit ?? 2000));
    if (query.splitProvider) params.set("split_provider", "1");
    for (const name of ["provider", "model", "family", "key", "pool"] as const) {
      if (query[name]) params.set(name, query[name]);
    }
    return call<UsagePage>(`/v1/management/usage?${params}`);
  },

  usageSpend: (provider, period) => {
    const params = usagePeriodParams(period);
    if (provider) params.set("provider", provider);
    return call<SpendPage>(`/v1/management/usage/spend?${params}`);
  },

  refresh: (what: RefreshWhat) =>
    call<{ refresh: Record<string, RefreshStatus> }>("/v1/management/refresh", {
      method: "POST",
      body: JSON.stringify({ what }),
    }).then((r) => r.refresh),

  bans: () => call<{ bans: Ban[] }>("/v1/management/bans").then((r) => r.bans),

  events: (limit = 100) =>
    call<{ events: EventRecord[] }>(`/v1/management/events?limit=${limit}`).then((r) => r.events),

  models: () => call<{ data: MetaModel[] }>("/v1/models").then((r) => r.data),

  catalog: () => call<{ models: LiveCatalogModel[] }>("/v1/management/models").then((r) => r.models),

  modelSummaries: (keys, signal) =>
    call<{ cards: ModelSummary[] }>("/v1/management/models/knowledge/summaries",
      {method: "POST", body: JSON.stringify(keys), signal}).then(r => r.cards),

  modelKnowledge: (upstreamId: string) =>
    call<ModelKnowledge>(
      `/v1/management/models/knowledge?upstream_id=${encodeURIComponent(upstreamId)}`,
    ),

  collectKnowledge: ({ providerId, upstreamId, force = false }: CollectKnowledgeQuery) =>
    call<CollectKnowledgeResult>("/v1/management/models/knowledge", {
      method: "POST",
      body: JSON.stringify({ provider_id: providerId, upstream_id: upstreamId, force }),
    }),

  researchStatus: () => call<ResearchStatus>("/v1/management/models/knowledge/research"),
  startResearch: (force: boolean) =>
    call<ResearchStatus>("/v1/management/models/knowledge/research", {
      method: "POST",
      body: JSON.stringify({ force }),
    }),
  cancelResearch: () =>
    call<ResearchStatus>("/v1/management/models/knowledge/research", { method: "DELETE" }),
};

/// Mock mode serves the same shapes from memory so the UI can be designed
/// without a core. It never reaches the network and holds no credentials.
export const MOCK =
  import.meta.env.VITE_MOCK === "1" ||
  // The SSR self-checks import this module without a window.
  (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mock"));

export const api: Api = MOCK ? mockApi : realApi;