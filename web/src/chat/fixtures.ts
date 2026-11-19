// Fixture messages for the chat UI prototype. The types model the parts
// the UI must render; they do not import backend API types and no code
// here performs network calls.

export type ChatRole = "user" | "assistant";

export type ChatTextPart = {
  kind: "text";
  // Markdown source rendered with GFM and code highlighting.
  markdown: string;
};

export type ChatReasoningPart = {
  kind: "reasoning";
  text: string;
  // Shown collapsed after the answer is complete.
  durationMs: number;
  // True while the stream is still writing this block; such a block
  // stays open and shows "Thinking" instead of a duration.
  streaming?: boolean;
};

export type ChatCitationPart = {
  kind: "citation";
  // Marker number rendered in the answer text, 1-based.
  index: number;
  title: string;
  url: string;
};

export type ChatToolStatus = "running" | "completed" | "error";

export type WebSearchCard = {
  tool: "web_search";
  provider: "deepseek" | "zai";
  query: string;
  // Absent while the search is running or has failed.
  results?: { title: string; url: string }[];
};

export type ReadSourceCard = {
  tool: "read_source";
  url: string;
  charsRead: number;
};

export type MemorySaveCard = {
  tool: "memory_save";
  text: string;
  // True only after the server confirms the write.
  saved: boolean;
};

export type PoolUpdateCard = {
  tool: "pool_update";
  pool: string;
  change: string;
  // Message returned by the management API.
  result: string;
};

export type RouterAskPoolCard = {
  tool: "router_ask_pool";
  pool: string;
  question: string;
  answer: string;
};

export type JavaScriptCard = {
  tool: "javascript";
  code: string;
  consoleLines: string[];
  result: string | null;
  // Isolated preview document produced by the sandbox, when any.
  previewHtml: string | null;
};

export type ChatToolCard =
  | WebSearchCard
  | ReadSourceCard
  | MemorySaveCard
  | PoolUpdateCard
  | RouterAskPoolCard
  | JavaScriptCard;

export type ChatToolPart = {
  kind: "tool";
  status: ChatToolStatus;
  // Error text when status is "error".
  error?: string;
  card: ChatToolCard;
};

export type ChatToolCallState = "streaming" | "ready" | "invalid";

// Argument parsing and execution have separate states. Only a result confirms the outcome.
export type ChatToolCallPart = {
  kind: "tool-call";
  // Upstream call id; present when the provider sent one.
  id?: string;
  // Function name; some providers send it only in the first fragment.
  name: string;
  // Raw argument fragments joined in arrival order; partial while
  // state is "streaming".
  arguments: string;
  // "ready" after the stream ended with valid JSON arguments, "invalid"
  // when the joined fragments do not parse.
  state: ChatToolCallState;
};

// The outcome of one tool call, produced by the dispatcher. It travels
// with the assistant message and becomes a tool message in requests.
export type ChatToolResultPart = {
  kind: "tool-result";
  // Id of the answered tool call; synthesized the same way as in the
  // request serializer when the model sent none.
  id: string;
  name: string;
  ok: boolean;
  // Exact text sent back to the model as the tool message content.
  content: string;
};

export type ChatMessagePart =
  | ChatTextPart
  | ChatReasoningPart
  | ChatCitationPart
  | ChatToolPart
  | ChatToolCallPart
  | ChatToolResultPart;

export type ChatMessageMetrics = {
  // Time from request start to the first text, reasoning or tool-call delta.
  ttftMs?: number;
  // Exact upstream count; absent when the provider returned no usage.
  outputTokens?: number;
  // outputTokens divided by generation time after the first token.
  tokensPerSecond?: number;
};

export type ChatMessage = {
  role: ChatRole;
  parts: ChatMessagePart[];
  metrics?: ChatMessageMetrics;
};

export const fixtureMessages: ChatMessage[] = [
  {
    role: "user",
    parts: [
      {
        kind: "text",
        markdown:
          "Compare SQLite WAL mode with the default rollback journal for read latency. Cite sources.",
      },
    ],
  },
  {
    role: "assistant",
    metrics: { ttftMs: 740, outputTokens: 186, tokensPerSecond: 42.6 },
    parts: [
      {
        kind: "reasoning",
        text:
          "The question is about read latency, not write throughput. I need one current source that covers both modes, then I can summarize the difference in a short list.",
        durationMs: 4200,
      },
      {
        kind: "tool",
        status: "completed",
        card: {
          tool: "web_search",
          provider: "deepseek",
          query: "sqlite wal mode read latency rollback journal",
          results: [
            { title: "Write-Ahead Logging", url: "https://www.sqlite.org/wal.html" },
            { title: "Isolation In SQLite", url: "https://www.sqlite.org/isolation.html" },
            {
              title: "Understanding SQLite Locking",
              url: "https://activesphere.com/blog/2018/12/24/understanding-sqlite-locking/",
            },
          ],
        },
      },
      {
        kind: "tool",
        status: "completed",
        card: {
          tool: "read_source",
          url: "https://www.sqlite.org/wal.html",
          charsRead: 18432,
        },
      },
      {
        kind: "text",
        markdown: `Read latency difference in one list:

- **WAL**: readers take a shared lock on the index file and read the latest committed snapshot, so a concurrent writer does not block them.
- **Rollback journal**: readers take a SHARED lock on the database file and wait while a writer commits.

\`\`\`sql
PRAGMA journal_mode = WAL;
\`\`\`

Details: [Write-Ahead Logging](https://www.sqlite.org/wal.html).`,
      },
      {
        kind: "citation",
        index: 1,
        title: "Write-Ahead Logging — sqlite.org",
        url: "https://www.sqlite.org/wal.html",
      },
      {
        kind: "tool",
        status: "completed",
        card: {
          tool: "memory_save",
          text: "The user works with SQLite storage internals and prefers short lists over prose.",
          saved: true,
        },
      },
    ],
  },
  {
    role: "user",
    parts: [
      {
        kind: "text",
        markdown:
          "Ask the reasoning pool the same question, add llama-3.3-70b to the fast pool, and time a sleep in the sandbox.",
      },
    ],
  },
  {
    role: "assistant",
    parts: [
      {
        kind: "tool",
        status: "completed",
        card: {
          tool: "router_ask_pool",
          pool: "reasoning",
          question:
            "Compare SQLite WAL mode with the rollback journal for read latency.",
          answer:
            "WAL readers lock the shared-memory index and read the newest committed snapshot, so a writer never blocks them. Rollback-journal readers take a SHARED lock on the database file and must wait for a writer that is committing.",
        },
      },
      {
        kind: "tool",
        status: "completed",
        card: {
          tool: "pool_update",
          pool: "fast",
          change: "add model llama-3.3-70b",
          result: "Pool fast updated: 4 members, llama-3.3-70b enabled.",
        },
      },
      {
        kind: "tool",
        status: "running",
        card: {
          tool: "javascript",
          code: "const t0 = performance.now();\nawait new Promise((r) => setTimeout(r, 50));\nconsole.log(`waited ${(performance.now() - t0).toFixed(1)} ms`);",
          consoleLines: ["waited 50.4 ms"],
          result: null,
          previewHtml: null,
        },
      },
      {
        kind: "tool",
        status: "error",
        error: "web_search failed: deepseek returned HTTP 429 Too Many Requests",
        card: {
          tool: "web_search",
          provider: "deepseek",
          query: "sqlite shm file size limit",
        },
      },
      {
        kind: "text",
        markdown:
          "The reasoning pool answered and the fast pool is updated. The sandbox example is still running; the last search failed and can be retried.",
      },
    ],
  },
];
