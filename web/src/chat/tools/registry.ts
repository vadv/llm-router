// The static tool registry: schemas for the request, permission gates and
// the typed dispatch. Unknown names are rejected, never guessed.

import {
  balanceHistoryTool,
  balanceListTool,
  banListTool,
  dataRefreshTool,
  eventListTool,
  modelCatalogTool,
  modelWikiResearchTool,
  modelWikiTool,
  providerListTool,
  providerModelsTool,
  requestActivityTool,
  requestListTool,
  systemHealthTool,
  usageSpendTool,
  usageStatsTool,
} from "./insights";
import { javascriptTool } from "./javascript";
import {
  poolAddModelTool,
  poolCreateTool,
  poolDeleteTool,
  poolInfoTool,
  poolListTool,
  poolReplaceTool,
  poolSelectTool,
} from "./pools";
import { routerAskPoolTool } from "./router";
import {
  memoryDeleteTool,
  memoryEditTool,
  memoryRecallTool,
  memorySaveTool,
  readSourceTool,
  webSearchTool,
} from "./server";
import { toolError, type ToolContext, type ToolDefinition, type ToolResult, type ToolsPermissions } from "./types";

export const TOOLS: readonly ToolDefinition[] = [
  webSearchTool,
  readSourceTool,
  memoryRecallTool,
  memorySaveTool,
  memoryEditTool,
  memoryDeleteTool,
  javascriptTool,
  poolListTool,
  poolSelectTool,
  poolInfoTool,
  poolAddModelTool,
  routerAskPoolTool,
  usageStatsTool,
  usageSpendTool,
  requestListTool,
  requestActivityTool,
  balanceListTool,
  balanceHistoryTool,
  modelCatalogTool,
  modelWikiTool,
  modelWikiResearchTool,
  providerListTool,
  providerModelsTool,
  poolCreateTool,
  poolDeleteTool,
  poolReplaceTool,
  eventListTool,
  banListTool,
  systemHealthTool,
  dataRefreshTool,
];

export type OpenAiToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

// OpenAI function specs filtered by the Tools menu state.
export function openAiToolSpecs(perms: ToolsPermissions): OpenAiToolSpec[] {
  return TOOLS.filter((tool) => perms[tool.permission]).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function timeoutSignal(ms: number): AbortSignal {
  // A native timeout signal cannot be cancelled, but it does not keep
  // event loops alive; older engines fall back to a controller.
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function combinedSignal(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.any === "function") {
    return AbortSignal.any([first, second]);
  }
  if (first.aborted) return first;
  if (second.aborted) return second;
  const controller = new AbortController();
  const forward = () => controller.abort();
  first.addEventListener("abort", forward, { once: true });
  second.addEventListener("abort", forward, { once: true });
  return controller.signal;
}

// Runs one tool call: validates the name and arguments, gates mutating
// actions, applies the per-call timeout and never throws.
export async function dispatchTool(
  name: string,
  argumentsText: string,
  ctx: ToolContext,
  timeoutMs = 15_000,
): Promise<ToolResult> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return toolError("not_found", `unknown tool: ${name}`);
  let args: unknown = {};
  if (argumentsText.trim() !== "") {
    try {
      args = JSON.parse(argumentsText);
    } catch {
      return toolError("invalid_arguments", `arguments of ${name} are not valid JSON`);
    }
  }
  if (tool.requiresConfirmation === true && !ctx.confirm(`Allow ${name} with these arguments?`)) {
    return toolError("declined", "the user declined this action");
  }
  const signal = combinedSignal(ctx.signal, timeoutSignal(timeoutMs));
  return await new Promise<ToolResult>((resolve) => {
    let settled = false;
    const finish = (result: ToolResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const onAbort = () => {
      if (ctx.signal.aborted) finish(toolError("aborted", "stopped by the user"));
      else finish(toolError(name === "javascript" ? "sandbox_timeout" : "provider_unavailable", `${name} timed out`));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    tool.execute(args, { ...ctx, signal }).then(finish, (cause: unknown) =>
      finish(toolError(name === "javascript" ? "sandbox_unavailable" : "provider_unavailable", cause instanceof Error ? cause.message : `${name} failed`)),
    );
  });
}
