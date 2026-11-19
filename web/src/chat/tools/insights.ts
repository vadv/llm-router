// Read-only reporting and wiki tools over the site's own management API.
// Everything the dashboard shows — usage, spend, requests, balances,
// model catalog and researched wiki cards, providers, events, bans,
// health — is available to the model through these tools. Mutating
// actions (wiki research, pool create/delete, data refresh) ask the user
// first via the dispatcher's confirmation gate.

import { toolError, requireObject, requireString, type ToolDefinition, type ToolResult } from "./types";

// One bounded JSON result; large pages are cut and flagged so the model
// knows the data is partial instead of silently truncated.
const RESULT_MAX_CHARS = 20_000;

function json(value: unknown): ToolResult {
  const text = JSON.stringify(value);
  if (text.length <= RESULT_MAX_CHARS) return { ok: true, result: text };
  return {
    ok: true,
    result: JSON.stringify({ truncated: true, preview: text.slice(0, RESULT_MAX_CHARS) }),
  };
}

function failure(cause: unknown, what: string): ToolResult {
  return toolError("provider_unavailable", cause instanceof Error ? cause.message : `${what} failed`);
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined | "invalid" {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return "invalid";
  return value;
}

// ---- Usage, spend and request history (permission: usage). ----

export const usageStatsTool: ToolDefinition = {
  name: "usage_stats",
  description:
    "Usage and cost totals of this router, grouped by provider, model, metamodel or key. " +
    "Period is Unix seconds; omit for all retained history. Token/cost null means not reported, not zero.",
  permission: "usage",
  parameters: {
    type: "object",
    properties: {
      group_by: { type: "string", enum: ["provider", "model", "metamodel", "key"], description: "Grouping; default provider." },
      bucket: { type: "string", enum: ["hour", "day"], description: "Time bucket; default day." },
      since_unix: { type: "number", description: "Range start, Unix seconds." },
      to_unix: { type: "number", description: "Range end, Unix seconds." },
      provider: { type: "string" }, model: { type: "string" }, key: { type: "string" }, pool: { type: "string" },
    },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    const since = optionalNumber(args, "since_unix");
    const to = optionalNumber(args, "to_unix");
    if (since === "invalid" || to === "invalid") return toolError("invalid_arguments", "since_unix/to_unix must be numbers");
    const groupBy = (args.group_by as string | undefined) ?? "provider";
    if (!["provider", "model", "metamodel", "key"].includes(groupBy)) {
      return toolError("invalid_arguments", "group_by must be provider, model, metamodel or key");
    }
    const bucket = (args.bucket as string | undefined) ?? "day";
    if (bucket !== "hour" && bucket !== "day") return toolError("invalid_arguments", "bucket must be hour or day");
    try {
      const page = await ctx.management.usage({
        bucket, groupBy: groupBy as "provider" | "model" | "metamodel" | "key",
        sinceUnix: since, toUnix: to, limit: 500,
        provider: args.provider as string | undefined, model: args.model as string | undefined,
        key: args.key as string | undefined, pool: args.pool as string | undefined,
      });
      return json(page);
    } catch (cause) {
      return failure(cause, "usage query");
    }
  },
};

export const usageSpendTool: ToolDefinition = {
  name: "usage_spend",
  description: "Spend series for one provider (subscription windows, per-token prices) as the dashboard shows.",
  permission: "usage",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Provider id, e.g. deepseek." },
      since_unix: { type: "number" }, to_unix: { type: "number" },
    },
    required: ["provider"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const provider = requireString(args, "provider");
    if (provider === null) return toolError("invalid_arguments", "provider is required");
    const since = optionalNumber(args, "since_unix");
    const to = optionalNumber(args, "to_unix");
    if (since === "invalid" || to === "invalid") return toolError("invalid_arguments", "since_unix/to_unix must be numbers");
    try {
      return json(await ctx.management.usageSpend(provider, { sinceUnix: since, toUnix: to }));
    } catch (cause) {
      return failure(cause, "spend query");
    }
  },
};

export const requestListTool: ToolDefinition = {
  name: "request_list",
  description:
    "Recent client requests with attempts, tokens, cost and errors. Sensitive: contains 80-char input previews.",
  permission: "usage",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max rows, default 20." },
      before_id: { type: "string", description: "Cursor from a previous page." },
      provider: { type: "string" }, model: { type: "string" }, metamodel: { type: "string" },
      key_alias: { type: "string" },
      outcome: { type: "string", description: "Filter by outcome, e.g. error." },
      since_unix: { type: "number" }, to_unix: { type: "number" },
    },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    const since = optionalNumber(args, "since_unix");
    const to = optionalNumber(args, "to_unix");
    if (since === "invalid" || to === "invalid") return toolError("invalid_arguments", "since_unix/to_unix must be numbers");
    const limit = optionalNumber(args, "limit");
    if (limit === "invalid") return toolError("invalid_arguments", "limit must be a number");
    try {
      const rows = await ctx.management.requests({
        limit: Math.min(Math.max(limit ?? 20, 1), 50),
        beforeId: args.before_id as string | undefined,
        provider: args.provider as string | undefined, model: args.model as string | undefined,
        metamodel: args.metamodel as string | undefined, keyAlias: args.key_alias as string | undefined,
        outcome: args.outcome as string | undefined,
        sinceUnix: since, toUnix: to,
      });
      return json({ requests: rows });
    } catch (cause) {
      return failure(cause, "request list");
    }
  },
};

export const requestActivityTool: ToolDefinition = {
  name: "request_activity",
  description: "Request activity buckets (totals, ok, errors, cancels) for a period like 24h or 7d.",
  permission: "usage",
  parameters: {
    type: "object",
    properties: {
      period: { type: "string", description: "Period, e.g. 24h, 7d, 30d; default 24h." },
      provider: { type: "string" }, model: { type: "string" }, metamodel: { type: "string" },
      key_alias: { type: "string" }, outcome: { type: "string" },
    },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    try {
      return json(await ctx.management.requestActivity({
        provider: args.provider as string | undefined, model: args.model as string | undefined,
        metamodel: args.metamodel as string | undefined, keyAlias: args.key_alias as string | undefined,
        outcome: args.outcome as string | undefined,
      }, (args.period as string | undefined) ?? "24h"));
    } catch (cause) {
      return failure(cause, "request activity");
    }
  },
};

export const balanceListTool: ToolDefinition = {
  name: "balance_list",
  description: "Current provider balances and quota observations (limit, usage, remaining, window, reset).",
  permission: "usage",
  parameters: {
    type: "object",
    properties: { provider: { type: "string", description: "Optional provider filter." } },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    try {
      const rows = await ctx.management.observations(args.provider as string | undefined);
      return json({ observations: rows });
    } catch (cause) {
      return failure(cause, "balance list");
    }
  },
};

export const balanceHistoryTool: ToolDefinition = {
  name: "balance_history",
  description: "History of balance/quota observations for one provider over time.",
  permission: "usage",
  parameters: {
    type: "object",
    properties: {
      provider: { type: "string" },
      resource: { type: "string" }, metric: { type: "string" },
      since_unix: { type: "number" }, limit: { type: "number" },
    },
    required: ["provider"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const provider = requireString(args, "provider");
    if (provider === null) return toolError("invalid_arguments", "provider is required");
    const since = optionalNumber(args, "since_unix");
    const limit = optionalNumber(args, "limit");
    if (since === "invalid" || limit === "invalid") return toolError("invalid_arguments", "since_unix/limit must be numbers");
    try {
      const rows = await ctx.management.observationHistory({
        providerId: provider,
        resource: args.resource as string | undefined, metric: args.metric as string | undefined,
        sinceUnix: since, limit: Math.min(limit ?? 100, 500),
      });
      return json({ observations: rows });
    } catch (cause) {
      return failure(cause, "balance history");
    }
  },
};

// ---- Model catalog and wiki (permission: wiki). ----

export const modelCatalogTool: ToolDefinition = {
  name: "model_catalog",
  description: "All models of the live catalog: provider, upstream id, context size, knowledge key.",
  permission: "wiki",
  parameters: { type: "object", properties: {} },
  async execute(_raw, ctx): Promise<ToolResult> {
    try {
      return json({ models: await ctx.management.catalog() });
    } catch (cause) {
      return failure(cause, "model catalog");
    }
  },
};

export const modelWikiTool: ToolDefinition = {
  name: "model_wiki",
  description:
    "The researched wiki card of one model: description, strengths, weaknesses, ratings, pricing hint, sources. " +
    "For coverage or missing cards across the catalog use inventory:true instead of reading each model. " +
    "One page checks up to 100 unique models, with an optional provider filter. Reads local cards; never starts research.",
  permission: "wiki",
  parameters: {
    type: "object",
    properties: { upstream_id: { type: "string", description: "Read one card by upstream id." },
      inventory: { type: "boolean", description: "List model keys with and without a saved card." },
      provider: { type: "string" }, offset: { type: "integer", minimum: 0 } },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    if (args.inventory === true) {
      const offset = args.offset ?? 0;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || (args.provider !== undefined && typeof args.provider !== "string")) {
        return toolError("invalid_arguments", "inventory expects a non-negative integer offset and an optional provider name");
      }
      try {
        const rows = await ctx.management.catalog();
        const keys = [...new Set(rows.filter(r => !args.provider || r.provider_id === args.provider).map(r => r.knowledge_key))].sort();
        const page = keys.slice(offset, offset + 100);
        const saved = new Set(page.length ? (await ctx.management.modelSummaries(page, ctx.signal)).map(c => c.key) : []);
        return json({total_models: keys.length, next_offset: offset + page.length < keys.length ? offset + page.length : null,
          with_card: page.filter(k => saved.has(k)), without_card: page.filter(k => !saved.has(k))});
      } catch (cause) { return failure(cause, "wiki inventory"); }
    }
    const upstreamId = requireString(args, "upstream_id");
    if (upstreamId === null) return toolError("invalid_arguments", "upstream_id or inventory:true is required");
    try {
      return json(await ctx.management.modelKnowledge(upstreamId));
    } catch (cause) {
      return failure(cause, "model wiki");
    }
  },
};

export const modelWikiResearchTool: ToolDefinition = {
  name: "model_wiki_research",
  description:
    "Research or refresh the wiki card of one model using the configured research model with web search. " +
    "Costs one upstream research call; the user confirms before it runs.",
  permission: "wiki",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      provider_id: { type: "string" }, upstream_id: { type: "string" },
      force: { type: "boolean", description: "Re-research even when fresh." },
    },
    required: ["provider_id", "upstream_id"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const providerId = requireString(args, "provider_id");
    const upstreamId = requireString(args, "upstream_id");
    if (providerId === null || upstreamId === null) {
      return toolError("invalid_arguments", "provider_id and upstream_id are required");
    }
    try {
      return json(await ctx.management.collectKnowledge({ providerId, upstreamId, force: args.force === true }));
    } catch (cause) {
      return failure(cause, "wiki research");
    }
  },
};

// ---- Providers and pool management (permissions: system / poolActions). ----

export const providerListTool: ToolDefinition = {
  name: "provider_list",
  description: "Configured providers with catalog type, refresh status and local engine state.",
  permission: "system",
  parameters: { type: "object", properties: {} },
  async execute(_raw, ctx): Promise<ToolResult> {
    try {
      return json({ providers: await ctx.management.providers() });
    } catch (cause) {
      return failure(cause, "provider list");
    }
  },
};

export const providerModelsTool: ToolDefinition = {
  name: "provider_models",
  description: "Models known for one provider with context sizes.",
  permission: "system",
  parameters: {
    type: "object",
    properties: { provider: { type: "string" } },
    required: ["provider"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const provider = requireString(args, "provider");
    if (provider === null) return toolError("invalid_arguments", "provider is required");
    try {
      return json({ models: await ctx.management.providerModels(provider) });
    } catch (cause) {
      return failure(cause, "provider models");
    }
  },
};

// ---- Events, bans, health, refresh (permission: system). ----

export const eventListTool: ToolDefinition = {
  name: "event_list",
  description: "Recent core event log lines (failovers, refreshes, errors).",
  permission: "system",
  parameters: {
    type: "object",
    properties: { limit: { type: "number", description: "Max events, default 50." } },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    const limit = optionalNumber(args, "limit");
    if (limit === "invalid") return toolError("invalid_arguments", "limit must be a number");
    try {
      return json({ events: await ctx.management.events(Math.min(limit ?? 50, 100)) });
    } catch (cause) {
      return failure(cause, "event list");
    }
  },
};

export const banListTool: ToolDefinition = {
  name: "ban_list",
  description: "Active temporary model bans with reason and expiry.",
  permission: "system",
  parameters: { type: "object", properties: {} },
  async execute(_raw, ctx): Promise<ToolResult> {
    try {
      return json({ bans: await ctx.management.bans() });
    } catch (cause) {
      return failure(cause, "ban list");
    }
  },
};

export const systemHealthTool: ToolDefinition = {
  name: "system_health",
  description: "Health of the router and its components (catalog, balances, events, knowledge, requests).",
  permission: "system",
  parameters: { type: "object", properties: {} },
  async execute(_raw, ctx): Promise<ToolResult> {
    try {
      return json(await ctx.management.health());
    } catch (cause) {
      return failure(cause, "health");
    }
  },
};

export const dataRefreshTool: ToolDefinition = {
  name: "data_refresh",
  description: "Refresh catalog and/or provider balances now instead of waiting for the schedule. User confirms.",
  permission: "system",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: { what: { type: "string", enum: ["all", "catalog", "balances"], description: "Default all." } },
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw) ?? {};
    const what = (args.what as string | undefined) ?? "all";
    if (!["all", "catalog", "balances"].includes(what)) {
      return toolError("invalid_arguments", "what must be all, catalog or balances");
    }
    try {
      return json(await ctx.management.refresh(what as "all" | "catalog" | "balances"));
    } catch (cause) {
      return failure(cause, "refresh");
    }
  },
};
