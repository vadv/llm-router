// Shared contracts of the chat tool dispatcher. Each tool module owns its
// schema and handler; this file owns only the shapes they exchange.

import type { Api, Member, Pool } from "../../api";

// Switches of the Tools menu. A false switch removes the tool schemas
// from the request so the model cannot call the tool in this chat.
export type ToolsPermissions = {
  webSearch: boolean;
  sources: boolean;
  memory: boolean;
  javascript: boolean;
  poolActions: boolean;
  poolRead: boolean;
  // Usage, requests, balances: read-only reporting of the dashboard.
  usage: boolean;
  // Model catalog and researched wiki cards; research is confirmed.
  wiki: boolean;
  // Providers, events, bans, health; data_refresh is confirmed.
  system: boolean;
};

export const ALL_TOOLS_ON: ToolsPermissions = {
  webSearch: true,
  sources: true,
  memory: true,
  javascript: true,
  poolActions: true,
  poolRead: true,
  usage: true,
  wiki: true,
  system: true,
};

// Error types of the normalized contract. A tool result never carries a
// raw provider body, a credential or a stack trace.
export type ToolErrorType =
  | "invalid_arguments"
  | "sandbox_unavailable"
  | "sandbox_timeout"
  | "javascript_error"
  | "provider_unavailable"
  | "not_found"
  | "expired"
  | "aborted"
  | "tool_limit_exceeded"
  | "last_tool"
  | "declined";

export type ToolError = { type: ToolErrorType; message: string };

// The model-facing result: text on success, a typed error otherwise.
export type ToolResult = { ok: true; result: string } | { ok: false; error: ToolError };

// Management API bridge used by pool tools; injectable for tests.
export type PoolBridge = {
  list: () => Promise<Pool[]>;
  put: (name: string, members: Member[], createOnly?: boolean) => Promise<void>;
  delete: (name: string) => Promise<void>;
};

// The whole management surface the chat tools may touch. The default
// bridge is the site's own `api` object, so mock mode and auth behave the
// same as the dashboard. Tools take it through the context for tests.
export type ManagementBridge = Api;

export type ToolContext = {
  // 0 in the main chat loop. router_ask_pool runs its sub-request without
  // tools, so nesting cannot occur; the depth guard is defense in depth.
  depth: number;
  // Stop button combined with the per-call timeout by the dispatcher.
  signal: AbortSignal;
  // Gate for mutating actions; returning false cancels the tool.
  confirm: (message: string) => boolean;
  pools: PoolBridge;
  // Full management API (usage, wiki, providers, ...). Defaults to the
  // site's api object; tests inject a fake.
  management: ManagementBridge;
  // pool_select side effect: switch the active pool of the chat UI.
  selectPool: (name: string) => void;
};

export type ToolDefinition = {
  name: string;
  description: string;
  // JSON Schema of the arguments, sent to the model as-is.
  parameters: Record<string, unknown>;
  permission: keyof ToolsPermissions;
  // True for mutating actions: the dispatcher asks the user first.
  requiresConfirmation?: boolean;
  execute: (args: unknown, ctx: ToolContext) => Promise<ToolResult>;
};

export function toolError(type: ToolErrorType, message: string): ToolResult {
  return { ok: false, error: { type, message } };
}

// ---- Argument helpers: every tool validates its own input. ----

export function requireObject(args: unknown): Record<string, unknown> | null {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  return args as Record<string, unknown>;
}

export function requireString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim();
}
