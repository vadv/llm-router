// Accumulates parsed OpenAI stream chunks into the assistant message parts
// the UI renders. Parts keep the order the model produced them: text,
// reasoning and tool calls are never regrouped.

import type { ChatMessagePart, ChatReasoningPart, ChatToolCallPart } from "./fixtures";
import type { OpenAiStreamChunk, OpenAiStreamDelta, OpenAiToolCallDelta } from "./sse";

// OpenRouter reasoning_details: only entries with text are displayable;
// encrypted or signature-only entries are continuation data.
function reasoningDetailText(details: unknown): string | null {
  if (!Array.isArray(details)) return null;
  let text = "";
  for (const detail of details) {
    if (detail && typeof detail === "object") {
      const value = (detail as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text === "" ? null : text;
}

function reasoningTextOf(delta: OpenAiStreamDelta): string | null {
  // reasoning_content (DeepSeek) and reasoning (Moonshot/Kimi) are the
  // same display text under different names; some streams may carry more
  // than one source, so all present texts are joined.
  let text = "";
  if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
  if (typeof delta.reasoning === "string") text += delta.reasoning;
  const details = reasoningDetailText(delta.reasoning_details);
  if (details) text += details;
  return text === "" ? null : text;
}

function isCompleteJson(text: string): boolean {
  if (text.trim() === "") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export class AssistantAccumulator {
  readonly parts: ChatMessagePart[] = [];
  // Tool call fragments are keyed by delta index inside this message;
  // parallel calls never mix.
  private readonly toolCalls = new Map<number, ChatToolCallPart>();
  private readonly reasoningSpans: { part: ChatReasoningPart; startedAt: number }[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  push(chunk: OpenAiStreamChunk): void {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content !== "") {
        this.append(delta.content);
      }
      const reasoning = reasoningTextOf(delta);
      if (reasoning !== null) this.appendReasoning(reasoning);
      for (const call of delta.tool_calls ?? []) {
        this.appendToolCall(call);
      }
    }
  }

  // Ends the message: reasoning spans get their duration, tool call
  // arguments are validated. Called on normal end, error and Stop.
  finish(): void {
    for (const span of this.reasoningSpans) {
      span.part.durationMs = Math.max(0, this.now() - span.startedAt);
      span.part.streaming = false;
    }
    for (const part of this.toolCalls.values()) {
      if (part.state !== "streaming") continue;
      // Fragmented arguments must end as one JSON document; a broken or
      // truncated join is a visible error, not an empty object.
      part.state = isCompleteJson(part.arguments) ? "ready" : "invalid";
    }
  }

  private lastPart(): ChatMessagePart | undefined {
    return this.parts[this.parts.length - 1];
  }

  private append(text: string): void {
    const last = this.lastPart();
    if (last && last.kind === "text") {
      last.markdown += text;
      return;
    }
    this.parts.push({ kind: "text", markdown: text });
  }

  private appendReasoning(text: string): void {
    const last = this.lastPart();
    if (last && last.kind === "reasoning") {
      last.text += text;
      return;
    }
    const part: ChatReasoningPart = {
      kind: "reasoning",
      text,
      durationMs: 0,
      streaming: true,
    };
    this.parts.push(part);
    this.reasoningSpans.push({ part, startedAt: this.now() });
  }

  private appendToolCall(call: OpenAiToolCallDelta): void {
    // A provider that streams a single call may omit the index.
    const index = typeof call.index === "number" ? call.index : 0;
    let part = this.toolCalls.get(index);
    if (!part) {
      part = { kind: "tool-call", name: "", arguments: "", state: "streaming" };
      this.toolCalls.set(index, part);
      this.parts.push(part);
    }
    // id and name may arrive only in the first fragment.
    if (call.id && part.id === undefined) part.id = call.id;
    if (call.function?.name) part.name = call.function.name;
    if (call.function?.arguments) part.arguments += call.function.arguments;
  }
}
