// Server bridge for the web and memory tools: typed POSTs to the chat
// endpoints of the router, with the same key handling as the chat
// transport. Only normalized data crosses this boundary.

import { keyStore } from "../../api";
import {
  requireObject,
  requireString,
  toolError,
  type ToolDefinition,
  type ToolErrorType,
  type ToolResult,
} from "./types";

// Tool outputs are text for the model; past this size they are cut.
const RESULT_LIMIT = 24_000;

export function capText(text: string): string {
  if (text.length <= RESULT_LIMIT) return text;
  return `${text.slice(0, RESULT_LIMIT)}\n[truncated]`;
}

// Error types the chat endpoints can report; anything else is reported as
// an unavailable service instead of trusting an unknown word.
const ENDPOINT_ERROR_TYPES: readonly ToolErrorType[] = [
  "invalid_arguments",
  "provider_unavailable",
  "not_found",
  "expired",
];

export type EndpointFailure = { status: number; type?: ToolErrorType; message: string };

export type BridgeResponse = { ok: true; value: unknown } | { ok: false; failure: EndpointFailure };

export async function postChat(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<BridgeResponse> {
  const key = keyStore.get();
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        ...(key ? { authorization: `Bearer ${key}` } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause; // the dispatcher reports the abort
    return { ok: false, failure: { status: 0, message: "core is unreachable" } };
  }
  if (!response.ok) return { ok: false, failure: await endpointFailure(response) };
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return { ok: false, failure: { status: response.status, message: "invalid JSON response" } };
  }
  return { ok: true, value };
}

// Both error shapes exist: chat endpoints send {error: {type, message}},
// older routes send {error: "text"}.
async function endpointFailure(response: Response): Promise<EndpointFailure> {
  const text = await response.text();
  type ErrorBody = { error?: string | { type?: unknown; message?: unknown } };
  let parsed: ErrorBody | null = null;
  try {
    parsed = JSON.parse(text) as ErrorBody;
  } catch {
    parsed = null;
  }
  const raw = parsed?.error;
  const flat = typeof raw === "string" ? raw : null;
  const shaped = raw !== null && raw !== undefined && typeof raw === "object" ? raw : null;
  const message =
    (shaped && typeof shaped.message === "string" && shaped.message) ||
    flat ||
    text ||
    `HTTP ${response.status}`;
  const type = typeof shaped?.type === "string" ? shaped.type : undefined;
  const known = type !== undefined ? ENDPOINT_ERROR_TYPES.find((entry) => entry === type) : undefined;
  return { status: response.status, type: known, message };
}

export function bridgeError(failure: EndpointFailure): ToolResult {
  if (failure.type !== undefined) {
    return { ok: false, error: { type: failure.type, message: failure.message } };
  }
  return toolError("provider_unavailable", failure.message);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

// ---- web_search ----

export type SearchItem = { source_id: string; title: string; url: string; snippet?: string };

function parseItems(value: unknown): SearchItem[] | null {
  const root = record(value);
  const items = root?.items;
  if (!Array.isArray(items)) return null;
  const parsed: SearchItem[] = [];
  for (const entry of items) {
    const item = record(entry);
    if (item === null) return null;
    if (typeof item.source_id !== "string" || typeof item.title !== "string" || typeof item.url !== "string") {
      return null;
    }
    parsed.push({
      source_id: item.source_id,
      title: item.title,
      url: item.url,
      snippet: typeof item.snippet === "string" ? item.snippet : undefined,
    });
  }
  return parsed;
}

const PROVIDERS = ["auto", "deepseek", "zai"] as const;

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description:
    "Search the public web. Returns found sources with source_id, title, url and a snippet. Use read_source with a source_id from this chat to read a page.",
  permission: "webSearch",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      count: { type: "integer", minimum: 1, maximum: 10, description: "Number of results." },
      provider: { type: "string", enum: [...PROVIDERS], description: "Search adapter; auto tries the next one only on a technical failure." },
    },
    required: ["query"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const query = requireString(args, "query");
    if (query === null) return toolError("invalid_arguments", "query (non-empty string) is required");
    let count: number | undefined;
    if (args.count !== undefined) {
      if (typeof args.count !== "number" || !Number.isInteger(args.count) || args.count < 1 || args.count > 10) {
        return toolError("invalid_arguments", "count must be an integer between 1 and 10");
      }
      count = args.count;
    }
    let provider: string | undefined;
    if (args.provider !== undefined) {
      if (typeof args.provider !== "string" || !PROVIDERS.includes(args.provider as (typeof PROVIDERS)[number])) {
        return toolError("invalid_arguments", "provider must be auto, deepseek or zai");
      }
      provider = args.provider;
    }
    const response = await postChat(
      "/v1/chat/search",
      { query, ...(count !== undefined ? { count } : {}), ...(provider !== undefined ? { provider } : {}) },
      ctx.signal,
    );
    if (!response.ok) return bridgeError(response.failure);
    const items = parseItems(response.value);
    if (items === null) return toolError("provider_unavailable", "search returned an invalid response");
    const meta = record(response.value);
    return {
      ok: true,
      result: capText(
        JSON.stringify({
          items,
          provider_used: typeof meta?.provider_used === "string" ? meta.provider_used : "unknown",
          fallback_used: meta?.fallback_used === true,
        }),
      ),
    };
  },
};

// ---- read_source ----

function requireSourceId(raw: unknown): string | null {
  const args = requireObject(raw);
  if (args === null) return null;
  return requireString(args, "source_id");
}

export const readSourceTool: ToolDefinition = {
  name: "read_source",
  description:
    "Read one source found by web_search in this chat, as Markdown. Takes a source_id, never a URL; expired ids need a new search.",
  permission: "sources",
  parameters: {
    type: "object",
    properties: { source_id: { type: "string", description: "source_id returned by web_search." } },
    required: ["source_id"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const sourceId = requireSourceId(raw);
    if (sourceId === null) return toolError("invalid_arguments", "source_id (non-empty string) is required");
    const response = await postChat("/v1/chat/read-source", { source_id: sourceId }, ctx.signal);
    if (!response.ok) return bridgeError(response.failure);
    const value = record(response.value);
    if (value === null || typeof value.content_markdown !== "string" || typeof value.url !== "string") {
      return toolError("provider_unavailable", "read-source returned an invalid response");
    }
    const title = typeof value.title === "string" ? value.title : value.url;
    const truncated = value.truncated === true ? " [truncated]" : "";
    return { ok: true, result: capText(`# ${title}\n${value.url}${truncated}\n\n${value.content_markdown}`) };
  },
};

// ---- memory ----

// Recall is also used by the UI outside the chat loop.
export async function recallEntries(
  query: string,
  limit: number | undefined,
  signal: AbortSignal,
): Promise<BridgeResponse> {
  return postChat(
    "/v1/chat/memory/recall",
    { query, ...(limit !== undefined ? { limit } : {}) },
    signal,
  );
}

export type MemoryEntry = { id: number; topic: string; note: string };

export function parseEntries(value: unknown): MemoryEntry[] | null {
  const root = record(value);
  const entries = root?.entries;
  if (!Array.isArray(entries)) return null;
  const parsed: MemoryEntry[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (item === null || typeof item.id !== "number" || typeof item.topic !== "string" || typeof item.note !== "string") {
      return null;
    }
    parsed.push({ id: item.id, topic: item.topic, note: item.note });
  }
  return parsed;
}

export const memoryRecallTool: ToolDefinition = {
  name: "memory_recall",
  description: "Find the user's saved notes for this API key by topic or text.",
  permission: "memory",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Text to find." },
      limit: { type: "integer", minimum: 1, description: "Maximum entries to return." },
    },
    required: ["query"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const query = requireString(args, "query");
    if (query === null) return toolError("invalid_arguments", "query (non-empty string) is required");
    let limit: number | undefined;
    if (args.limit !== undefined) {
      if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1) {
        return toolError("invalid_arguments", "limit must be a positive integer");
      }
      limit = args.limit;
    }
    const response = await recallEntries(query, limit, ctx.signal);
    if (!response.ok) return bridgeError(response.failure);
    const entries = parseEntries(response.value);
    if (entries === null) return toolError("provider_unavailable", "memory recall returned an invalid response");
    if (entries.length === 0) return { ok: true, result: "No saved notes match this query." };
    return { ok: true, result: capText(JSON.stringify(entries)) };
  },
};

export const memorySaveTool: ToolDefinition = {
  name: "memory_save",
  description: "Save a short note under a topic for future chats of this user.",
  permission: "memory",
  parameters: {
    type: "object",
    properties: {
      topic: { type: "string", description: "Short topic name." },
      note: { type: "string", description: "The note text." },
    },
    required: ["topic", "note"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const topic = requireString(args, "topic");
    const note = requireString(args, "note");
    if (topic === null || note === null) return toolError("invalid_arguments", "topic and note (non-empty strings) are required");
    const response = await postChat("/v1/chat/memory/save", { topic, note }, ctx.signal);
    if (!response.ok) return bridgeError(response.failure);
    const value = record(response.value);
    if (value === null || typeof value.id !== "number") {
      return toolError("provider_unavailable", "memory save returned an invalid response");
    }
    return { ok: true, result: `Saved memory entry ${value.id}.` };
  },
};

function requireId(args: Record<string, unknown>): number | null {
  if (typeof args.id !== "number" || !Number.isInteger(args.id) || args.id < 1) return null;
  return args.id;
}

export const memoryEditTool: ToolDefinition = {
  name: "memory_edit",
  description: "Change the topic and note of one saved memory entry.",
  permission: "memory",
  parameters: {
    type: "object",
    properties: {
      id: { type: "integer", description: "Entry id from memory_recall or memory_save." },
      topic: { type: "string", description: "New topic." },
      note: { type: "string", description: "New note text." },
    },
    required: ["id", "topic", "note"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const id = requireId(args);
    if (id === null) return toolError("invalid_arguments", "id (positive integer) is required");
    const topic = requireString(args, "topic");
    const note = requireString(args, "note");
    if (topic === null || note === null) return toolError("invalid_arguments", "topic and note (non-empty strings) are required");
    const response = await postChat("/v1/chat/memory/edit", { id, topic, note }, ctx.signal);
    if (!response.ok) return bridgeError(response.failure);
    return { ok: true, result: `Updated memory entry ${id}.` };
  },
};

export const memoryDeleteTool: ToolDefinition = {
  name: "memory_delete",
  description: "Delete one saved memory entry by id.",
  permission: "memory",
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "Entry id from memory_recall or memory_save." } },
    required: ["id"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const id = requireId(args);
    if (id === null) return toolError("invalid_arguments", "id (positive integer) is required");
    const response = await postChat("/v1/chat/memory/delete", { id }, ctx.signal);
    if (!response.ok) return bridgeError(response.failure);
    return { ok: true, result: `Deleted memory entry ${id}.` };
  },
};
