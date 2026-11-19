// The function-tools loop: sends the conversation with tool schemas, runs
// the model's tool calls through the registry and continues until the
// model answers without tools or a cap stops the loop. UI-free on purpose
// so self-checks can drive it with a scripted fetch.

import { api, keyStore } from "../api";
import { AssistantAccumulator } from "./accumulator";
import type { ChatMessage, ChatToolCallPart } from "./fixtures";
import { limitHistory } from "./history";
import { hasToolMarkup } from "./tool-markup";
import { readReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import { toOpenAIMessages, toolCallId } from "./openai-history";
import { openAiErrorText, parseOpenAiStream, type OpenAiStreamChunk } from "./sse";
import { dispatchTool, openAiToolSpecs } from "./tools/registry";
import { ALL_TOOLS_ON, type PoolBridge, type ToolContext, type ToolsPermissions, type ToolResult } from "./tools/types";

const ENDPOINT = "/v1/chat/completions";

// One user request spans at most TOOL_LOOP_LIMIT tool-using model turns,
// TOOL_CALL_LIMIT executed calls per turn and one budget for tool execution.
// A final no-tools turn summarizes the results instead of ending at a note.
export const TOOL_LOOP_LIMIT = 4;
export const TOOL_CALL_LIMIT = 8;
// A burst of local Wiki reads cannot spend money or change router state.
export const WIKI_READ_LIMIT = 100;
export const TOOL_LOOP_BUDGET_MS = 60_000;

export type ToolLoopEvents = {
  onMessages: (messages: ChatMessage[]) => void;
  onStatus: (status: "streaming" | "working") => void;
};

export type ToolLoopOptions = {
  history: ChatMessage[];
  // Explicit retry of an answer containing model protocol text.
  retryToolFormat?: boolean;
  reasoningEffort?: ReasoningEffort;
  pool: string;
  signal: AbortSignal;
  tools?: ToolsPermissions;
  authKey?: () => string | null;
  pools?: PoolBridge;
  management?: ToolContext["management"];
  // Injected by deterministic stream-timing tests.
  now?: () => number;
  confirm?: (message: string) => boolean;
  onPoolSelect?: (name: string) => void;
  events: ToolLoopEvents;
};

export type ToolLoopOutcome = {
  messages: ChatMessage[];
  error: string | null;
  // True when the user stopped the loop; partial output is kept.
  stopped: boolean;
};

function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

// Same error shapes as the rest of the app: management sends
// {error: "text"}, inference {error: {type, message}}.
async function requestError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { error?: string | { message?: string } };
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error.message === "string") return body.error.message;
  } catch {
    // Not JSON: the raw text stays as the message.
  }
  return text || `HTTP ${response.status}`;
}

function systemNote(text: string): ChatMessage {
  return { role: "user", parts: [{ kind: "text", markdown: `System note: ${text}` }] };
}

function hasOutputDelta(chunk: OpenAiStreamChunk): boolean {
  return (chunk.choices ?? []).some((choice) => {
    const delta = choice.delta;
    if (!delta) return false;
    if (typeof delta.content === "string" && delta.content !== "") return true;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") return true;
    if (typeof delta.reasoning === "string" && delta.reasoning !== "") return true;
    if ((delta.tool_calls ?? []).length > 0) return true;
    return Array.isArray(delta.reasoning_details) && delta.reasoning_details.some((detail) =>
      typeof detail === "object" && detail !== null &&
      typeof (detail as { text?: unknown }).text === "string" &&
      (detail as { text: string }).text !== "");
  });
}

function outputTokensOf(chunk: OpenAiStreamChunk): number | null {
  const value = chunk.usage?.completion_tokens ?? chunk.usage?.output_tokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function runChatTurns(options: ToolLoopOptions): Promise<ToolLoopOutcome> {
  const tools = options.tools ?? ALL_TOOLS_ON;
  const authKey = options.authKey ?? keyStore.get;
  const specs = openAiToolSpecs(tools);
  const effort = readReasoningEffort(options.reasoningEffort);
  const now = options.now ?? Date.now;
  let remainingToolMs = TOOL_LOOP_BUDGET_MS;
  let wikiReads = 0;
  const notes: string[] = [];
  let history = options.history;
  let activePool = options.pool;
  const ctx: ToolContext = {
    // The sub-request of router_ask_pool carries no tools, so nothing can
    // nest below this loop; the depth field guards that invariant.
    depth: 0,
    signal: options.signal,
    // shortcut: native confirm, replace with in-chat confirmation card in polish stage
    confirm:
      options.confirm ??
      ((message) => (typeof window === "undefined" ? false : window.confirm(message))),
    pools: options.pools ?? {
      list: () => api.pools(),
      put: (name, members, createOnly) => api.putPool(name, members, createOnly),
      delete: (name) => api.deletePool(name),
    },
    management: options.management ?? api,
    selectPool: (name) => {
      activePool = name;
      options.onPoolSelect?.(name);
      notes.push(`the active pool switched to ${name}`);
    },
  };

  let forceFinal = false;

  const stopped = (stopped: boolean): ToolLoopOutcome => ({ messages: history, error: null, stopped });

  for (let turn = 0; turn <= TOOL_LOOP_LIMIT; turn += 1) {
    const accumulator = new AssistantAccumulator();
    const requestStartedAt = now();
    let firstTokenAt: number | null = null;
    let outputTokens: number | null = null;
    let finishedAt: number | null = null;
    const assistant = (): ChatMessage => {
      const generationMs = firstTokenAt !== null && finishedAt !== null ? finishedAt - firstTokenAt : null;
      return {
        role: "assistant",
        parts: [...accumulator.parts],
        metrics: {
          ...(firstTokenAt !== null ? { ttftMs: Math.max(0, firstTokenAt - requestStartedAt) } : {}),
          ...(outputTokens !== null ? { outputTokens } : {}),
          ...(outputTokens !== null && generationMs !== null && generationMs > 0
            ? { tokensPerSecond: outputTokens / (generationMs / 1000) }
            : {}),
        },
      };
    };
    const emit = () => options.events.onMessages([...history, assistant()]);
    emit();
    options.events.onStatus("streaming");

    let response: Response;
    try {
      const key = authKey();
      response = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          ...(key ? { authorization: `Bearer ${key}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: activePool,
          ...(effort !== "auto" ? { reasoning_effort: effort } : {}),
          // Bounded context: the router stays a proxy, so trimming is the
          // client's job. Tool turns must not be split.
          messages: [
            ...(options.retryToolFormat ? [{ role: "system", content: "Use the tool_calls field for tool requests, not markup in text. Reuse the tool results already in this conversation." }] : []),
            ...toOpenAIMessages(limitHistory(history)),
          ],
          ...(specs.length > 0 && !forceFinal ? { tools: specs } : {}),
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: options.signal,
      });
    } catch (cause) {
      if (isAbort(cause)) return stopped(true);
      return { messages: history, error: cause instanceof Error ? cause.message : String(cause), stopped: false };
    }
    if (!response.ok || response.body === null) {
      return { messages: history, error: await requestError(response), stopped: false };
    }

    try {
      for await (const chunk of parseOpenAiStream(response.body)) {
        if (firstTokenAt === null && hasOutputDelta(chunk)) firstTokenAt = now();
        outputTokens = outputTokensOf(chunk) ?? outputTokens;
        const failure = openAiErrorText(chunk.error);
        if (failure !== null) {
          finishedAt = now();
          accumulator.finish();
          emit();
          return { messages: [...history, assistant()], error: failure, stopped: false };
        }
        accumulator.push(chunk);
        emit();
      }
    } catch (cause) {
      if (isAbort(cause)) {
        // Stop is a user action, not an error: the partial answer stays;
        // a stop before any content leaves no empty bubble.
        finishedAt = now();
        accumulator.finish();
        const partial = accumulator.parts.length > 0 ? [...history, assistant()] : history;
        options.events.onMessages(partial);
        return { messages: partial, error: null, stopped: true };
      }
      return { messages: [...history, assistant()], error: cause instanceof Error ? cause.message : String(cause), stopped: false };
    }
    finishedAt = now();
    accumulator.finish();
    emit();

    const calls = accumulator.parts.filter((part): part is ChatToolCallPart => part.kind === "tool-call");
    if (calls.length === 0) {
      const done = [...history, assistant()];
      options.events.onMessages(done);
      const error = hasToolMarkup(done[done.length - 1]) ? "The model returned tool markup instead of a tool call. Use Regenerate to retry." : null;
      return { messages: done, error, stopped: false };
    }
    if (forceFinal) {
      const done = [...history, assistant()];
      options.events.onMessages(done);
      return {
        messages: done,
        error: "The model requested more tools after the tool limit; no further tools were run.",
        stopped: false,
      };
    }

    options.events.onStatus("working");
    let aborted = options.signal.aborted;
    let regularCalls = 0;
    for (const [index, call] of calls.entries()) {
      // The id repeats the synthesis of the request serializer, so the
      // tool message answers the right call even without a model id.
      const id = toolCallId(call, index);
      let outcome: ToolResult;
      if (aborted) {
        outcome = { ok: false, error: { type: "aborted", message: "stopped by the user" } };
      } else if (call.name === "model_wiki" ? wikiReads >= WIKI_READ_LIMIT : regularCalls >= TOOL_CALL_LIMIT) {
        outcome = {
          ok: false,
          error: { type: "tool_limit_exceeded", message: call.name === "model_wiki" ? `at most ${WIKI_READ_LIMIT} Wiki reads per request` : `at most ${TOOL_CALL_LIMIT} other tool calls per model step` },
        };
      } else if (remainingToolMs <= 0) {
        outcome = { ok: false, error: { type: "tool_limit_exceeded", message: "the tool time budget is exhausted" } };
      } else {
        if (call.name === "model_wiki") wikiReads++; else regularCalls++;
        const started = now();
        outcome = await dispatchTool(call.name, call.arguments, ctx);
        remainingToolMs -= Math.max(0, now() - started);
      }
      if (!outcome.ok && outcome.error.type === "aborted") aborted = true;
      accumulator.parts.push({
        kind: "tool-result",
        id,
        name: call.name,
        ok: outcome.ok,
        content: outcome.ok ? outcome.result : JSON.stringify(outcome.error),
      });
      emit();
    }

    history = [...history, assistant()];
    // Tool side effects the user must see: pool switches and this loop's
    // own stops become visible system notes in the chat.
    for (const note of notes.splice(0)) history = [...history, systemNote(note)];
    options.events.onMessages(history);
    if (aborted) return stopped(true);
    if (turn === TOOL_LOOP_LIMIT - 1 || remainingToolMs <= 0) {
      forceFinal = true;
    }
  }
  return stopped(false);
}
