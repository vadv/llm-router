// Bounded chat context: the router stays a proxy, so trimming history is
// the client's job. Kept in a standalone module so tests load it without
// the API client.

import type { ChatMessage } from "./fixtures";

// Last N messages go upstream. A tool call and its result travel in
// adjacent messages, so trimming must not split such a pair.
export const HISTORY_LIMIT = 40;

export function limitHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= HISTORY_LIMIT) return messages;
  let start = messages.length - HISTORY_LIMIT;
  // Do not open the window with an assistant tool call whose matching
  // user/tool context was cut away; move the edge to a user message.
  while (start > 0 && messages[start].role !== "user") start -= 1;
  return messages.slice(start);
}
