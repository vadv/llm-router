// Self-check of the chat transport: SSE parser, stream accumulator and
// request serializer. Run: node scripts/check-sse.mjs
// All fixtures are inline byte sequences; no network and no timers.
// Wire events are built with JSON.stringify so no hand-escaped JSON exists.
import assert from "node:assert/strict";
import { createServer } from "vite";

const encoder = new TextEncoder();

function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

// Cut a byte string into fixed-size network chunks, the way a socket
// would, regardless of event or code point boundaries.
function sliced(text, size) {
  const bytes = encoder.encode(text);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
  return chunks;
}

let checks = 0;
// Async bodies must fail loudly and in order, not as stray rejections.
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
  const [sse, { AssistantAccumulator }, history, historyLimit] = await Promise.all([
    server.ssrLoadModule("/src/chat/sse.ts"),
    server.ssrLoadModule("/src/chat/accumulator.ts"),
    server.ssrLoadModule("/src/chat/openai-history.ts"),
    server.ssrLoadModule("/src/chat/history.ts"),
  ]);
  const { parseOpenAiStream, openAiErrorText } = sse;
  const { toOpenAIMessages } = history;
  const { limitHistory, HISTORY_LIMIT } = historyLimit;

  const collect = async (chunks) => {
    const out = [];
    for await (const chunk of parseOpenAiStream(streamOf(...chunks))) out.push(chunk);
    return out;
  };
  const event = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
  const deltaEvent = (delta) => event({ choices: [{ delta }] });
  const content = (text) => deltaEvent({ content: text });
  const toolCall = (call) => deltaEvent({ tool_calls: [call] });
  const accumulate = (chunks, now) => {
    const acc = new AssistantAccumulator(now);
    for (const chunk of chunks) acc.push(chunk);
    acc.finish();
    return acc.parts;
  };

  test("plain LF events parse and [DONE] ends the stream", async () => {
    const chunks = await collect([
      encoder.encode(content("Hello") + content(" there") + "data: [DONE]\n\n"),
    ]);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].choices[0].delta.content, "Hello");
  });

  test("CRLF line ends and comment lines are handled", async () => {
    const wire = `: keep-alive\r\n${content("a").replaceAll("\n", "\r\n")}: ping\r\ndata: [DONE]\r\n\r\n`;
    const chunks = await collect([encoder.encode(wire)]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].choices[0].delta.content, "a");
  });

  test("multi-line data fields join into one JSON document", async () => {
    const whole = deltaEvent({ content: "b" });
    // Split the JSON document across two data lines of one event; the
    // newline lands where JSON allows whitespace.
    const mid = whole.indexOf('{"delta"');
    const wire = whole.slice(0, mid) + "\ndata: " + whole.slice(mid);
    const chunks = await collect([encoder.encode(wire)]);
    assert.equal(chunks[0].choices[0].delta.content, "b");
  });

  test("events split across network chunks reassemble", async () => {
    const whole =
      content("Hello") +
      toolCall({ index: 0, id: "c1", function: { name: "f", arguments: "{}" } }) +
      "data: [DONE]\n\n";
    const chunks = await collect(sliced(whole, 7));
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].choices[0].delta.tool_calls[0].id, "c1");
  });

  test("a code point split across chunks stays intact", async () => {
    const chunks = await collect(sliced(content("héllo → 世界"), 3));
    const acc = new AssistantAccumulator();
    for (const chunk of chunks) acc.push(chunk);
    assert.deepEqual(acc.parts.map((p) => p.kind), ["text"]);
    assert.equal(acc.parts[0].markdown, "héllo → 世界");
  });

  test("a final event without a trailing blank line still dispatches", async () => {
    const chunks = await collect([encoder.encode(content("tail") + "data: [DONE]")]);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].choices[0].delta.content, "tail");
  });

  test("a malformed data event throws instead of dropping content", async () => {
    await assert.rejects(collect([encoder.encode("data: {not json}\n\n")]), SyntaxError);
  });

  test("in-stream error events surface their message", async () => {
    const chunks = await collect([
      encoder.encode(event({ error: { type: "upstream", message: "boom" } })),
    ]);
    assert.equal(openAiErrorText(chunks[0].error), "boom");
    const stringForm = await collect([encoder.encode(event({ error: "flat" }))]);
    assert.equal(openAiErrorText(stringForm[0].error), "flat");
    assert.equal(openAiErrorText(undefined), null);
  });

  test("content deltas merge into one text part in arrival order", async () => {
    const parts = accumulate(await collect([encoder.encode(content("a") + content("b"))]));
    assert.deepEqual(parts, [{ kind: "text", markdown: "ab" }]);
  });

  test("text, reasoning and text stay three ordered parts", async () => {
    const wire = content("a") + deltaEvent({ reasoning_content: "r1" }) + content("b");
    const parts = accumulate(await collect([encoder.encode(wire)]));
    assert.deepEqual(
      parts.map((p) => ({ kind: p.kind, value: p.markdown ?? p.text })),
      [
        { kind: "text", value: "a" },
        { kind: "reasoning", value: "r1" },
        { kind: "text", value: "b" },
      ],
    );
    assert.equal(parts[1].streaming, false);
  });

  test("reasoning aliases and reasoning_details text all land in reasoning", async () => {
    const wire =
      deltaEvent({ reasoning: "moon" }) +
      deltaEvent({ reasoning_details: [{ type: "text", text: "openrouter" }] }) +
      deltaEvent({ reasoning_content: "deepseek" });
    const parts = accumulate(await collect([encoder.encode(wire)]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].text, "moonopenrouterdeepseek");
  });

  test("opaque reasoning_details without text add no part", async () => {
    const wire = deltaEvent({ reasoning_details: [{ type: "encrypted", data: "opaque" }] });
    const parts = accumulate(await collect([encoder.encode(wire)]));
    assert.deepEqual(parts, []);
  });

  test("reasoning duration comes from the injected clock", async () => {
    let tick = 0;
    const parts = accumulate(await collect([encoder.encode(deltaEvent({ reasoning_content: "r" }))]), () => (tick += 1000));
    assert.deepEqual(
      { streaming: parts[0].streaming, durationMs: parts[0].durationMs },
      { streaming: false, durationMs: 1000 },
    );
  });

  test("tool call fragments accumulate by index with id and name from the first", async () => {
    const wire =
      toolCall({ index: 0, id: "c1", function: { name: "web_search", arguments: '{"q":' } }) +
      toolCall({ index: 1, id: "c2", function: { name: "read_source", arguments: '{"u":1' } }) +
      toolCall({ index: 0, function: { arguments: '"x"}' } }) +
      toolCall({ index: 1, function: { arguments: ',"v":2}' } }) +
      "data: [DONE]\n\n";
    const parts = accumulate(await collect([encoder.encode(wire)]));
    assert.equal(parts.length, 2);
    assert.deepEqual(
      parts.map((p) => ({ name: p.name, id: p.id, arguments: p.arguments, state: p.state })),
      [
        { name: "web_search", id: "c1", arguments: '{"q":"x"}', state: "ready" },
        { name: "read_source", id: "c2", arguments: '{"u":1,"v":2}', state: "ready" },
      ],
    );
  });

  test("malformed or empty final arguments mark the call invalid", async () => {
    const broken = toolCall({ index: 0, id: "c1", function: { name: "f", arguments: '{"q":' } });
    const parts = accumulate(await collect([encoder.encode(broken)]));
    assert.equal(parts[0].state, "invalid");

    const nameOnly = toolCall({ index: 0, id: "c1", function: { name: "f" } });
    const empty = accumulate(await collect([encoder.encode(nameOnly)]));
    assert.equal(empty[0].state, "invalid");
    assert.equal(empty[0].arguments, "");
  });

  test("a single tool call without an explicit index still accumulates", async () => {
    const wire =
      toolCall({ id: "c1", function: { name: "f", arguments: "{}" } }) +
      toolCall({ function: { arguments: "{}" } });
    // The second fragment without an index lands on the same call; the
    // joined arguments are then invalid, which the state must show.
    const parts = accumulate(await collect([encoder.encode(wire)]));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].state, "invalid");
    assert.equal(parts[0].arguments, "{}{}");
  });

  test("serializer sends only role and content, drops UI-only parts", () => {
    const messages = [
      { role: "user", parts: [{ kind: "text", markdown: "q" }] },
      {
        role: "assistant",
        parts: [
          { kind: "reasoning", text: "secret plan", durationMs: 1 },
          { kind: "text", markdown: "a1" },
          { kind: "citation", index: 1, title: "t", url: "https://x" },
        ],
      },
      { role: "user", parts: [{ kind: "text", markdown: "q2" }] },
    ];
    assert.deepEqual(toOpenAIMessages(messages), [
      { role: "user", content: "q" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
  });

  test("serializer emits assistant tool_calls and synthesizes missing ids", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          { kind: "tool-call", id: "c1", name: "web_search", arguments: '{"q":"x"}', state: "ready" },
          { kind: "tool-call", name: "read_source", arguments: "{}", state: "ready" },
        ],
      },
    ];
    assert.deepEqual(toOpenAIMessages(messages), [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "web_search", arguments: '{"q":"x"}' } },
          { id: "call_1", type: "function", function: { name: "read_source", arguments: "{}" } },
        ],
      },
    ]);
  });

  test("serializer joins multiple text parts of one message", () => {
    const messages = [
      {
        role: "assistant",
        parts: [
          { kind: "text", markdown: "a" },
          { kind: "reasoning", text: "r", durationMs: 0 },
          { kind: "text", markdown: "b" },
        ],
      },
    ];
    assert.deepEqual(toOpenAIMessages(messages), [{ role: "assistant", content: "a\n\nb" }]);
  });

  test("history limit keeps the last N and does not split a tool turn", () => {
    const text = (role, n) => ({ role, parts: [{ kind: "text", markdown: `${role}${n}` }] });
    const toolTurn = {
      role: "assistant",
      parts: [{ kind: "tool-call", name: "web_search", arguments: "{}", state: "ready" }],
    };
    // Window edge would land exactly on the assistant tool turn; the
    // trim must move back to its user message instead of opening mid-pair.
    const messages = [];
    for (let i = 0; i < 39; i += 1) messages.push(text("user", i), text("assistant", i));
    messages.push(text("user", 39), toolTurn);
    const limited = limitHistory(messages);
    assert.equal(limited.length, HISTORY_LIMIT);
    assert.equal(limited[0].role, "user");
    // The trailing tool turn survives with its user message.
    assert.equal(limited.at(-1), toolTurn);
    assert.equal(limited.at(-2).parts[0].markdown, "user39");
  });

  test("history limit leaves short histories unchanged", () => {
    const messages = [{ role: "user", parts: [{ kind: "text", markdown: "q" }] }];
    assert.equal(limitHistory(messages), messages);
  });
} finally {
  await server.close();
}
await Promise.all(tests);
console.log(`${checks} chat transport checks passed`);
