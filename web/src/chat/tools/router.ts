// router_ask_pool: one bounded sub-request to another pool. The sub-request
// carries no tools, so it cannot start a nested tool loop.

import { bridgeError, postChat } from "./server";
import { requireObject, requireString, toolError, type ToolDefinition, type ToolResult } from "./types";

const ANSWER_LIMIT = 16_000;

export const routerAskPoolTool: ToolDefinition = {
  name: "router_ask_pool",
  description:
    "Ask one other pool a single question and return its answer text. The other pool runs no tools and no follow-up questions.",
  permission: "poolActions",
  parameters: {
    type: "object",
    properties: {
      pool: { type: "string", description: "Target pool name." },
      prompt: { type: "string", description: "The full question for the other pool." },
    },
    required: ["pool", "prompt"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    if (ctx.depth >= 1) {
      return toolError("last_tool", "not allowed: router_ask_pool cannot run inside another pool request");
    }
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const pool = requireString(args, "pool");
    const prompt = requireString(args, "prompt");
    if (pool === null || prompt === null) {
      return toolError("invalid_arguments", "pool and prompt (non-empty strings) are required");
    }
    const response = await postChat(
      "/v1/chat/completions",
      { model: pool, messages: [{ role: "user", content: prompt }], stream: false },
      ctx.signal,
    );
    if (!response.ok) return bridgeError(response.failure);
    const answer = answerText(response.value);
    if (answer === null) return toolError("provider_unavailable", `${pool} returned no answer`);
    if (answer.length <= ANSWER_LIMIT) return { ok: true, result: answer };
    // A cut answer must say so instead of looking complete.
    return { ok: true, result: JSON.stringify({ answer: answer.slice(0, ANSWER_LIMIT), truncated: true }) };
  },
};

function answerText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown } | null)?.message;
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" && content !== "" ? content : null;
}
