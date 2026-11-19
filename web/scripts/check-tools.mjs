// Self-check of the tools dispatcher: registry validation, permission
// filtering, bridge error mapping, and the tool loop with a scripted
// fetch. Run: node scripts/check-tools.mjs — no network, no long timers.
import assert from "node:assert/strict";
import { createServer } from "vite";

// keyStore reads browser storage; the harness provides a stub before any
// chat module that uses it is loaded.
const stored = new Map();
const storageStub = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
  removeItem: (key) => stored.delete(key),
};
globalThis.localStorage = storageStub;
globalThis.sessionStorage = storageStub;
stored.set("llm-router.key", "test-key");

const encoder = new TextEncoder();

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const jsonResponse = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const content = (text) => event({ choices: [{ delta: { content: text } }] });
const toolCall = (call) => event({ choices: [{ delta: { tool_calls: [call] } }] });
const sseResponse = (wire) =>
  new Response(streamOf(encoder.encode(wire)), { status: 200, headers: { "content-type": "text/event-stream" } });

// A fetch stub that records every call and routes by URL. Tests that stub
// the global run serialized so routes never leak into each other; `nth`
// counts calls per URL.
const fetchLog = [];
function routeFetch(route) {
  const counters = new Map();
  return async (url, init = {}) => {
    const nth = (counters.get(url) ?? 0) + 1;
    counters.set(url, nth);
    fetchLog.push({ url, init });
    const respond = route[url];
    if (respond === undefined) throw new Error(`unexpected fetch ${url}`);
    return respond(init, nth);
  };
}
let fetchChain = Promise.resolve();
function withFetch(route, body) {
  const run = async () => {
    const original = globalThis.fetch;
    globalThis.fetch = routeFetch(route);
    try {
      return await body();
    } finally {
      globalThis.fetch = original;
    }
  };
  const result = fetchChain.then(run, run);
  fetchChain = result.catch(() => {});
  return result;
}

let checks = 0;
const tests = [];
function test(name, body) {
  checks += 1;
  tests.push(
    Promise.resolve()
      .then(body)
      .then(
        () => console.log(`ok ${name}`),
        (error) => {
          console.error(`FAIL ${name}`);
          throw error;
        },
      ),
  );
}

const server = await createServer({
  root: new URL("..", import.meta.url).pathname,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
try {
  const [registry, loop, history] = await Promise.all([
    server.ssrLoadModule("/src/chat/tools/registry.ts"),
    server.ssrLoadModule("/src/chat/tool-loop.ts"),
    server.ssrLoadModule("/src/chat/openai-history.ts"),
  ]);
  const { TOOLS, openAiToolSpecs, dispatchTool } = registry;
  const { runChatTurns, TOOL_LOOP_LIMIT, TOOL_CALL_LIMIT } = loop;
  const { toOpenAIMessages } = history;

  const baseCtx = (over = {}) => ({
    depth: 0,
    signal: new AbortController().signal,
    confirm: () => true,
    pools: {
      list: async () => [{ name: "coding", members: [{ provider_id: "openrouter", upstream_id: "qwen3" }] }],
      put: async () => {},
    },
    selectPool: () => {},
    ...over,
  });

  const hangUntilAbort = (init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  const searchOk = () =>
    jsonResponse({
      items: [{ source_id: "s1", title: "WAL", url: "https://x", snippet: "log" }],
      provider_used: "deepseek",
      fallback_used: false,
    });

  test("the registry lists thirty tools with unique names and gates", () => {
    assert.equal(TOOLS.length, 30);
    const names = TOOLS.map((tool) => tool.name);
    assert.equal(new Set(names).size, 30);
    const gates = new Set(TOOLS.map((tool) => tool.permission));
    assert.deepEqual([...gates].sort(), ["javascript", "memory", "poolActions", "poolRead", "sources", "system", "usage", "webSearch", "wiki"]);
    for (const tool of TOOLS) {
      assert.equal(tool.parameters.type, "object");
      assert.ok(tool.description.length > 10);
      assert.equal(typeof tool.execute, "function");
    }
  });

  test("openAiToolSpecs filters schemas by the permissions state", () => {
    const onlyWeb = openAiToolSpecs({ webSearch: true, sources: false, memory: false, javascript: false, poolActions: false, poolRead: false });
    assert.deepEqual(onlyWeb.map((spec) => spec.function.name), ["web_search"]);
    assert.deepEqual(Object.keys(onlyWeb[0]), ["type", "function"]);
    assert.deepEqual(
      Object.keys(onlyWeb[0].function).sort(),
      ["description", "name", "parameters"],
    );
    const none = openAiToolSpecs({ webSearch: false, sources: false, memory: false, javascript: false, poolActions: false, poolRead: false });
    assert.deepEqual(none, []);
    assert.equal(openAiToolSpecs({ webSearch: true, sources: true, memory: true, javascript: true, poolActions: true, poolRead: true }).length, 15);
    assert.equal(openAiToolSpecs({ webSearch: true, sources: true, memory: true, javascript: true, poolActions: true, poolRead: true, usage: true, wiki: true, system: true }).length, 30);
  });

  test("dispatchTool rejects unknown tools and broken argument JSON", async () => {
    const unknown = await dispatchTool("rm_rf", "{}", baseCtx());
    assert.deepEqual(unknown, { ok: false, error: { type: "not_found", message: "unknown tool: rm_rf" } });
    const broken = await dispatchTool("web_search", '{"query":', baseCtx());
    assert.equal(broken.ok, false);
    assert.equal(broken.error.type, "invalid_arguments");
    const missing = await dispatchTool("web_search", "{}", baseCtx());
    assert.equal(missing.ok, false);
    assert.equal(missing.error.type, "invalid_arguments");
    const wrongType = await dispatchTool("memory_delete", '{"id":"seven"}', baseCtx());
    assert.equal(wrongType.ok, false);
    assert.equal(wrongType.error.type, "invalid_arguments");
  });

  test("web_search posts to the search route with the stored key and returns items", () =>
    withFetch({ "/v1/chat/search": searchOk }, async () => {
      const outcome = await dispatchTool("web_search", '{"query":"sqlite wal","count":3}', baseCtx());
      assert.equal(outcome.ok, true);
      const parsed = JSON.parse(outcome.result);
      assert.equal(parsed.items[0].source_id, "s1");
      assert.equal(parsed.provider_used, "deepseek");
      assert.equal(parsed.fallback_used, false);
      const call = fetchLog.at(-1);
      assert.equal(call.url, "/v1/chat/search");
      assert.equal(call.init.headers.authorization, "Bearer test-key");
      assert.deepEqual(JSON.parse(call.init.body), { query: "sqlite wal", count: 3 });
    }));

  test("read_source returns the page markdown with its title", () =>
    withFetch(
      {
        "/v1/chat/read-source": () =>
          jsonResponse({ url: "https://x", title: "WAL", content_markdown: "# body", chars: 5, truncated: false }),
      },
      async () => {
        const outcome = await dispatchTool("read_source", '{"source_id":"s1"}', baseCtx());
        assert.deepEqual(outcome, { ok: true, result: "# WAL\nhttps://x\n\n# body" });
      },
    ));

  test("expired and not_found endpoint errors pass through typed", () =>
    withFetch(
      {
        "/v1/chat/read-source": () => jsonResponse({ error: { type: "expired", message: "source expired, search again" } }, 410),
        "/v1/chat/memory/edit": () => jsonResponse({ error: { type: "not_found", message: "no memory entry with this id" } }, 404),
      },
      async () => {
        const expired = await dispatchTool("read_source", '{"source_id":"s1"}', baseCtx());
        assert.deepEqual(expired, { ok: false, error: { type: "expired", message: "source expired, search again" } });
        const missing = await dispatchTool("memory_edit", '{"id":9,"topic":"t","note":"n"}', baseCtx());
        assert.deepEqual(missing, { ok: false, error: { type: "not_found", message: "no memory entry with this id" } });
      },
    ));

  test("a per-call timeout maps to provider_unavailable and user stop to aborted", () =>
    withFetch({ "/v1/chat/search": hangUntilAbort }, async () => {
      const timedOut = await dispatchTool("web_search", '{"query":"x"}', baseCtx(), 40);
      assert.equal(timedOut.ok, false);
      assert.equal(timedOut.error.type, "provider_unavailable");
      assert.match(timedOut.error.message, /timed out/);
    }).then(async () => {
      const stopped = new AbortController();
      stopped.abort();
      const aborted = await dispatchTool("web_search", '{"query":"x"}', baseCtx({ signal: stopped.signal }), 40);
      assert.deepEqual(aborted, { ok: false, error: { type: "aborted", message: "stopped by the user" } });
    }));

  test("memory save and recall round-trip through the endpoints", () =>
    withFetch(
      {
        "/v1/chat/memory/save": () => jsonResponse({ id: 7 }),
        "/v1/chat/memory/recall": (init) =>
          jsonResponse(
            JSON.parse(init.body).query === "none"
              ? { entries: [] }
              : { entries: [{ id: 7, topic: "db", note: "wal is fine", created_at: 1, updated_at: 1 }] },
          ),
      },
      async () => {
        const saved = await dispatchTool("memory_save", '{"topic":"db","note":"wal is fine"}', baseCtx());
        assert.deepEqual(saved, { ok: true, result: "Saved memory entry 7." });
        const recalled = await dispatchTool("memory_recall", '{"query":"db"}', baseCtx());
        assert.equal(recalled.ok, true);
        assert.deepEqual(JSON.parse(recalled.result), [{ id: 7, topic: "db", note: "wal is fine" }]);
        const empty = await dispatchTool("memory_recall", '{"query":"none"}', baseCtx());
        assert.equal(empty.result, "No saved notes match this query.");
      },
    ));

  test("router_ask_pool refuses nesting and sends one plain sub-request", () =>
    withFetch({ "/v1/chat/completions": () => jsonResponse({ choices: [{ message: { content: "short answer" } }] }) }, async () => {
      const nested = await dispatchTool("router_ask_pool", '{"pool":"fast","prompt":"hi"}', baseCtx({ depth: 1 }));
      assert.equal(nested.ok, false);
      assert.equal(nested.error.type, "last_tool");

      const short = await dispatchTool("router_ask_pool", '{"pool":"fast","prompt":"hi"}', baseCtx());
      assert.deepEqual(short, { ok: true, result: "short answer" });
      const body = JSON.parse(fetchLog.at(-1).init.body);
      assert.deepEqual(body, { model: "fast", messages: [{ role: "user", content: "hi" }], stream: false });
      assert.equal("tools" in body, false);
    }));

  test("router_ask_pool flags a cut answer", () =>
    withFetch({ "/v1/chat/completions": () => jsonResponse({ choices: [{ message: { content: "x".repeat(16010) } }] }) }, async () => {
      const cut = await dispatchTool("router_ask_pool", '{"pool":"fast","prompt":"hi"}', baseCtx());
      assert.equal(cut.ok, true);
      const parsed = JSON.parse(cut.result);
      assert.equal(parsed.answer.length, 16000);
      assert.equal(parsed.truncated, true);
    }));

  test("pool tools read and mutate through the bridge with confirmation", async () => {
    const puts = [];
    let listed = 0;
    const pools = {
      list: async () => {
        listed += 1;
        return [{ name: "coding", members: [{ provider_id: "openrouter", upstream_id: "qwen3" }] }];
      },
      put: async (name, members) => puts.push({ name, members }),
    };
    const info = await dispatchTool("pool_info", '{"name":"coding"}', baseCtx({ pools }));
    assert.equal(info.ok, true);
    const listed0 = listed;

    let confirmed = false;
    const add = await dispatchTool(
      "pool_add_model",
      '{"pool":"coding","provider_id":"openrouter","upstream_id":"gpt-x"}',
      baseCtx({ pools, confirm: () => confirmed }),
    );
    assert.equal(add.ok, false);
    assert.equal(add.error.type, "declined");
    assert.equal(puts.length, 0);

    confirmed = true;
    const added = await dispatchTool(
      "pool_add_model",
      '{"pool":"coding","provider_id":"openrouter","upstream_id":"gpt-x"}',
      baseCtx({ pools, confirm: () => confirmed }),
    );
    assert.equal(added.ok, true);
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], {
      name: "coding",
      members: [
        { provider_id: "openrouter", upstream_id: "qwen3" },
        { provider_id: "openrouter", upstream_id: "gpt-x" },
      ],
    });
    assert.ok(listed > listed0);

    let selected = null;
    const switchPool = await dispatchTool("pool_select", '{"name":"coding"}', baseCtx({ pools, selectPool: (name) => (selected = name) }));
    assert.deepEqual(switchPool, { ok: true, result: "The active pool switched to coding." });
    assert.equal(selected, "coding");
    const missing = await dispatchTool("pool_select", '{"name":"ghost"}', baseCtx({ pools, selectPool: () => {} }));
    assert.equal(missing.error.type, "not_found");
  });

  test("usage tools preserve unknown cost and forward filters", async () => {
    const queries = [];
    const management = {
      usage: async (query) => {
        queries.push(query);
        return { buckets: [], totals: { cost: null, cost_reports: 0 }, truncated: false, calls: 0 };
      },
    };
    const result = await dispatchTool(
      "usage_stats",
      '{"group_by":"model","bucket":"hour","since_unix":100,"to_unix":200,"pool":"coding"}',
      baseCtx({ management }),
    );
    assert.equal(result.ok, true);
    assert.equal(queries.length, 1);
    assert.deepEqual(queries[0], {
      bucket: "hour", groupBy: "model", sinceUnix: 100, toUnix: 200, limit: 500,
      provider: undefined, model: undefined, key: undefined, pool: "coding",
    });
    assert.equal(JSON.parse(result.result).totals.cost, null);
    const invalid = await dispatchTool("usage_stats", '{"group_by":"magic"}', baseCtx({ management }));
    assert.equal(invalid.error.type, "invalid_arguments");
    assert.equal(queries.length, 1);
  });

  test("request and wiki tools use the management bridge without inventing data", async () => {
    let requestQuery;
    let knowledgeId;
    const management = {
      requests: async (query) => {
        requestQuery = query;
        return [{ id: "r1", attempts: [] }];
      },
      modelKnowledge: async (id) => {
        knowledgeId = id;
        return { key: id, card: null, fresh: false };
      },
    };
    const requests = await dispatchTool(
      "request_list",
      '{"limit":500,"before_id":"r0","key_alias":"home","outcome":"error"}',
      baseCtx({ management }),
    );
    assert.equal(requests.ok, true);
    assert.equal(requestQuery.limit, 50);
    assert.equal(requestQuery.beforeId, "r0");
    assert.equal(requestQuery.keyAlias, "home");
    const wiki = await dispatchTool("model_wiki", '{"upstream_id":"qwen3"}', baseCtx({ management }));
    assert.equal(JSON.parse(wiki.result).card, null);
    assert.equal(knowledgeId, "qwen3");
  });

  test("pool create, replace and delete cover the pool editor with confirmation", async () => {
    const puts = [];
    const deleted = [];
    const pools = {
      list: async () => [{ name: "coding", members: [{ provider_id: "openrouter", upstream_id: "qwen3" }] }],
      put: async (name, members, createOnly) => puts.push({ name, members, createOnly }),
      delete: async (name) => deleted.push(name),
    };
    const members = [{ provider_id: "deepseek", upstream_id: "deepseek-chat" }];
    const created = await dispatchTool(
      "pool_create",
      JSON.stringify({ name: "research", members }),
      baseCtx({ pools }),
    );
    assert.equal(created.ok, true);
    assert.equal(puts[0].createOnly, true);
    const replaced = await dispatchTool(
      "pool_replace",
      JSON.stringify({ name: "coding", members }),
      baseCtx({ pools }),
    );
    assert.equal(replaced.ok, true);
    assert.equal(puts[1].createOnly, undefined);
    assert.deepEqual(puts[1].members, members);
    const removed = await dispatchTool("pool_delete", '{"name":"research"}', baseCtx({ pools }));
    assert.equal(removed.ok, true);
    assert.deepEqual(deleted, ["research"]);
    const invalid = await dispatchTool("pool_create", '{"name":"bad","members":[]}', baseCtx({ pools }));
    assert.equal(invalid.error.type, "invalid_arguments");
    assert.equal(puts.length, 2);
  });

  test("research, refresh and every pool mutation require confirmation", async () => {
    const confirmed = TOOLS.filter((tool) => tool.requiresConfirmation).map((tool) => tool.name).sort();
    assert.deepEqual(confirmed, [
      "data_refresh", "model_wiki_research", "pool_add_model",
      "pool_create", "pool_delete", "pool_replace",
    ]);
    let researched = 0;
    const management = { collectKnowledge: async () => { researched += 1; return { collected: true }; } };
    const declined = await dispatchTool(
      "model_wiki_research",
      '{"provider_id":"openrouter","upstream_id":"qwen3"}',
      baseCtx({ management, confirm: () => false }),
    );
    assert.equal(declined.error.type, "declined");
    assert.equal(researched, 0);
  });

  test("the javascript tool reports the sandbox as unavailable without Workers", async () => {
    const outcome = await dispatchTool("javascript", '{"code":"1+1"}', baseCtx());
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error.type, "sandbox_unavailable");
    assert.match(outcome.error.message, /sandbox/);
  });

  test("the real QuickJS worker completes teardown before sending exactly one result", async () => {
    const previous = globalThis.self;
    const replies = [];
    const port = { postMessage: reply => replies.push(reply) };
    globalThis.self = port;
    try {
      await server.ssrLoadModule("/src/chat/sandbox/quickjs-worker.ts");
      const call = async (code, input) => {
        replies.length = 0;
        await port.onmessage({ data: { code, input } });
        assert.equal(replies.length, 1, "cleanup must not crash after a successful reply");
        return replies[0];
      };
      assert.deepEqual(await call('console.log("count", input.length); input.reduce((a,b) => a+b)', [2, 3]), { stdout: "count 2", result: 5 });
      const bad = await call('throw new TypeError("bad sample")');
      assert.equal(bad.errorType, "javascript_error");
      assert.match(bad.error, /TypeError: bad sample/);
      const syntax = await call('return 1');
      assert.equal(syntax.errorType, "javascript_error");
      assert.match(syntax.error, /SyntaxError/);
      assert.equal((await call('typeof input + "/" + typeof fetch + "/" + typeof document')).result, "undefined/undefined/undefined");
    } finally {
      if (previous === undefined) delete globalThis.self;
      else globalThis.self = previous;
    }
  });

  test("the serializer emits tool messages answering each call id", () => {
    const messages = [
      { role: "user", parts: [{ kind: "text", markdown: "q" }] },
      {
        role: "assistant",
        parts: [
          { kind: "tool-call", id: "c1", name: "web_search", arguments: "{}", state: "ready" },
          { kind: "tool-result", id: "c1", name: "web_search", ok: true, content: "[]" },
          { kind: "tool-call", name: "pool_list", arguments: "{}", state: "ready" },
          { kind: "tool-result", id: "call_1", name: "pool_list", ok: false, content: '{"type":"not_found"}' },
        ],
      },
    ];
    assert.deepEqual(toOpenAIMessages(messages), [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "web_search", arguments: "{}" } },
          { id: "call_1", type: "function", function: { name: "pool_list", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "[]" },
      { role: "tool", tool_call_id: "call_1", content: '{"type":"not_found"}' },
    ]);
  });

  // ---- Tool loop: a scripted global fetch drives whole conversations. ----

  const userTurn = { role: "user", parts: [{ kind: "text", markdown: "q" }] };

  const runLoop = (route, over = {}) => {
    const statuses = [];
    return withFetch(route, async () => {
      // Counted inside the stub window so other tests never skew it.
      const loopStart = fetchLog.length;
      const outcome = await runChatTurns({
        history: [userTurn],
        pool: "coding",
        signal: new AbortController().signal,
        authKey: () => null,
        events: {
          onMessages: () => {},
          onStatus: (status) => statuses.push(status),
        },
        ...over,
      });
      return { outcome, statuses, calls: fetchLog.slice(loopStart) };
    });
  };

  test("only explicit chat effort goes on the wire", async () => {
    for (const effort of [undefined, "auto", "typo", "low", "medium", "high"]) {
      const { calls } = await runLoop({ "/v1/chat/completions": () => sseResponse(content("ok") + "data: [DONE]\n\n") },
        { reasoningEffort: effort });
      const body = JSON.parse(calls[0].init.body);
      if (["low", "medium", "high"].includes(effort)) assert.equal(body.reasoning_effort, effort);
      else assert.ok(!("reasoning_effort" in body));
    }
  });

  test("resuming saved display-only assistant turns sends no empty assistant to Kimi", async () => {
    const history = [userTurn, { role: "assistant", parts: [] },
      { role: "assistant", parts: [{ kind: "reasoning", text: "thinking", durationMs: 20 }] },
      { role: "assistant", parts: [{ kind: "text", markdown: "  \n " }] },
      { role: "assistant", parts: [{ kind: "text", markdown: "  partial answer" }] }, userTurn];
    const { calls } = await runLoop({ "/v1/chat/completions": () => sseResponse(content("done") + "data: [DONE]\n\n") }, { history });
    assert.deepEqual(JSON.parse(calls[0].init.body).messages, [
      { role: "user", content: "q" }, { role: "assistant", content: "  partial answer" }, { role: "user", content: "q" },
    ]);
  });

  test("split DSML in assistant text is a format error, never an executable call", async () => {
    const raw = '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="pool_delete">';
    const { outcome, calls, statuses } = await runLoop({
      "/v1/chat/completions": () => sseResponse(content(raw.slice(0, 6)) + content(raw.slice(6)) + "data: [DONE]\n\n"),
    });
    assert.match(outcome.error ?? "", /tool markup/i);
    assert.equal(calls.length, 1);
    assert.deepEqual(statuses, ["streaming"]);
    assert.equal(outcome.messages.at(-1).parts[0].markdown, raw);
    assert.deepEqual(toOpenAIMessages(outcome.messages), [{ role: "user", content: "q" }]);
  });

  test("user retry carries recorded results and requests structured calls, not raw markup", async () => {
    const history = [userTurn, { role: "assistant", parts: [
      { kind: "tool-call", name: "memory_save", id: "saved", state: "ready", arguments: "{}" },
      { kind: "tool-result", name: "memory_save", id: "saved", ok: true, content: "already saved" },
    ] }];
    const { calls } = await runLoop({ "/v1/chat/completions": () => sseResponse(content("done") + "data: [DONE]\n\n") },
      { history, retryToolFormat: true });
    const payload = JSON.parse(calls[0].init.body);
    assert.equal(payload.messages[0].role, "system");
    assert.deepEqual(payload.messages.at(-1), { role: "tool", tool_call_id: "saved", content: "already saved" });
    assert.equal(calls.length, 1);
  });

  test("the loop executes a tool call and sends results in the next request", async () => {
    const completionsWire =
      toolCall({ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":"wal"}' } }) +
      "data: [DONE]\n\n";
    const { outcome, calls, statuses } = await runLoop({
      "/v1/chat/completions": (_init, nth) =>
        nth === 1 ? sseResponse(completionsWire) : sseResponse(content("done") + "data: [DONE]\n\n"),
      "/v1/chat/search": searchOk,
    }, { reasoningEffort: "high" });
    assert.equal(outcome.error, null);
    assert.equal(outcome.stopped, false);
    assert.equal(calls.filter((call) => call.url === "/v1/chat/completions").length, 2);
    const completions = calls.filter((call) => call.url === "/v1/chat/completions");
    const first = JSON.parse(completions[0].init.body);
    assert.equal(first.tools.length, 30);
    const second = JSON.parse(completions[1].init.body);
    assert.equal(first.reasoning_effort, "high");
    assert.equal(second.reasoning_effort, "high");
    assert.deepEqual(second.messages.at(-1), {
      role: "tool",
      tool_call_id: "c1",
      content: JSON.stringify({
        items: [{ source_id: "s1", title: "WAL", url: "https://x", snippet: "log" }],
        provider_used: "deepseek",
        fallback_used: false,
      }),
    });
    // The assistant turn keeps its tool calls and results together.
    assert.equal(second.messages.at(-2).tool_calls[0].id, "c1");
    assert.equal(second.messages.at(-3).role, "user");
    const results = outcome.messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool-result"));
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.deepEqual(statuses, ["streaming", "working", "streaming"]);
  });

  test("invalid tool arguments come back to the model as a typed error", async () => {
    const wire =
      toolCall({ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":' } }) +
      "data: [DONE]\n\n";
    const { outcome, calls } = await runLoop({
      "/v1/chat/completions": (_init, nth) =>
        nth === 1 ? sseResponse(wire) : sseResponse(content("ok") + "data: [DONE]\n\n"),
    });
    const results = outcome.messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool-result"));
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    const second = JSON.parse(calls.filter((c) => c.url === "/v1/chat/completions")[1].init.body);
    assert.equal(second.messages.at(-1).role, "tool");
    assert.deepEqual(JSON.parse(second.messages.at(-1).content), {
      type: "invalid_arguments",
      message: "arguments of web_search are not valid JSON",
    });
  });

  test("slow generation does not use up time reserved for tools", async () => {
    let clock = 0;
    const wire = toolCall({ index: 0, id: "w1", function: { name: "model_wiki", arguments: '{"upstream_id":"test"}' } }) + 'data: [DONE]\n\n';
    const { outcome } = await runLoop({ '/v1/chat/completions': (_init, nth) => {
      clock += 70_000;
      return sseResponse(nth === 1 ? wire : content('done') + 'data: [DONE]\n\n');
    } }, { now: () => clock, management: { modelKnowledge: async () => ({ card: null }) } });
    assert.equal(outcome.messages.flatMap(m => m.parts).find(p => p.kind === 'tool-result').ok, true);
  });

  test("tool execution still spends the time budget and leaves one final model answer", async () => {
    let clock = 0, reads = 0;
    const wire = [0, 1].map(i => toolCall({index:i, id:`t${i}`, function:{name:"model_wiki", arguments:'{"upstream_id":"x"}'}})).join("") + "data: [DONE]\n\n";
    const {outcome, calls} = await runLoop({"/v1/chat/completions": (_init,n) => sseResponse(n === 1 ? wire : content("partial answer") + "data: [DONE]\n\n")},
      {now: () => clock, management:{modelKnowledge: async () => {clock += 60_000; reads++; return {card:null};}}});
    assert.equal(reads, 1);
    const last = outcome.messages.flatMap(m => m.parts).filter(p => p.kind === "tool-result").at(-1);
    assert.match(JSON.parse(last.content).message, /time budget/);
    assert.equal("tools" in JSON.parse(calls.at(-1).init.body), false);
  });

  test("wiki inventory reads up to 100 distinct local cards and returns the next offset", async () => {
    const keys = Array.from({length: 101}, (_,i) => `model-${String(i).padStart(3,'0')}`);
    let batch;
    const management = { catalog: async () => [...keys, keys[0]].map(knowledge_key => ({knowledge_key, provider_id:'local'})),
      modelSummaries: async ids => { batch = ids; return [{key:ids[0]}]; } };
    const query = async offset => JSON.parse((await dispatchTool('model_wiki', JSON.stringify({inventory:true,offset}), baseCtx({management}))).result);
    const first = await query(0);
    assert.equal(first.total_models,101); assert.equal(batch.length,100); assert.equal(first.next_offset,100);
    assert.deepEqual(first.with_card,[keys[0]]); assert.equal(first.without_card.length,99);
    assert.equal((await query(100)).next_offset,null); assert.deepEqual(batch,[keys[100]]);
  });

  test("local Wiki reads allow 100 across steps without raising the limit for writes", async () => {
    let reads = 0;
    const many = n => Array.from({length:n}, (_, i) => toolCall({index:i, id:`w${i}`, function:{name:"model_wiki",arguments:'{"upstream_id":"x"}'}})).join("") + "data: [DONE]\n\n";
    const {outcome} = await runLoop({"/v1/chat/completions": (_init,n) => sseResponse(n === 1 ? many(60) : n === 2 ? many(41) : content("done") + "data: [DONE]\n\n")},
      {management:{modelKnowledge: async () => {reads++; return {card:null};}}});
    assert.equal(reads, 100);
    const last = outcome.messages.flatMap(m => m.parts).filter(p => p.kind === "tool-result").at(-1);
    assert.equal(JSON.parse(last.content).type, "tool_limit_exceeded");
  });

  test("more than eight calls in one turn stop at the call cap", async () => {
    let listed = 0;
    const pools = { list: async () => { listed += 1; return []; }, put: async () => {} };
    const wire =
      Array.from({ length: TOOL_CALL_LIMIT + 1 }, (_, i) =>
        toolCall({ index: i, id: `c${i}`, function: { name: "pool_list", arguments: "{}" } }),
      ).join("") + "data: [DONE]\n\n";
    const { outcome, calls } = await runLoop(
      {
        "/v1/chat/completions": (_init, nth) =>
          nth === 1 ? sseResponse(wire) : sseResponse(content("ok") + "data: [DONE]\n\n"),
      },
      { pools },
    );
    assert.equal(listed, TOOL_CALL_LIMIT);
    const results = outcome.messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool-result"));
    assert.equal(results.length, TOOL_CALL_LIMIT + 1);
    assert.equal(results[TOOL_CALL_LIMIT].ok, false);
    assert.deepEqual(JSON.parse(results[TOOL_CALL_LIMIT].content).type, "tool_limit_exceeded");
    assert.equal(calls.filter((call) => call.url === "/v1/chat/completions").length, 2);
  });

  test("stream metrics use the first output delta and upstream usage", async () => {
    const wire =
      event({ choices: [{ delta: {} }] }) +
      content("done") +
      event({ choices: [], usage: { completion_tokens: 100 } }) +
      "data: [DONE]\n\n";
    const times = [0, 120, 2120];
    const { outcome, calls } = await runLoop(
      { "/v1/chat/completions": () => sseResponse(wire) },
      { now: () => times.shift() ?? 2120 },
    );
    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.messages.at(-1).metrics, {
      ttftMs: 120,
      outputTokens: 100,
      tokensPerSecond: 50,
    });
    assert.deepEqual(JSON.parse(calls[0].init.body).stream_options, { include_usage: true });
  });

  test("stream metrics omit token speed when upstream sends no usage", async () => {
    const times = [0, 80, 1080];
    const { outcome } = await runLoop(
      { "/v1/chat/completions": () => sseResponse(content("done") + "data: [DONE]\n\n") },
      { now: () => times.shift() ?? 1080 },
    );
    assert.deepEqual(outcome.messages.at(-1).metrics, { ttftMs: 80 });
  });

  test("a loop at the cap gets one final response without tools", async () => {
    const wire =
      toolCall({ index: 0, id: "c1", function: { name: "web_search", arguments: '{"query":"x"}' } }) +
      "data: [DONE]\n\n";
    const bodies = [];
    const { outcome, calls } = await runLoop({
      "/v1/chat/completions": (init, nth) => {
        bodies.push(JSON.parse(init.body));
        return nth <= TOOL_LOOP_LIMIT
          ? sseResponse(wire)
          : sseResponse(content("final answer") + "data: [DONE]\n\n");
      },
      "/v1/chat/search": searchOk,
    });
    assert.equal(outcome.error, null);
    assert.equal(outcome.stopped, false);
    assert.equal(calls.filter((call) => call.url === "/v1/chat/completions").length, TOOL_LOOP_LIMIT + 1);
    assert.equal("tools" in bodies.at(-1), false);
    const last = outcome.messages.at(-1);
    assert.equal(last.role, "assistant");
    assert.equal(last.parts.at(-1).markdown, "final answer");
    assert.equal(outcome.messages.some((message) =>
      message.parts.some((part) => part.kind === "text" && part.markdown.includes("tool call limit reached"))), false);
  });

  test("stop between requests keeps the partial turn and reports it cleanly", async () => {
    const wire =
      toolCall({ index: 0, id: "c1", function: { name: "pool_list", arguments: "{}" } }) +
      "data: [DONE]\n\n";
    const controller = new AbortController();
    const statuses = [];
    const outcome = await withFetch(
      {
        "/v1/chat/completions": (_init, nth) => {
          if (nth === 1) return sseResponse(wire);
          controller.abort();
          return Promise.reject(new DOMException("aborted", "AbortError"));
        },
      },
      () =>
        runChatTurns({
          history: [userTurn],
          pool: "coding",
          signal: controller.signal,
          authKey: () => null,
          pools: { list: async () => [], put: async () => {} },
          events: { onMessages: () => {}, onStatus: (status) => statuses.push(status) },
        }),
    );
    assert.equal(outcome.error, null);
    assert.equal(outcome.stopped, true);
    // The tool result of the finished turn survives the stop.
    const results = outcome.messages.flatMap((m) => m.parts.filter((p) => p.kind === "tool-result"));
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
  });

  test("pool_select inside the loop switches the pool and adds a system note", async () => {
    const wire =
      toolCall({ index: 0, id: "c1", function: { name: "pool_select", arguments: '{"name":"fast"}' } }) +
      "data: [DONE]\n\n";
    const pools = {
      list: async () => [{ name: "coding", members: [] }, { name: "fast", members: [] }],
      put: async () => {},
    };
    let selected = null;
    const { outcome, calls } = await runLoop(
      {
        "/v1/chat/completions": (_init, nth) =>
          nth === 1 ? sseResponse(wire) : sseResponse(content("ok") + "data: [DONE]\n\n"),
      },
      { pools, onPoolSelect: (name) => (selected = name) },
    );
    assert.equal(selected, "fast");
    const note = outcome.messages.find((m) => m.role === "user" && m.parts[0].markdown.includes("switched"));
    assert.equal(note.parts[0].markdown, "System note: the active pool switched to fast");
    const second = JSON.parse(calls.filter((c) => c.url === "/v1/chat/completions")[1].init.body);
    assert.equal(second.model, "fast");
  });
  await Promise.all(tests);
} finally {
  await server.close();
}
console.log(`${checks} chat tools checks passed`);
