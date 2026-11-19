import type { ChatMessage } from "./fixtures";

// Match a bare DSML request, not inline mentions, Markdown quotes or code examples.
// This is a display diagnostic. Never extract or run commands from assistant text.
export function isToolMarkup(text: string): boolean {
  return /^(?:[ \t]*\r?\n)* {0,3}<\s*(?:[|｜]\s*){1,2}DSML\s*(?:[|｜]\s*){1,2}tool_calls\s*>/i.test(text);
}

export function hasToolMarkup(message: ChatMessage | undefined): boolean {
  return message?.role === "assistant" && message.parts.some(p => p.kind === "text" && isToolMarkup(p.markdown));
}
