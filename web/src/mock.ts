// In-memory stand-in for the core, for design work and UI screenshots.
// Enable with ?mock=1 in the URL or VITE_MOCK=1 at build time.
// Values are plausible, not recorded: never treat them as real usage.

import {
  cancelMockResearch,
  catalogRows,
  maxAgeDays,
  mockCard,
  mockCollectedAt,
  mockKey,
  mockJobInProgress,
  mockResearch,
  modelsByProvider,
  researchMockCard,
  startMockResearch,
} from "./mock-catalog";
import type {
  Api,
  Ban,
  EventRecord,
  Health,
  Member,
  MetaModel,
  Observation,
  Pool,
  ProviderInfo,
  RequestRecord,
  RequestQuery,
  RequestBucket,
  UsageBucket,
  UsageStats,
} from "./api";

const now = () => Math.floor(Date.now() / 1000);
const started = now() - 3 * 86400 - 4 * 3600;
const wait = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 140));

let pools: Pool[] = [
  {
    name: "fast",
    members: [
      { provider_id: "deepseek", upstream_id: "deepseek-chat" },
      { provider_id: "zai", upstream_id: "glm-4.6" },
    ],
  },
  {
    name: "coder",
    members: [
      { provider_id: "zai", upstream_id: "glm-4.6" },
      { provider_id: "llamacpp", upstream_id: "qwen3-coder-30b" },
      { provider_id: "deepseek", upstream_id: "deepseek-reasoner" },
    ],
  },
  { name: "cheap", members: [{ provider_id: "deepseek", upstream_id: "deepseek-chat" }] },
  {
    name: "vision",
    members: [
      { provider_id: "openai", upstream_id: "gpt-5.1" },
      { provider_id: "zai", upstream_id: "glm-4.5v" },
    ],
  },
];

const providers: ProviderInfo[] = [
  {
    provider_id: "deepseek",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 42, last_error: null },
    local_state: null,
  },
  {
    provider_id: "zai",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 96, last_error: null },
    local_state: null,
  },
  {
    provider_id: "llamacpp",
    catalog: "static",
    last_refresh: null,
    local_state: { model: "qwen3-coder-30b", loaded: true, slots: 2, busy: 1 },
  },
  {
    provider_id: "openai",
    catalog: "static",
    last_refresh: null,
    local_state: null,
  },
  {
    provider_id: "openrouter",
    reported_cost_unit: "USD",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 120, last_error: null },
    local_state: null,
  },
  {
    provider_id: "alibaba",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 260, last_error: null },
    local_state: null,
  },
  {
    provider_id: "opencode",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 70, last_error: null },
    local_state: null,
  },
  {
    provider_id: "tokenator",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 150, last_error: null },
    local_state: null,
  },
  {
    provider_id: "kimi",
    catalog: "dynamic",
    last_refresh: { last_success_unix: now() - 200, last_error: null },
    local_state: null,
  },
];

// The catalog and its researched cards live in their own module, shaped as
// the core reports them. Local engines list their model since startup.
const observedAt = (provider: string) =>
  provider === "llamacpp" || provider === "openai" ? started : now() - 96;
const catalogByProvider = modelsByProvider(observedAt);


const observations: Observation[] = [
  {
    provider_id: "zai",
    resource: "subscription",
    metric: "tokens",
    unit: "tokens",
    limit: "1500000",
    usage: "612400",
    remaining: "887600",
    window: "5h",
    resets_at_unix: now() + 2 * 3600 + 14 * 60,
    observed_at_unix: now() - 96,
  },
  {
    provider_id: "zai",
    resource: "subscription",
    metric: "requests",
    unit: null,
    limit: "600",
    usage: "88",
    remaining: "512",
    window: "5h",
    resets_at_unix: now() + 2 * 3600 + 14 * 60,
    observed_at_unix: now() - 96,
  },
  {
    provider_id: "deepseek",
    resource: "account",
    metric: "credits",
    unit: "USD",
    limit: null,
    usage: null,
    remaining: "18.42",
    window: null,
    resets_at_unix: null,
    observed_at_unix: now() - 42,
  },
  {
    provider_id: "openai",
    resource: "account",
    metric: "credits",
    unit: "USD",
    limit: null,
    usage: null,
    remaining: "4.10",
    window: null,
    resets_at_unix: null,
    observed_at_unix: now() - 300,
  },
  {
    provider_id: "zai",
    resource: "subscription",
    metric: "tokens",
    unit: "tokens",
    limit: "20000000",
    usage: "7400000",
    remaining: "12600000",
    window: "week",
    resets_at_unix: now() + 3 * 86400,
    observed_at_unix: now() - 96,
  },
  {
    provider_id: "openrouter",
    resource: "key",
    metric: "money",
    unit: "USD",
    limit: "50",
    usage: "12.4",
    remaining: "37.6",
    window: "monthly",
    resets_at_unix: now() + 12 * 86400,
    observed_at_unix: now() - 120,
  },
  {
    provider_id: "openrouter",
    resource: "credits",
    metric: "money",
    unit: "USD",
    limit: null,
    usage: "31.8",
    remaining: "8.2",
    window: null,
    resets_at_unix: null,
    observed_at_unix: now() - 120,
  },
  // One account counter that the driver copies onto every free model of the
  // catalog. The three rows are one value, not three: never sum them.
  ...["qwen/qwen3-coder:free", "z-ai/glm-4.5-air:free", "moonshotai/kimi-k2.5:free"].map(
    (model): Observation => ({
      provider_id: "openrouter",
      resource: model,
      metric: "requests",
      unit: null,
      limit: "50",
      usage: "37",
      remaining: "13",
      window: "daily",
      resets_at_unix: now() + 6 * 3600,
      observed_at_unix: now() - 120,
    }),
  ),
];

const requests: RequestRecord[] = [
  {
    id: "r_8f21c4",
    metamodel: "coder",
    key_alias: "cli",
    started_at_unix: now() - 12,
    finished_at_unix: now() - 9,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "zai",
        upstream_id: "glm-4.6",
        started_at_unix: now() - 12,
        finished_at_unix: now() - 9,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 2140,
        output_tokens: 860,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f21a9",
    metamodel: "fast",
    key_alias: "pi",
    started_at_unix: now() - 74,
    finished_at_unix: now() - 70,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "deepseek",
        upstream_id: "deepseek-chat",
        started_at_unix: now() - 74,
        finished_at_unix: now() - 70,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 980,
        output_tokens: 312,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f2180",
    metamodel: "cheap",
    key_alias: "pi",
    started_at_unix: now() - 141,
    finished_at_unix: now() - 138,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "deepseek",
        upstream_id: "deepseek-chat",
        started_at_unix: now() - 141,
        finished_at_unix: now() - 138,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 4100,
        output_tokens: 1290,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f2144",
    metamodel: "fast",
    key_alias: "cli",
    started_at_unix: now() - 260,
    finished_at_unix: now() - 255,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "deepseek",
        upstream_id: "deepseek-chat",
        started_at_unix: now() - 260,
        finished_at_unix: now() - 258,
        result: "error",
        error: "upstream answered 429 (rate limited)",
        switch_reason: "rate limited, try the next member",
        input_tokens: null,
        output_tokens: null,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
      {
        provider_id: "zai",
        upstream_id: "glm-4.6",
        started_at_unix: now() - 258,
        finished_at_unix: now() - 255,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 1260,
        output_tokens: 540,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f2110",
    metamodel: "vision",
    key_alias: "web",
    started_at_unix: now() - 402,
    finished_at_unix: now() - 396,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "openai",
        upstream_id: "gpt-5.1",
        started_at_unix: now() - 402,
        finished_at_unix: now() - 396,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 5320,
        output_tokens: 780,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f20c2",
    metamodel: "coder",
    key_alias: "cli",
    started_at_unix: now() - 640,
    finished_at_unix: now() - 628,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "zai",
        upstream_id: "glm-4.6",
        started_at_unix: now() - 640,
        finished_at_unix: now() - 628,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 11200,
        output_tokens: 3100,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f2091",
    metamodel: "cheap",
    key_alias: "cron",
    started_at_unix: now() - 900,
    finished_at_unix: now() - 895,
    outcome: "error",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "deepseek",
        upstream_id: "deepseek-chat",
        started_at_unix: now() - 900,
        finished_at_unix: now() - 895,
        result: "error",
        error: "upstream answered 503 after 4s",
        switch_reason: null,
        input_tokens: null,
        output_tokens: null,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f1f60",
    metamodel: "fast",
    key_alias: "pi",
    started_at_unix: now() - 1500,
    finished_at_unix: now() - 1490,
    outcome: "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "deepseek",
        upstream_id: "deepseek-chat",
        started_at_unix: now() - 1500,
        finished_at_unix: now() - 1490,
        result: "ok",
        error: null,
        switch_reason: null,
        input_tokens: 2048,
        output_tokens: 970,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
  {
    id: "r_8f1f22",
    metamodel: "coder",
    key_alias: "pi",
    started_at_unix: now() - 2100,
    finished_at_unix: null,
    outcome: null,
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id: "llamacpp",
        upstream_id: "qwen3-coder-30b",
        started_at_unix: now() - 2100,
        finished_at_unix: null,
        result: null,
        error: null,
        switch_reason: null,
        input_tokens: 8400,
        output_tokens: null,
        response_preview: null,
        response_truncated: false,
        cost: null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  },
];

// A month of traffic so the Usage page has a shape to draw in previews.
// Deterministic: the same index gives the same picture on every screenshot.
const SPEND_MIX: [string, string, string, string][] = [
  ["zai", "glm-4.6", "coder", "pi"],
  ["deepseek", "deepseek-chat", "fast", "cli"],
  ["llamacpp", "qwen3-coder-30b", "coder", "pi"],
  ["openrouter", "qwen/qwen3-coder:free", "cheap", "cron"],
  ["zai", "glm-4.5-air", "cheap", "cron"],
  ["openai", "gpt-5.1", "vision", "cli"],
];
for (let index = 0; index < 460; index += 1) {
  const [provider_id, upstream_id, metamodel, key_alias] = SPEND_MIX[index % SPEND_MIX.length];
  const age = 3600 + Math.floor((index / 460) * 29 * 86400) + (index % 11) * 613;
  const at = now() - age;
  const failed = index % 17 === 0;
  const unknown = index % 23 === 0;
  const input = 800 + ((index * 37) % 5200);
  const output = 120 + ((index * 53) % 1800);
  requests.push({
    id: `r_g${index.toString(16).padStart(4, "0")}`,
    metamodel,
    key_alias,
    started_at_unix: at,
    finished_at_unix: at + 3,
    outcome: failed ? "error" : "ok",
    input_preview: null,
    input_truncated: false,
    declared_tools: null,
    issues: null,
    attempts: [
      {
        provider_id,
        upstream_id,
        started_at_unix: at,
        finished_at_unix: at + 3,
        result: failed ? "http_error" : "ok",
        error: failed ? "upstream returned 429" : null,
        switch_reason: null,
        input_tokens: unknown ? null : input,
        output_tokens: unknown || failed ? null : output,
        response_preview: null,
        response_truncated: false,
        // Only OpenRouter reports cost; elsewhere the router knows no price.
        cost:
          provider_id === "openrouter" && !unknown
            ? Number((input * 0.0000004 + output * 0.0000012).toFixed(6))
            : null,
        tool_count: null,
        tool_names: null,
        tool_names_truncated: false,
        tool_list_truncated: false,
        issues: null,
      },
    ],
  });
}

const health: Health = {
  status: "ok",
  uptime_unix: now() - started,
  components: {
    catalog: { ok: true },
    balances: { ok: true },
    events: { ok: true },
    knowledge: { ok: true },
    requests: { ok: true },
    providers: { ok: true, count: providers.length },
    schedule: {
      ok: true,
      providers: {
        deepseek: { last_success_unix: now() - 42, last_error: null },
        zai: { last_success_unix: now() - 96, last_error: null },
      },
    },
  },
};

const metamodels: MetaModel[] = [
  { id: "fast", context_length: 128_000 },
  { id: "coder", context_length: 32_768 },
  { id: "cheap", context_length: 128_000 },
  { id: "vision", context_length: 64_000 },
];

const bans: Ban[] = [
  {
    provider_id: "zai",
    upstream_id: "glm-4.6",
    reason: "HTTP 429 quota exhausted",
    expires_at_unix: now() + 1_240,
  },
  {
    provider_id: "deepseek",
    upstream_id: "deepseek-reasoner",
    reason: "HTTP 502 from upstream",
    expires_at_unix: now() + 3_050,
  },
];

const events: EventRecord[] = [
  {
    id: 5,
    ts_unix: now() - 20,
    kind: "ban_recorded",
    provider_id: "zai",
    detail: { upstream_id: "glm-4.6", reason: "HTTP 429 quota exhausted", expires_at_unix: now() + 3500 },
  },
  {
    id: 4,
    ts_unix: now() - 96,
    kind: "catalog_refreshed",
    provider_id: "deepseek",
    detail: { model_count: 5 },
  },
  {
    id: 3,
    ts_unix: now() - 240,
    kind: "balance_error",
    provider_id: "openai",
    detail: { error: "HTTP 401 from balance endpoint" },
  },
  {
    id: 2,
    ts_unix: now() - 402,
    kind: "ban_recorded",
    provider_id: "deepseek",
    detail: { upstream_id: "deepseek-reasoner", reason: "HTTP 502 from upstream", expires_at_unix: now() + 3200 },
  },
  {
    id: 1,
    ts_unix: now() - 900,
    kind: "catalog_refreshed",
    provider_id: "zai",
    detail: { model_count: 4 },
  },
];

function matchingCalls(query: Partial<RequestQuery>) {
  return requests.filter(r =>
    ((!query.provider && !query.model && !query.family && !query.attemptWindow) || r.attempts.some(a =>
      (!query.provider || a.provider_id === query.provider) && (!query.model || a.upstream_id === query.model) &&
      (!query.family || mockKey(a.upstream_id) === query.family) && (!query.attemptWindow ||
      (a.started_at_unix >= (query.sinceUnix ?? 0) && a.started_at_unix < (query.toUnix ?? Infinity))))) &&
    (!query.outcome || query.outcome === r.outcome) &&
    (!query.metamodel || query.metamodel === r.metamodel) &&
    (!query.keyAlias || query.keyAlias === r.key_alias) &&
    (query.attemptWindow || query.sinceUnix === undefined || r.started_at_unix >= query.sinceUnix) &&
    (query.attemptWindow || query.toUnix === undefined || r.started_at_unix < query.toUnix));
}

// A screenshot of "research running" opens the Wiki with ?job=running.
// The self-checks load this module in Node, where there is no window.
if (
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("job") === "running"
)
  mockJobInProgress();

export const mockApi: Api = {
  health: () => wait(health),

  running: () => wait([]),
  pools: () => wait(pools.map((pool) => ({ ...pool, members: [...pool.members] }))),
  putPool: (name: string, members: Member[], createOnly = false) => {
    const existing = pools.find((pool) => pool.name === name);
    if (existing && createOnly) return Promise.reject(new Error("A pool with this name already exists."));
    if (existing) existing.members = members;
    else pools = [...pools, { name, members }];
    return wait(undefined);
  },
  deletePool: (name: string) => {
    pools = pools.filter((pool) => pool.name !== name);
    return wait(undefined);
  },
  providers: () => wait(providers),
  providerModels: (providerId) => wait(catalogByProvider[providerId] ?? []),
  observations: (providerId) =>
    wait(providerId ? observations.filter((row) => row.provider_id === providerId) : observations),

  // The mock has no stored series, so it reports a ramp that ends at the
  // value shown on the card. It keeps the charts visible in previews.
  observationHistory: (query) => {
    const limit = query.limit ?? 500;
    const rows = observations
      .filter((row) => row.provider_id === query.providerId)
      .filter((row) => query.resource === undefined || row.resource === query.resource)
      .filter((row) => query.metric === undefined || row.metric === query.metric)
      .filter((row) => query.window === undefined || (row.window ?? "") === query.window)
      .filter((row) => query.unit === undefined || (row.unit ?? "") === query.unit);
    const points = rows.flatMap((row) =>
      Array.from({ length: Math.min(24, limit) }, (_, index) => {
        const share = 0.62 + index * 0.016; // older points left more of the window
        const remaining = row.remaining === null ? null : String(Number(row.remaining) * share);
        const limitValue = row.limit === null ? null : Number(row.limit);
        return {
          ...row,
          remaining,
          usage:
            limitValue === null || remaining === null
              ? row.usage
              : String(Math.round(limitValue - Number(remaining))),
          observed_at_unix: now() - (23 - index) * 3_600,
        };
      }),
    );
    return wait(points);
  },
  usage: (query) => {
    const size = query.bucket === "minute" ? 60 : query.bucket === "hour" ? 3600 : 86400;
    const empty = (): UsageStats => ({
      requests: 0, attempts: 0, ok: 0, errors: 0, cancels: 0,
      input_tokens: null, output_tokens: null, unknown_tokens: 0,
      input_reports: 0, output_reports: 0, cost: null, cost_reports: 0, estimable_attempts: 0, unpriced_tokens: null,
      mean_duration_ms: null, duration_reports: 0, output_tps: null, speed_reports: 0,
    });
    const totals = empty();
    const unpriced = new Map<string, number>();
    const groups = new Map<string, UsageBucket>();
    for (const row of requests) {
      if ((query.key && query.key !== row.key_alias) || (query.pool && query.pool !== row.metamodel)) continue;
      const seen = new Set<string>();
      for (const a of row.attempts) {
        if (a.result === null || a.started_at_unix < (query.sinceUnix ?? 0) ||
            a.started_at_unix >= (query.toUnix ?? Infinity) ||
            (query.provider && query.provider !== a.provider_id) ||
            (query.model && query.model !== a.upstream_id) || (query.family && query.family !== mockKey(a.upstream_id))) continue;
        const bucket = Math.floor(a.started_at_unix / size) * size;
        const group = { provider: a.provider_id, model: `${a.provider_id}/${a.upstream_id}`,
          metamodel: row.metamodel, family: mockKey(a.upstream_id), key: row.key_alias }[query.groupBy];
        const provider = query.splitProvider ? a.provider_id : undefined;
        const id = JSON.stringify([bucket, group, provider]);
        const cell = groups.get(id) ?? { ...empty(), bucket_unix: bucket, group, provider };
        if (!seen.has(id)) cell.requests++;
        seen.add(id);
        const tokens = a.cost === null && a.input_tokens !== null && a.output_tokens !== null ? a.input_tokens + a.output_tokens : null;
        if (tokens !== null) unpriced.set(a.provider_id, (unpriced.get(a.provider_id) ?? 0) + tokens);
        for (const stats of [cell, totals]) {
          if (tokens !== null) { stats.unpriced_tokens = (stats.unpriced_tokens ?? 0) + tokens; stats.estimable_attempts++; }
          stats.attempts++;
          if (a.result === "ok") stats.ok++;
          if (a.result === "error") stats.errors++;
          if (a.result === "client_cancel") stats.cancels++;
          if (a.input_tokens === null && a.output_tokens === null) stats.unknown_tokens++;
          if (a.input_tokens !== null) {
            stats.input_reports++; stats.input_tokens = (stats.input_tokens ?? 0) + a.input_tokens;
          }
          if (a.output_tokens !== null) {
            stats.output_reports++; stats.output_tokens = (stats.output_tokens ?? 0) + a.output_tokens;
          }
          if (a.cost !== null && typeof a.cost === "number") {
            stats.cost_reports++; stats.cost = (stats.cost ?? 0) + a.cost;
          }
        }
        groups.set(id, cell);
      }
      if (seen.size) totals.requests++;
    }
    const rows = [...groups.values()].sort((a, b) => b.bucket_unix - a.bucket_unix || a.group.localeCompare(b.group));
    const limit = query.limit ?? 2000;
    return wait({ buckets: rows.slice(0, limit), bucket_seconds: size,
      unpriced_by_provider: Object.fromEntries(unpriced), unpriced_providers_truncated: false,
      truncated: rows.length > limit, calls: totals.requests, totals });
  },

  usageSpend: (provider, period) => {
    const end = period.toUnix ?? now();
    return wait({ truncated: false, series: (!provider || provider === "zai") ? [{
      provider: "zai", resource: "coding-plan", metric: "credits", unit: "credits", window: null,
      primary_series: true, per_1000: 0.2, intervals: 3, tokens: 100_000,
      first_observed_unix: Math.max(period.sinceUnix ?? 0, end - 3600), last_observed_unix: end - 1,
    }] : [] });
  },

  requests: (query) => {
    const calls = matchingCalls(query);
    const older = query.beforeId ? calls.findIndex(r => r.id === query.beforeId) + 1 : 0;
    return wait(calls.slice(older, older + query.limit));
  },

  requestActivity: (filters, period) => {
    const t = now(), span = ({ "1h":3600, "24h":86400, "7d":604800 } as Record<string,number>)[period];
    const start = filters.sinceUnix ?? (span ? t + 1 - span : undefined);
    const calls = matchingCalls({...filters, sinceUnix:start, toUnix:filters.toUnix ?? t+1}).filter(r=>r.finished_at_unix !== null);
    const times=calls.map(r=>r.started_at_unix);
    const from = start ?? (calls.length ? Math.min(...times) : null), to = filters.toUnix ?? (span || !calls.length ? t+1 : Math.max(...times)+1);
    const duration = to - (from ?? to);
    const adaptive = [60,900,3600,86400,604800].find(s=>duration/s<168) ?? (Math.floor(duration/168/86400)+1)*86400;
    const step = filters.toUnix !== undefined ? adaptive : period==="1h" ? 60 : period==="24h" ? 900 : period==="7d" ? 3600 : adaptive;
    const bins=new Map<number,RequestBucket>(), minutes=new Map<number,number>();
    for(const r of calls) {
      const ts=r.started_at_unix, start=Math.floor(ts/step)*step, minute=Math.floor(ts/60);
      const n=(minutes.get(minute)??0)+1; minutes.set(minute,n);
      const b=bins.get(start)??{start,total:0,ok:0,errors:0,cancels:0,retried:0,peak_per_minute:0,first_start:ts,last_start:ts};
      b.total++; b.ok+=Number(r.outcome==="ok"); b.errors+=Number(r.outcome==="error"); b.cancels+=Number(r.outcome==="client_cancel"); b.retried+=Number(r.attempts.length>1);
      b.peak_per_minute=Math.max(b.peak_per_minute,n); b.first_start=Math.min(b.first_start,ts); b.last_start=Math.max(b.last_start,ts); bins.set(start,b);
    }
    return wait({from_unix:from,to_unix:to,as_of_unix:t,step_secs:step,buckets:[...bins.values()].sort((a,b)=>a.start-b.start)});
  },

  refresh: async (what) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    for (const provider of providers) {
      if (what === "balances" || provider.catalog === "static") continue;
      provider.last_refresh = { last_success_unix: now(), last_error: null };
    }
    return Object.fromEntries(
      providers.map((provider) => [
        provider.provider_id,
        provider.last_refresh ?? { last_success_unix: null, last_error: null },
      ]),
    );
  },

  bans: () => wait(bans.filter((ban) => ban.expires_at_unix > now())),
  events: (limit = 100) => wait(events.slice(0, limit)),
  models: () => wait(metamodels),

  catalog: () => wait(catalogRows(observedAt)),

  // The same fields the core sends for browsing; the long prose lists
  // stay with the full card.
  modelSummaries: (keys) =>
    wait(
      keys.flatMap((key) => {
        const card = mockCard(key);
        if (!card) return [];
        const {
          canonical_name, vendor, release_date, ratings, context_window, max_output_tokens,
          input_modalities, output_modalities, license, open_weights, tags, speed, pricing,
          pricing_hint, description, modality,
        } = card;
        return [{
          key, canonical_name, vendor, release_date, ratings, context_window, max_output_tokens,
          input_modalities, output_modalities, license, open_weights, tags, speed, pricing,
          pricing_hint, description, modality, primary_use: card.use_cases[0] ?? null,
        }];
      }),
    ),

  modelKnowledge: (upstreamId) => {
    const key = mockKey(upstreamId);
    const card = mockCard(key);
    const collected = mockCollectedAt(key, now());
    const max_age_secs = maxAgeDays() * 86_400;
    return wait({
      key,
      card,
      collected_at_unix: collected,
      generator: collected === null ? null : "deepseek/deepseek-flash+websearch",
      fresh: collected !== null && now() - collected < max_age_secs,
      max_age_secs,
      catalog_entries: catalogRows(observedAt)
        .filter((row) => row.knowledge_key === key)
        .map(({ provider_id, upstream_id }) => ({ provider_id, upstream_id })),
    });
  },

  collectKnowledge: async ({ upstreamId, force }) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    const key = mockKey(upstreamId);
    const at = now();
    const collected = mockCollectedAt(key, at);
    if (!force && collected !== null && at - collected < maxAgeDays() * 86_400) {
      return { key, collected: false, reason: "fresh" };
    }
    const card = mockCard(key) ?? researchMockCard(key, upstreamId, at);
    return {
      key,
      collected: true,
      collected_at_unix: at,
      card,
      repairs: [],
      catalog_entries: catalogRows(observedAt)
        .filter((row) => row.knowledge_key === key)
        .map(({ provider_id, upstream_id }) => ({ provider_id, upstream_id })),
    };
  },

  researchStatus: () => wait(mockResearch(now())),
  startResearch: (force) => wait(startMockResearch(force, now())),
  cancelResearch: () => wait(cancelMockResearch()),
};