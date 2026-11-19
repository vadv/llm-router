// Serializes UI messages into the OpenAI chat.completions request body.
// Display-only parts (reasoning blocks, citations, tool result cards) are
// not sent: upstreams accept role, content and tool_calls only. Reasoning
// continuation state is deliberately not synthesized per provider here.

import type { ChatMessage, ChatToolCallPart } from "./fixtures";
import { isToolMarkup } from "./tool-markup";

export function toolCallId(call: ChatToolCallPart, ordinal: number): string {
  return call.id ?? `call_${ordinal}`;
}

export type OpenAiRequestToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type OpenAiRequestMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAiRequestToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

function textOf(message: ChatMessage): string {
  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.kind === "text" && (message.role === "user" || !isToolMarkup(part.markdown))) blocks.push(part.markdown);
  }
  return blocks.join("\n\n");
}

function toolCallsOf(message: ChatMessage): OpenAiRequestToolCall[] {
  const calls: OpenAiRequestToolCall[] = [];
  for (const part of message.parts) {
    if (part.kind !== "tool-call") continue;
    // Upstream history requires an id; providers that stream none get a
    // position-based one, unique inside the message.
    calls.push({
      id: toolCallId(part, calls.length),
      type: "function",
      function: { name: part.name, arguments: part.arguments },
    });
  }
  return calls;
}

export function toOpenAIMessages(messages: ChatMessage[]): OpenAiRequestMessage[] {
  const out: OpenAiRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: textOf(message) });
      continue;
    }
    const text = textOf(message);
    const toolCalls = toolCallsOf(message);
    // An interrupted turn may contain only reasoning or a UI placeholder.
    const hasText = text.trim() !== "";
    if (!hasText && toolCalls.length === 0) continue;
    out.push(
      toolCalls.length > 0
        ? // Upstreams expect null content when the assistant turn is only
          // tool calls; an empty string is rejected by some providers.
          { role: "assistant", content: hasText ? text : null, tool_calls: toolCalls }
        : { role: "assistant", content: text },
    );
    // Tool results of this message follow it as tool messages; the id
    // repeats the one used in tool_calls.
    for (const part of message.parts) {
      if (part.kind !== "tool-result") continue;
      out.push({ role: "tool", tool_call_id: part.id, content: part.content });
    }
  }
  return out;
}
