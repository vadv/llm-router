// Pool tools over the existing management API. pool_select switches the
// active pool of the chat UI; pool_add_model is confirmed by the user
// before it runs.

import {
  requireObject,
  requireString,
  toolError,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./types";

type Member = { provider_id: string; upstream_id: string };

async function listPools(ctx: ToolContext): Promise<{ name: string; members: Member[] }[] | ToolResult> {
  try {
    const pools = await ctx.pools.list();
    if (!Array.isArray(pools)) return toolError("provider_unavailable", "pool list is invalid");
    return pools.map((pool) => ({ name: pool.name, members: pool.members }));
  } catch (cause) {
    return toolError("provider_unavailable", cause instanceof Error ? cause.message : "pool list failed");
  }
}

function parseMembers(raw: unknown): Member[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const members: Member[] = [];
  for (const entry of raw) {
    const member = requireObject(entry);
    const providerId = member === null ? null : requireString(member, "provider_id");
    const upstreamId = member === null ? null : requireString(member, "upstream_id");
    if (providerId === null || upstreamId === null) return null;
    members.push({ provider_id: providerId, upstream_id: upstreamId });
  }
  return members;
}

export const poolListTool: ToolDefinition = {
  name: "pool_list",
  description: "List the pools of this router with their model counts.",
  permission: "poolRead",
  parameters: { type: "object", properties: {} },
  async execute(_raw, ctx): Promise<ToolResult> {
    const pools = await listPools(ctx);
    if (!Array.isArray(pools)) return pools;
    return {
      ok: true,
      result: JSON.stringify({ pools: pools.map((pool) => ({ name: pool.name, models: pool.members.length })) }),
    };
  },
};

export const poolInfoTool: ToolDefinition = {
  name: "pool_info",
  description: "Show the models of one pool.",
  permission: "poolRead",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Pool name." } },
    required: ["name"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const name = requireString(args, "name");
    if (name === null) return toolError("invalid_arguments", "name (non-empty string) is required");
    const pools = await listPools(ctx);
    if (!Array.isArray(pools)) return pools;
    const pool = pools.find((entry) => entry.name === name);
    if (pool === undefined) return toolError("not_found", `no pool named ${name}`);
    return { ok: true, result: JSON.stringify({ name: pool.name, members: pool.members }) };
  },
};

export const poolSelectTool: ToolDefinition = {
  name: "pool_select",
  description:
    "Switch the active pool of this chat to the named pool. Further answers come from that pool.",
  permission: "poolActions",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Pool name from pool_list." } },
    required: ["name"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const name = requireString(args, "name");
    if (name === null) return toolError("invalid_arguments", "name (non-empty string) is required");
    const pools = await listPools(ctx);
    if (!Array.isArray(pools)) return pools;
    if (!pools.some((entry) => entry.name === name)) {
      return toolError("not_found", `no pool named ${name}`);
    }
    ctx.selectPool(name);
    return { ok: true, result: `The active pool switched to ${name}.` };
  },
};

export const poolAddModelTool: ToolDefinition = {
  name: "pool_add_model",
  description: "Add one model to a pool. The user confirms the change before it runs.",
  permission: "poolActions",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      pool: { type: "string", description: "Pool name." },
      provider_id: { type: "string", description: "Provider id of the model." },
      upstream_id: { type: "string", description: "Upstream model id." },
    },
    required: ["pool", "provider_id", "upstream_id"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const pool = requireString(args, "pool");
    const providerId = requireString(args, "provider_id");
    const upstreamId = requireString(args, "upstream_id");
    if (pool === null || providerId === null || upstreamId === null) {
      return toolError("invalid_arguments", "pool, provider_id and upstream_id (non-empty strings) are required");
    }
    const pools = await listPools(ctx);
    if (!Array.isArray(pools)) return pools;
    const target = pools.find((entry) => entry.name === pool);
    if (target === undefined) return toolError("not_found", `no pool named ${pool}`);
    const known = target.members.some((m) => m.provider_id === providerId && m.upstream_id === upstreamId);
    if (known) return { ok: true, result: `${providerId}/${upstreamId} is already in pool ${pool}.` };
    try {
      await ctx.pools.put(pool, [...target.members, { provider_id: providerId, upstream_id: upstreamId }]);
    } catch (cause) {
      return toolError("provider_unavailable", cause instanceof Error ? cause.message : "pool update failed");
    }
    return { ok: true, result: `Added ${providerId}/${upstreamId} to pool ${pool}.` };
  },
};

const membersSchema = {
  type: "array",
  items: {
    type: "object",
    properties: { provider_id: { type: "string" }, upstream_id: { type: "string" } },
    required: ["provider_id", "upstream_id"],
  },
  description: "Ordered fallback list of models.",
};

export const poolCreateTool: ToolDefinition = {
  name: "pool_create",
  description: "Create a new pool from an ordered list of models. Fails if the name exists. User confirms.",
  permission: "poolActions",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, members: membersSchema },
    required: ["name", "members"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const name = requireString(args, "name");
    const members = parseMembers(args.members);
    if (name === null || members === null) {
      return toolError("invalid_arguments", "name and a non-empty members list of {provider_id, upstream_id} are required");
    }
    try {
      await ctx.pools.put(name, members, true);
      return { ok: true, result: `Pool ${name} created with ${members.length} model(s).` };
    } catch (cause) {
      return toolError("provider_unavailable", cause instanceof Error ? cause.message : "pool create failed");
    }
  },
};

export const poolReplaceTool: ToolDefinition = {
  name: "pool_replace",
  description: "Replace all models of an existing pool with a new ordered list. Use to remove or reorder models. User confirms.",
  permission: "poolActions",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: { name: { type: "string" }, members: membersSchema },
    required: ["name", "members"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const name = requireString(args, "name");
    const members = parseMembers(args.members);
    if (name === null || members === null) {
      return toolError("invalid_arguments", "name and a non-empty members list of {provider_id, upstream_id} are required");
    }
    const pools = await listPools(ctx);
    if (!Array.isArray(pools)) return pools;
    if (!pools.some((entry) => entry.name === name)) return toolError("not_found", `no pool named ${name}`);
    try {
      await ctx.pools.put(name, members);
      return { ok: true, result: `Pool ${name} now has ${members.length} model(s) in the requested order.` };
    } catch (cause) {
      return toolError("provider_unavailable", cause instanceof Error ? cause.message : "pool update failed");
    }
  },
};

export const poolDeleteTool: ToolDefinition = {
  name: "pool_delete",
  description: "Delete a pool. Requests using it stop working. User confirms before it runs.",
  permission: "poolActions",
  requiresConfirmation: true,
  parameters: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const name = requireString(args, "name");
    if (name === null) return toolError("invalid_arguments", "name is required");
    try {
      await ctx.pools.delete(name);
      return { ok: true, result: `Pool ${name} deleted.` };
    } catch (cause) {
      return toolError("provider_unavailable", cause instanceof Error ? cause.message : "pool delete failed");
    }
  },
};
