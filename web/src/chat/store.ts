// Local conversation history in IndexedDB. Records hold plain JSON messages
// (parts as stored by the accumulator) plus bookkeeping fields; the client
// key itself is never written. Pure helpers stay separate so self-checks
// can drive them without a browser database.

import type { ChatMessage } from "./fixtures";
import { readReasoningEffort, type ReasoningEffort } from "./reasoning-effort";

// Per-owner cap of kept conversations; the oldest are evicted on save.
export const STORE_LIMIT = 200;
export const TITLE_CAP = 60;

export type ConversationSummary = {
  id: string;
  title: string;
  pool: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type ConversationRecord = {
  id: string;
  owner: string;
  title: string;
  named?: boolean;
  pool: string;
  reasoningEffort: ReasoningEffort;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  // True when the record was saved mid-stream on page hide.
  abortedStreaming: boolean;
};

export type SaveInput = {
  id: string;
  title: string;
  named?: boolean;
  pool: string;
  reasoningEffort?: ReasoningEffort;
  messages: ChatMessage[];
  abortedStreaming: boolean;
};

// Minimal persistence backend. IndexedDB fills it in the browser; checks
// inject a plain map so no extra dependency is needed.
export type StoreBackend = {
  all(): Promise<unknown[]>;
  put(record: ConversationRecord): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
};

export type ChatStore = {
  list(): Promise<ConversationSummary[]>;
  load(id: string): Promise<ConversationRecord | null>;
  save(input: SaveInput): Promise<ConversationSummary>;
  rename(id: string, title: string): Promise<ConversationSummary>;
  remove(id: string): Promise<void>;
  clearAll(): Promise<void>;
};

// Title from the first user text, whitespace-collapsed and capped.
export function conversationTitle(messages: ChatMessage[], cap = TITLE_CAP): string {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.parts
      .map((part) => (part.kind === "text" ? part.markdown : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") {
      return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
    }
  }
  return "New conversation";
}

export function sortConversations<T extends { updatedAt: number }>(records: T[]): T[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
}

// Regenerate drops the last assistant message and keeps everything else
// (a trailing system note survives and still ends the history as a user
// turn, which the loop requires).
export function historyForRegenerate(messages: ChatMessage[]): ChatMessage[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "assistant") {
      // A stopped round may already have changed state. Keep its receipts on retry.
      if (messages[index].parts.some(part => part.kind === "tool-result")) return messages;
      return [...messages.slice(0, index), ...messages.slice(index + 1)];
    }
  }
  return messages;
}

// Edit keeps everything before the edited message; the edited text is sent
// as the new turn by the caller.
export function historyBeforeEdit(messages: ChatMessage[], index: number): ChatMessage[] {
  return messages.slice(0, Math.max(0, Math.min(index, messages.length)));
}

// After a reload of a mid-stream save, the partial answer stays visible with
// the same system-note shape the tool loop uses for side effects.
export function recoverConversationMessages(record: ConversationRecord): ChatMessage[] {
  if (!record.abortedStreaming) return record.messages;
  const note: ChatMessage = {
    role: "user",
    parts: [
      {
        kind: "text",
        markdown: "System note: the answer was interrupted by a page reload and may be incomplete.",
      },
    ],
  };
  return [...record.messages, note];
}

// Owner tag: a non-reversible digest of the client key. The server has no
// stable key alias the browser could reuse, and the key itself must not be
// stored; collisions only mix local history on this one device.
export function ownerTag(key: string | null): string {
  if (key === null) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

// Records are read back through storage and older schema versions, so each
// field is checked instead of trusting the shape.
export function toConversationRecord(value: unknown): ConversationRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.owner !== "string") return null;
  if (typeof record.title !== "string" || typeof record.pool !== "string") return null;
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return null;
  if (!Array.isArray(record.messages)) return null;
  if (typeof record.abortedStreaming !== "boolean") return null;
  const messages: ChatMessage[] = [];
  for (const message of record.messages) {
    if (typeof message !== "object" || message === null) return null;
    const { role, parts } = message as { role?: unknown; parts?: unknown };
    if (typeof role !== "string" || !Array.isArray(parts)) return null;
    messages.push(message as ChatMessage);
  }
  return {
    id: record.id,
    owner: record.owner,
    title: record.title,
    named: record.named === true,
    pool: record.pool,
    reasoningEffort: readReasoningEffort(record.reasoningEffort),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messages,
    abortedStreaming: record.abortedStreaming,
  };
}

function summaryOf(record: ConversationRecord): ConversationSummary {
  return {
    id: record.id,
    title: record.title,
    pool: record.pool,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    messageCount: record.messages.length,
  };
}

export function createChatStore(backend: StoreBackend, owner: string): ChatStore {
  const ownRecords = async (): Promise<ConversationRecord[]> =>
    (await backend.all())
      .map(toConversationRecord)
      .filter((record): record is ConversationRecord => record !== null && record.owner === owner);

  return {
    async list(): Promise<ConversationSummary[]> {
      return sortConversations(await ownRecords())
        .slice(0, STORE_LIMIT)
        .map(summaryOf);
    },
    async load(id: string): Promise<ConversationRecord | null> {
      return (await ownRecords()).find((record) => record.id === id) ?? null;
    },
    async save(input: SaveInput): Promise<ConversationSummary> {
      const existing = (await ownRecords()).find((record) => record.id === input.id);
      const record: ConversationRecord = {
        id: input.id,
        owner,
        title: existing?.named ? existing.title : input.title,
        named: existing?.named || input.named,
        pool: input.pool,
        reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort ?? "auto",
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        messages: input.messages,
        abortedStreaming: input.abortedStreaming,
      };
      await backend.put(record);
      // Keep the per-owner cap: evict the oldest past the limit.
      const stored = sortConversations(await ownRecords());
      for (const overflow of stored.slice(STORE_LIMIT)) {
        await backend.remove(overflow.id);
      }
      return summaryOf(record);
    },
    async rename(id, title) {
      const clean = title.trim().replace(/\s+/g, " ");
      if (!clean || clean.length > TITLE_CAP) throw new Error("Invalid conversation title");
      const record = (await ownRecords()).find((item) => item.id === id);
      if (!record) throw new Error("Conversation not found");
      const next = { ...record, title: clean, named: true };
      await backend.put(next);
      return summaryOf(next);
    },
    async remove(id: string): Promise<void> {
      if ((await ownRecords()).some((record) => record.id === id)) await backend.remove(id);
    },
    // Clears only this owner's conversations; other keys on the device keep
    // their history, and the server memory store is untouched.
    async clearAll(): Promise<void> {
      for (const record of await ownRecords()) {
        await backend.remove(record.id);
      }
    },
  };
}

// ---- IndexedDB backend (browser only) ----

const DB_NAME = "llm-router-chat";
const STORE_NAME = "conversations";
let dbPromise: Promise<IDBDatabase> | null = null;

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

function indexedDbBackend(db: IDBDatabase): StoreBackend {
  const store = (mode: IDBTransactionMode) => db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  return {
    async all(): Promise<unknown[]> {
      return (await idbRequest(store("readonly").getAll())) as unknown[];
    },
    async put(record: ConversationRecord): Promise<void> {
      await idbRequest(store("readwrite").put(record));
    },
    async remove(id: string): Promise<void> {
      await idbRequest(store("readwrite").delete(id));
    },
    async clear(): Promise<void> {
      await idbRequest(store("readwrite").clear());
    },
  };
}

// Opens (once) the browser database and binds it to the current owner tag.
// Returns null when IndexedDB is unavailable: the chat then works without
// persistence instead of failing.
export async function openChatStore(owner: string): Promise<ChatStore | null> {
  if (typeof indexedDB === "undefined") return null;
  try {
    return createChatStore(indexedDbBackend(await openDatabase()), owner);
  } catch {
    return null;
  }
}
