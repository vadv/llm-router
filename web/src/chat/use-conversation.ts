// Conversation layer on top of useChat: IndexedDB persistence (one save
// per finished turn), conversation switching, Regenerate/Edit routing and
// reload recovery for answers interrupted mid-stream.

import { useCallback, useEffect, useRef, useState } from "react";
import { keyStore } from "../api";
import type { ChatMessage } from "./fixtures";
import type { ReasoningEffort } from "./reasoning-effort";
import {
  conversationTitle,
  STORE_LIMIT,
  historyBeforeEdit,
  historyForRegenerate,
  openChatStore,
  ownerTag,
  recoverConversationMessages,
  type ChatStore,
  type ConversationRecord,
  type ConversationSummary,
} from "./store";
import { hasToolMarkup } from "./tool-markup";
import { useChat, type ChatTurnEnd } from "./use-chat";

// Remembers which conversation to restore after a reload; no key material.
const ACTIVE_STORAGE = "llm-router.chat.active";

// The router can be served over LAN HTTP, where crypto.randomUUID is unavailable.
function newChatId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
}

function userMessage(text: string): ChatMessage {
  return { role: "user", parts: [{ kind: "text", markdown: text }] };
}

export function useConversation(pool: string | null, onPoolSelect: (name: string | null) => void) {
  // useChat needs the turn-end handler at call time, but the handler needs
  // the store helpers below; a ref breaks that cycle.
  const turnEndRef = useRef<(turn: ChatTurnEnd) => Promise<void>>(async () => {});
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("auto");
  const chat = useChat(
    pool,
    reasoningEffort,
    undefined,
    onPoolSelect,
    (turn) => turnEndRef.current(turn),
  );
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [editIndex, setEditIndex] = useState<number | null>(null);

  const idRef = useRef<string | null>(null);
  // Conversation the running turn belongs to; switching waits for the turn
  // and later turns cannot overwrite it.
  const turnIdRef = useRef<string | null>(null);
  const turnRef = useRef<Promise<void> | null>(null);
  const editRef = useRef<number | null>(null);
  const messagesRef = useRef(chat.messages);
  const poolRef = useRef(pool);
  const statusRef = useRef(chat.status);
  const startedRef = useRef(false);

  useEffect(() => {
    messagesRef.current = chat.messages;
  }, [chat.messages]);
  useEffect(() => {
    poolRef.current = pool;
  }, [pool]);
  useEffect(() => {
    statusRef.current = chat.status;
  }, [chat.status]);

  // A late stream completion belongs to the session that started it.
  const [owner] = useState(() => ownerTag(keyStore.get()));
  const currentStore = useCallback((): Promise<ChatStore | null> => openChatStore(owner), [owner]);

  const storeRequired = useCallback(async () => {
    const store = await currentStore();
    if (!store) throw new Error("Local history is unavailable in this browser.");
    return store;
  }, [currentStore]);

  const refreshList = useCallback(async () => {
    const store = await currentStore();
    if (store !== null) setConversations(await store.list());
  }, [currentStore]);

  const persist = useCallback(
    async (id: string, messages: ChatMessage[], abortedStreaming: boolean, route = poolRef.current ?? "", effort = reasoningEffort) => {
      const store = await storeRequired();
      const summary = await store.save({
        id,
        title: conversationTitle(messages),
        pool: route,
        reasoningEffort: effort,
        messages,
        abortedStreaming,
      });
      setConversations((previous) => [summary, ...previous.filter((item) => item.id !== id)].slice(0, STORE_LIMIT));
    },
    [storeRequired, reasoningEffort],
  );

  const onTurnEnd = useCallback(
    async (turn: ChatTurnEnd) => {
      const id = turnIdRef.current;
      if (id !== null) {
        try { await persist(id, turn.messages, false); }
        catch { setStorageNotice("This conversation could not be saved on this device."); }
      }
    },
    [persist],
  );
  useEffect(() => {
    turnEndRef.current = onTurnEnd;
  }, [onTurnEnd]);

  const ensureId = useCallback(() => {
    if (idRef.current !== null) return idRef.current;
    const id = newChatId();
    idRef.current = id;
    setConversationId(id);
    localStorage.setItem(ACTIVE_STORAGE, id);
    return id;
  }, []);

  async function changeReasoningEffort(next: ReasoningEffort) {
    setReasoningEffort(next);
    try {
      await persist(ensureId(), messagesRef.current, false, poolRef.current ?? "", next);
    } catch {
      setStorageNotice("Reasoning effort changed for this chat but could not be saved on this device.");
    }
  }

  const startTurn = useCallback(
    (history: ChatMessage[], retryToolFormat = false) => {
      const id = ensureId();
      turnIdRef.current = id;
      turnRef.current = chat.rerun(history, retryToolFormat);
      return turnRef.current;
    },
    [chat, ensureId],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "") return;
      const editAt = editRef.current;
      editRef.current = null;
      setEditIndex(null);
      const base = editAt !== null ? historyBeforeEdit(messagesRef.current, editAt) : messagesRef.current;
      await startTurn([...base, userMessage(trimmed)]);
    },
    [startTurn],
  );

  const regenerate = useCallback(async () => {
    const history = historyForRegenerate(messagesRef.current);
    await startTurn(history, hasToolMarkup(messagesRef.current.at(-1)));
  }, [startTurn]);

  // Fills the composer (caller) and remembers where Send will truncate.
  const beginEdit = useCallback((index: number): string | null => {
    const message = messagesRef.current[index];
    if (message === undefined || message.role !== "user") return null;
    const text = message.parts
      .map((part) => (part.kind === "text" ? part.markdown : ""))
      .join("\n\n")
      .trim();
    if (text === "") return null;
    editRef.current = index;
    setEditIndex(index);
    return text;
  }, []);

  const cancelEdit = useCallback(() => {
    editRef.current = null;
    setEditIndex(null);
  }, []);

  const applyRecord = useCallback(
    (record: ConversationRecord) => {
      idRef.current = record.id;
      setConversationId(record.id);
      localStorage.setItem(ACTIVE_STORAGE, record.id);
      editRef.current = null;
      setEditIndex(null);
      setReasoningEffort(record.reasoningEffort);
      onPoolSelect(record.pool || null);
      chat.reset(recoverConversationMessages(record));
      // The interrupted flag is consumed here so a second reload does not
      // add another note; the note itself stays part of the history.
      if (record.abortedStreaming) void persist(record.id, recoverConversationMessages(record), false, record.pool, record.reasoningEffort)
        .catch(() => setStorageNotice("Could not save the recovered conversation."));
    },
    [chat, onPoolSelect, persist],
  );

  const stopTurn = useCallback(async () => {
    const turn = turnRef.current;
    if (turn !== null) {
      chat.stop();
      await turn;
      turnRef.current = null;
    }
  }, [chat]);

  const selectConversation = useCallback(
    async (id: string) => {
      if (idRef.current === id) return;
      await stopTurn();
      const store = await storeRequired();
      const record = await store.load(id);
      if (!record) throw new Error("Conversation no longer exists.");
      applyRecord(record);
    },
    [applyRecord, storeRequired, stopTurn],
  );

  const newConversation = useCallback(async () => {
    await stopTurn();
    editRef.current = null;
    setEditIndex(null);
    idRef.current = null;
    setReasoningEffort("auto");
    setConversationId(null);
    localStorage.removeItem(ACTIVE_STORAGE);
    chat.reset([]);
  }, [chat, stopTurn]);

  const createConversation = useCallback(async (name: string) => {
    await stopTurn();
    const store = await storeRequired();
    const id = newChatId();
    const title = name.trim().replace(/\s+/g, " ");
    await store.save({ id, title: title || conversationTitle([]), named: !!title, pool: poolRef.current ?? "", messages: [], abortedStreaming: false });
    await refreshList();
    setReasoningEffort("auto");
    editRef.current = null;
    setEditIndex(null);
    idRef.current = id;
    setConversationId(id);
    localStorage.setItem(ACTIVE_STORAGE, id);
    chat.reset([]);
  }, [chat, storeRequired, refreshList, stopTurn]);

  const renameConversation = useCallback(async (id: string, name: string) => {
    if (idRef.current === id) await turnRef.current;
    const store = await storeRequired();
    await store.rename(id, name);
    await refreshList();
  }, [storeRequired, refreshList]);

  const removeConversation = useCallback(
    async (id: string) => {
      // Stop first when deleting the active conversation: the turn-end
      // save would otherwise re-create the deleted record.
      if (idRef.current === id) await newConversation();
      const store = await currentStore();
      if (store !== null) await store.remove(id);
      await refreshList();
    },
    [currentStore, newConversation, refreshList],
  );

  const clearAllConversations = useCallback(async () => {
    // Same ordering concern as removeConversation.
    await newConversation();
    const store = await currentStore();
    if (store !== null) await store.clearAll();
    await refreshList();
  }, [currentStore, newConversation, refreshList]);

  // One-time mount: load the list and restore the last active conversation,
  // including the interrupted answer after a mid-stream reload.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      const store = await currentStore();
      if (store === null) {
        setStorageNotice("Local history is unavailable. This chat will not survive a reload.");
        return;
      }
      setConversations(await store.list());
      const activeId = localStorage.getItem(ACTIVE_STORAGE);
      const record = activeId === null ? null : await store.load(activeId);
      if (record !== null) applyRecord(record);
    })().catch(() => setStorageNotice("Could not restore local chat history."))
      .finally(() => setReady(true));
  }, [applyRecord, currentStore]);

  // Best-effort save of the partial answer when the page disappears during
  // a stream; the completion is not guaranteed but the flag makes any
  // saved partial render as interrupted after reload.
  useEffect(() => {
    const saveInterrupted = () => {
      const id = idRef.current;
      const busy = statusRef.current === "streaming" || statusRef.current === "working";
      if (id === null || !busy) return;
      void currentStore().then((store) => {
        if (store === null) return;
        return store.save({
          id,
          title: conversationTitle(messagesRef.current),
          pool: poolRef.current ?? "",
          reasoningEffort,
          messages: messagesRef.current,
          abortedStreaming: true,
        });
      }).catch(() => setStorageNotice("Could not save the interrupted answer."));
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveInterrupted();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", saveInterrupted);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", saveInterrupted);
    };
  }, [currentStore, reasoningEffort]);

  return {
    reasoningEffort,
    changeReasoningEffort,
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    send,
    stop: chat.stop,
    regenerate,
    editIndex,
    beginEdit,
    cancelEdit,
    conversations,
    conversationId,
    selectConversation,
    createConversation,
    renameConversation,
    ready,
    storageNotice,
    removeConversation,
    clearAllConversations,
  };
}
