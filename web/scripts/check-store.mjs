// Self-check of the local conversation store: save/load round-trip, title
// derivation, owner scoping, the 200-conversation cap with oldest-first
// eviction, interrupted-answer recovery and the Regenerate/Edit history
// rules. A plain map stands in for IndexedDB, so no extra dependency and
// no browser database are needed. Run: node scripts/check-store.mjs.
import assert from "node:assert/strict";
import { createServer } from "vite";

function memoryBackend(seed = []) {
  const rows = new Map(seed.map((record) => [record.id, { ...record }]));
  return {
    async all() {
      return [...rows.values()].map((record) => JSON.parse(JSON.stringify(record)));
    },
    async put(record) {
      rows.set(record.id, JSON.parse(JSON.stringify(record)));
    },
    async remove(id) {
      rows.delete(id);
    },
    async clear() {
      rows.clear();
    },
  };
}

let checks = 0;
function test(name, body) {
  body();
  checks += 1;
  console.log(`ok ${name}`);
}

const server = await createServer({
  root: new URL("..", import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const storeModule = await server.ssrLoadModule("/src/chat/store.ts");
  const {
    createChatStore,
    conversationTitle,
    historyBeforeEdit,
    historyForRegenerate,
    ownerTag,
    recoverConversationMessages,
    sortConversations,
    STORE_LIMIT,
    TITLE_CAP,
  } = storeModule;

  const user = (text) => ({ role: "user", parts: [{ kind: "text", markdown: text }] });
  const assistant = (text) => ({ role: "assistant", parts: [{ kind: "text", markdown: text }] });

  test("save and load round-trip keeps serialized parts", async () => {
    const store = createChatStore(memoryBackend(), ownerTag("key-a"));
    const messages = [
      user("Compare WAL mode with the rollback journal."),
      {
        role: "assistant",
        parts: [
          { kind: "reasoning", text: "check sources", durationMs: 1200 },
          { kind: "tool", status: "completed", card: { tool: "memory_save", text: "note", saved: true } },
          { kind: "text", markdown: "**WAL** is faster." },
        ],
      },
    ];
    await store.save({ id: "c1", title: "t", pool: "coding", messages, abortedStreaming: false });
    const loaded = await store.load("c1");
    assert.deepEqual(loaded.messages, messages);
    assert.equal(loaded.pool, "coding");
    assert.equal(loaded.abortedStreaming, false);
    assert.equal(loaded.messageCount, undefined);
  });

  test("reasoning effort is local to a thread; old or unknown settings use Auto", async () => {
    const base = { owner: "me", title: "t", pool: "p", messages: [], createdAt: 1, updatedAt: 1, abortedStreaming: false };
    const store = createChatStore(memoryBackend([{ ...base, id: "old" }, { ...base, id: "bad", reasoningEffort: "extreme" }]), "me");
    for (const id of ["old", "bad"]) assert.equal((await store.load(id)).reasoningEffort, "auto");
    await store.save({ ...base, id: "old", reasoningEffort: "high" });
    await store.rename("old", "Hard questions");
    assert.equal((await store.load("old")).reasoningEffort, "high");
    assert.equal((await store.load("bad")).reasoningEffort, "auto");
    await store.save({ ...base, id: "old", reasoningEffort: "auto" });
    assert.equal((await store.load("old")).reasoningEffort, "auto");
  });

  test("title derives from the first user text, collapsed and capped", () => {
    assert.equal(conversationTitle([user("Hello\n  world")]), "Hello world");
    const long = "x".repeat(200);
    const title = conversationTitle([user(long)]);
    assert.equal(title.length, TITLE_CAP);
    assert.ok(title.endsWith("…"));
    assert.equal(title.slice(0, -1), "x".repeat(TITLE_CAP - 1));
    // The first message with text wins, not the first message overall.
    assert.equal(conversationTitle([{ role: "user", parts: [] }, user("second")]), "second");
    assert.equal(conversationTitle([assistant("only answer")]), "New conversation");
  });

  test("a named empty chat keeps its name after a turn and a reload", async () => {
    const backend = memoryBackend();
    const store = createChatStore(backend, "mine");
    const draft = { id: "a", pool: "lab", messages: [], abortedStreaming: false, title: "New conversation" };
    await store.save(draft);
    assert.equal((await store.rename("a", "  Design   review  ")).title, "Design review");
    const other = createChatStore(backend, "other");
    await assert.rejects(other.rename("a", "wrong owner"));
    await other.remove("a");
    await assert.rejects(store.rename("a", " "));
    await assert.rejects(store.rename("a", "x".repeat(TITLE_CAP + 1)));
    await store.save({ ...draft, title: "First question", messages: [user("First question")] });
    assert.equal((await createChatStore(backend, "mine").load("a")).title, "Design review");
    assert.equal((await store.save({ ...draft, id: "b", title: "Another thread" })).title, "Another thread");
  });

  test("list sorts by updatedAt desc", async () => {
    // Seeded directly: save() stamps Date.now(), which ties in a fast loop.
    const base = { owner: "o1", title: "t", pool: "p", createdAt: 1, messages: [user("m")], abortedStreaming: false };
    const store = createChatStore(
      memoryBackend([
        { ...base, id: "old", updatedAt: 100 },
        { ...base, id: "new", updatedAt: 300 },
        { ...base, id: "mid", updatedAt: 200 },
      ]),
      "o1",
    );
    const listed = await store.list();
    assert.deepEqual(listed.map((item) => item.id), ["new", "mid", "old"]);
    assert.equal(listed[0].messageCount, 1);
    assert.deepEqual(
      sortConversations([{ updatedAt: 2 }, { updatedAt: 9 }, { updatedAt: 5 }]).map((r) => r.updatedAt),
      [9, 5, 2],
    );
  });

  test("owner scoping hides other keys and clearAll keeps them", async () => {
    const backend = memoryBackend();
    const mine = createChatStore(backend, ownerTag("key-a"));
    const other = createChatStore(backend, ownerTag("key-b"));
    await mine.save({ id: "m1", title: "mine", pool: "p", messages: [user("hi")], abortedStreaming: false });
    await other.save({ id: "o1", title: "other", pool: "p", messages: [user("ho")], abortedStreaming: false });
    assert.deepEqual((await mine.list()).map((item) => item.id), ["m1"]);
    assert.equal(await mine.load("o1"), null);
    await mine.clearAll();
    assert.deepEqual(await mine.list(), []);
    assert.deepEqual((await other.list()).map((item) => item.id), ["o1"]);
  });

  test("store caps at 200 conversations and evicts the oldest", async () => {
    // Seeded with distinct past stamps so "oldest" is unambiguous; the
    // fresh save carries Date.now() and is always the newest.
    const seed = [];
    for (let index = 0; index < STORE_LIMIT; index += 1) {
      seed.push({
        id: `c${index}`,
        owner: "cap",
        title: `c${index}`,
        pool: "p",
        createdAt: index,
        updatedAt: index,
        messages: [user("m")],
        abortedStreaming: false,
      });
    }
    const store = createChatStore(memoryBackend(seed), "cap");
    assert.equal((await store.list()).length, STORE_LIMIT);
    await store.save({ id: "fresh", title: "fresh", pool: "p", messages: [user("m")], abortedStreaming: false });
    const ids = (await store.list()).map((item) => item.id);
    assert.equal(ids.length, STORE_LIMIT);
    assert.equal(ids[0], "fresh");
    assert.ok(!ids.includes("c0"), "oldest evicted");
    assert.ok(ids.includes(`c${STORE_LIMIT - 1}`));
    assert.equal(await store.load("c0"), null);
  });

  test("remove deletes one conversation", async () => {
    const store = createChatStore(memoryBackend(), "o");
    await store.save({ id: "a", title: "a", pool: "p", messages: [user("x")], abortedStreaming: false });
    await store.save({ id: "b", title: "b", pool: "p", messages: [user("y")], abortedStreaming: false });
    await store.remove("a");
    assert.equal(await store.load("a"), null);
    assert.deepEqual((await store.list()).map((item) => item.id), ["b"]);
  });

  test("abortedStreaming record recovers with an interrupted note", async () => {
    const store = createChatStore(memoryBackend(), "o");
    const messages = [user("question"), { role: "assistant", parts: [{ kind: "text", markdown: "partial an" }] }];
    await store.save({ id: "i1", title: "t", pool: "p", messages, abortedStreaming: true });
    const record = await store.load("i1");
    assert.equal(record.abortedStreaming, true);
    const recovered = recoverConversationMessages(record);
    assert.equal(recovered.length, 3);
    const note = recovered[recovered.length - 1];
    assert.equal(note.role, "user");
    assert.match(note.parts[0].markdown, /^System note: /);
    assert.match(note.parts[0].markdown, /interrupted/);
    // A completed record is returned unchanged.
    await store.save({ id: "i2", title: "t", pool: "p", messages, abortedStreaming: false });
    assert.deepEqual(recoverConversationMessages(await store.load("i2")), messages);
  });

  test("regenerate drops the last assistant message only", () => {
    const history = [user("q1"), assistant("a1"), user("q2"), assistant("partial")];
    assert.deepEqual(historyForRegenerate(history), [user("q1"), assistant("a1"), user("q2")]);
    // A system note after the answer survives and becomes the last turn.
    const note = user("System note: pool switched");
    assert.deepEqual(historyForRegenerate([user("q"), assistant("a"), note]), [user("q"), note]);
    assert.deepEqual(historyForRegenerate([user("q")]), [user("q")]);
    assert.deepEqual(historyForRegenerate([]), []);
    const saved = { role: "assistant", parts: [{ kind: "tool-result", id: "id", name: "pool_update", ok: true, content: "saved" }] };
    assert.deepEqual(historyForRegenerate([user("q"), saved, assistant("bad answer")]), [user("q"), saved]);
    assert.deepEqual(historyForRegenerate([user("q"), saved]), [user("q"), saved]);
  });

  test("edit keeps the history before the edited message", () => {
    const history = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
    assert.deepEqual(historyBeforeEdit(history, 2), [user("q1"), assistant("a1")]);
    assert.deepEqual(historyBeforeEdit(history, 0), []);
    assert.deepEqual(historyBeforeEdit(history, 99), history);
    assert.deepEqual(historyBeforeEdit(history, -1), []);
  });

  test("ownerTag never stores the key and separates keys", () => {
    assert.equal(ownerTag(null), "");
    const a = ownerTag("secret-key-a");
    const b = ownerTag("secret-key-b");
    assert.notEqual(a, b);
    assert.equal(a, ownerTag("secret-key-a"));
    assert.match(a, /^[0-9a-f]+$/);
  });
} finally {
  await server.close();
}
console.log(`${checks} chat store checks passed`);
