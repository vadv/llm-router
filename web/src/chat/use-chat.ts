// Chat state for the chat page: the message list, stream status and the
// last error. The request loop itself lives in tool-loop.ts; this hook
// only binds it to React state. No retry or fallback loops.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "./fixtures";
import type { ReasoningEffort } from "./reasoning-effort";
import { runChatTurns } from "./tool-loop";
import { ALL_TOOLS_ON, type ToolsPermissions } from "./tools/types";

export type ChatStatus = "idle" | "streaming" | "working" | "error";

// Fired once per user request, after the loop settled (success, stop or
// error), with the last emitted messages so persistence sees one save per
// turn instead of one per token.
export type ChatTurnEnd = {
  messages: ChatMessage[];
  stopped: boolean;
  failed: boolean;
};

export function useChat(
  pool: string | null,
  reasoningEffort: ReasoningEffort,
  tools: ToolsPermissions = ALL_TOOLS_ON,
  onPoolSelect?: (name: string) => void,
  onTurnEnd?: (turn: ChatTurnEnd) => void | Promise<void>,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A synchronous guard: `status` updates are async, so a double submit in
  // the same frame would otherwise start two streams.
  const busyRef = useRef(false);
  useEffect(() => () => abortRef.current?.abort(), []);
  const onTurnEndRef = useRef(onTurnEnd);
  useEffect(() => {
    onTurnEndRef.current = onTurnEnd;
  }, [onTurnEnd]);

  const run = useCallback(
    async (history: ChatMessage[], retryToolFormat = false) => {
      // Narrowing for ToolLoopOptions.pool; send and rerun check first.
      if (pool === null) return;
      busyRef.current = true;
      abortRef.current = new AbortController();
      setError(null);
      setStatus("streaming");
      let latest: ChatMessage[] = [...history, { role: "assistant", parts: [] }];
      let stopped = false;
      let failed = false;
      setMessages(latest);
      try {
        const outcome = await runChatTurns({
          history,
          retryToolFormat,
          reasoningEffort,
          pool,
          signal: abortRef.current.signal,
          tools,
          onPoolSelect,
          events: {
            onMessages: (next) => {
              latest = next;
              setMessages(next);
            },
            onStatus: setStatus,
          },
        });
        // The last streaming preview can still contain a pending bubble after an HTTP error.
        latest = outcome.messages;
        setMessages(latest);
        if (outcome.error !== null) {
          setError(outcome.error);
          setStatus("error");
          failed = true;
        } else {
          setStatus("idle");
        }
        stopped = outcome.stopped;
      } catch (cause) {
        // The loop reports typed errors; this catch is a last resort so a
        // rejected promise never escapes the handler.
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
        failed = true;
      } finally {
        abortRef.current = null;
        busyRef.current = false;
        await onTurnEndRef.current?.({ messages: latest, stopped, failed });
      }
    },
    [pool, reasoningEffort, tools, onPoolSelect],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (pool === null || busyRef.current || trimmed === "") return;
      await run([...messages, { role: "user", parts: [{ kind: "text", markdown: trimmed }] }]);
    },
    [messages, pool, run],
  );

  // After a tool round, retry the answer using its results instead of replaying the round.
  const rerun = useCallback(
    async (history: ChatMessage[], retryToolFormat = false) => {
      const last = history[history.length - 1];
      if (pool === null || busyRef.current || !last) return;
      if (last.role !== "user" && !last.parts.some(part => part.kind === "tool-result")) return;
      await run(history, retryToolFormat);
    },
    [pool, run],
  );

  // Replaces the message list outside a turn, e.g. when another
  // conversation is loaded; callers stop a running turn first.
  const reset = useCallback((next: ChatMessage[]) => {
    if (busyRef.current) return;
    setMessages(next);
    setError(null);
    setStatus("idle");
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, status, error, send, rerun, reset, stop };
}
