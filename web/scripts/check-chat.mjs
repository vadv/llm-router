// Self-check of the chat prototype rendering. Run: node scripts/check-chat.mjs
// Renders the fixture conversation on the server through Vite so that CSS
// imports resolve the same way as in the app, then asserts on the output
// HTML: every tool card type, safe link attributes and code highlighting.
import assert from "node:assert/strict";
import { createServer } from "vite";

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
  const [{ default: React }, { renderToString }, { MantineProvider }, { MessageList }, { fixtureMessages }] =
    await Promise.all([
      import("react"),
      import("react-dom/server"),
      import("@mantine/core"),
      server.ssrLoadModule("/src/chat/messages.tsx"),
      server.ssrLoadModule("/src/chat/fixtures.ts"),
    ]);
  const html = renderToString(
    React.createElement(
      MantineProvider,
      null,
      React.createElement(MessageList, { messages: fixtureMessages, pool: "coding" }),
    ),
  ).replaceAll("<!-- -->", "");

  test("fixture conversation renders user blocks and markdown answers", () => {
    assert.match(html, /Compare SQLite WAL mode/);
    assert.match(html, /WAL<\/strong>: readers take a shared lock/);
  });

  test("reasoning is collapsed by default and keeps its text in the document", () => {
    assert.match(html, /Reasoned for 4\.2 s/);
    assert.match(html, /aria-expanded="false"/);
    assert.match(html, /chat-reasoning-body" hidden="">The question is about read latency/);
  });

  test("all six tool cards render with a text status next to the icon", () => {
    for (const title of [
      "Web search · DeepSeek",
      "Read source",
      "Memory save",
      "Pool update",
      "Asked reasoning",
      "JavaScript",
    ]) {
      assert.ok(html.includes(title), `missing card: ${title}`);
    }
    for (const status of [
      "3 results",
      "Read 18 KB",
      "Saved",
      "Updated",
      "Answer received",
      "Running…",
    ]) {
      assert.ok(html.includes(status), `missing status: ${status}`);
    }
  });

  test("running tool cards open and error text stays visible", () => {
    assert.match(html, /web_search failed: deepseek returned HTTP 429 Too Many Requests/);
    assert.match(html, /waited 50\.4 ms/);
  });

  test("code blocks highlight through the restricted language list", () => {
    assert.match(html, /hljs-keyword/);
    assert.match(html, /language-sql/);
    assert.match(html, /language-javascript/);
  });

  test("every external link carries target and rel, unsafe schemes stay text", () => {
    const links = html.match(/<a [^>]*class="chat-link"/g) ?? [];
    const safe = html.match(/<a [^>]*class="chat-link"[^>]*target="_blank" rel="noopener noreferrer nofollow"/g) ?? [];
    assert.ok(links.length >= 5, "expected external links in the conversation");
    assert.equal(links.length, safe.length);
  });

  test("sources render as footnote markers and markdown stays image-free", () => {
    assert.match(html, />Sources</);
    assert.match(html, /\[1\]<\/span> <a [^>]*>Write-Ahead Logging — sqlite\.org/);
    assert.ok(!html.includes("<img"), "markdown must not render images");
    assert.ok(!html.includes("<script"), "markdown must not inject script tags");
  });

  // Live stream: calls may have arguments before the dispatcher returns.
  const liveHtml = renderToString(
    React.createElement(
      MantineProvider,
      null,
      React.createElement(MessageList, {
        pool: "fast",
        actions: { streaming: true },
        messages: [
          { role: "user", parts: [{ kind: "text", markdown: "hi" }] },
          {
            role: "assistant",
            parts: [
              { kind: "reasoning", text: "working on it", durationMs: 0, streaming: true },
              { kind: "text", markdown: "partial answer" },
              {
                kind: "tool-call",
                id: "c1",
                name: "web_search",
                arguments: '{"query":"sqlite"}',
                state: "ready",
              },
              { kind: "tool-call", name: "f", arguments: '{"q":', state: "invalid" },
              { kind: "tool-call", name: "g", arguments: '', state: "streaming" },
            ],
          },
        ],
      }),
    ),
  ).replaceAll("<!-- -->", "");

  test("a streaming reasoning block shows Thinking and stays open", () => {
    assert.match(liveHtml, /Thinking/);
    assert.match(liveHtml, /aria-expanded="true"/);
    assert.match(liveHtml, /chat-reasoning-body[^>]*>working on it/);
  });

  test("a live call distinguishes incomplete arguments from a pending result", () => {
    assert.match(liveHtml, /web_search/);
    assert.match(liveHtml, /Awaiting result/);
    assert.doesNotMatch(liveHtml, /Not executed|result follows below/);
    assert.match(liveHtml, /Arguments are not valid JSON/);
    assert.match(liveHtml, /Receiving arguments/);
    assert.match(liveHtml, /partial answer/);
  });
  test("only bare assistant protocol markup is marked as unexecuted", () => {
    const raw = '< | | DSML | | tool_calls>< | | DSML | | invoke name="javascript">';
    const render = (role, markdown) => renderToString(React.createElement(MantineProvider, null,
      React.createElement(MessageList, { pool: "p", messages: [{ role, parts: [{ kind: "text", markdown }] }] })));
    assert.match(render("assistant", raw), /Tool request sent as text/);
    assert.match(render("assistant", raw), /&lt; \| \| DSML/);
    for (const markdown of ["\x60\x60\x60xml\n" + raw + "\n\x60\x60\x60", "> " + raw, "Example: " + raw])
      assert.doesNotMatch(render("assistant", markdown), /Tool request sent as text/);
    assert.doesNotMatch(render("user", raw), /Tool request sent as text/);
  });

  test("saved parallel calls show their own outcomes without duplicate result cards", () => {
    const call = (name, id) => ({ kind: "tool-call", name, id, state: "ready", arguments: "{}" });
    const result = (name, id, ok, content) => ({ kind: "tool-result", name, id, ok, content });
    const messages = [{ role: "assistant", parts: [
      call("pool_list", "a"), call("balance_list"), call("usage_spend", "c"), call("usage_spend", "d"),
      result("usage_spend", "c", false, '{"type":"invalid_arguments","message":"Missing provider"}'),
      result("balance_list", "call_1", true, "balance fixture"), result("pool_list", "a", true, "pool fixture"),
      result("another_tool", "orphan", true, "unmatched fixture"),
    ] }];
    const saved = renderToString(React.createElement(MantineProvider, null, React.createElement(MessageList, { messages, pool: "p" })));
    const cards = saved.match(/<article\b[\s\S]*?<\/article>/g) ?? [];
    assert.equal(cards.length, 5);
    for (const [index, status, output] of [[0, "Done", "pool fixture"], [1, "Done", "balance fixture"],
      [2, "Error", "Missing provider"], [3, "No result recorded", "Arguments"], [4, "Done", "unmatched fixture"]]) {
      assert.ok(cards[index].includes(">" + status + "<") && cards[index].includes(output), status + ": " + output);
    }
    assert.doesNotMatch(cards[3], /Missing provider|Awaiting result/);
  });
} finally {
  await server.close();
}
console.log(`${checks} chat render checks passed`);
