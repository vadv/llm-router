// Tool cards display recorded arguments and results. Rendering never executes a tool.

import {
  IconAlertTriangle,
  IconArrowsExchange,
  IconCheck,
  IconChevronDown,
  IconCode,
  IconDeviceFloppy,
  IconExternalLink,
  IconFunction,
  IconLoader2,
  IconSearch,
  IconStack2,
} from "@tabler/icons-react";
import { Anchor, Text } from "@mantine/core";
import { useId, useState, type ReactNode } from "react";
import type {
  ChatToolCallPart,
  ChatToolPart,
  ChatToolResultPart,
  ChatToolStatus,
  JavaScriptCard,
  MemorySaveCard,
  PoolUpdateCard,
  ReadSourceCard,
  RouterAskPoolCard,
  WebSearchCard,
} from "./fixtures";
import { ChatMarkdown, SafeLink } from "./markdown";

type CardStatus = { kind: "running" | "ok" | "idle" | "error"; label: string };

function statusFor(status: ChatToolStatus, done: CardStatus, runningLabel: string): CardStatus {
  if (status === "error") return { kind: "error", label: "Error" };
  if (status === "running") return { kind: "running", label: runningLabel };
  return done;
}

function ToolStatus({ state }: { state: CardStatus }) {
  return (
    <span className={`chat-tool-status is-${state.kind}`}>
      {state.kind === "running" && <IconLoader2 size={13} className="chat-spin" aria-hidden="true" />}
      {state.kind === "ok" && <IconCheck size={13} aria-hidden="true" />}
      {state.kind === "error" && <IconAlertTriangle size={13} aria-hidden="true" />}
      <span>{state.label}</span>
    </span>
  );
}

function ToolLabel({ children }: { children: ReactNode }) {
  return (
    <Text component="div" className="chat-tool-label" fz="xs" fw={600} c="dimmed">
      {children}
    </Text>
  );
}

function ErrorLine({ error }: { error?: string }) {
  if (!error) return null;
  return <Text component="p" className="chat-tool-error" fz="sm">{error}</Text>;
}

// Static card: the whole summary stays visible, nothing expands.
function StaticToolCard({
  title,
  icon,
  status,
  children,
}: {
  title: string;
  icon: ReactNode;
  status: CardStatus;
  children?: ReactNode;
}) {
  return (
    <article className="chat-tool" aria-label={title}>
      <div className="chat-tool-head-static">
        {icon}
        <span className="chat-tool-title">{title}</span>
        <ToolStatus state={status} />
      </div>
      {children && <div className="chat-tool-static-body">{children}</div>}
    </article>
  );
}

// Expandable card: the header stays visible, details hide behind it.
// Running and failed calls open by default; finished calls collapse.
function ExpandableToolCard({
  title,
  icon,
  status,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  status: CardStatus;
  summary?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const bodyId = useId();
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = readerOpen ?? defaultOpen;
  return (
    <article className="chat-tool" aria-label={title}>
      <button
        type="button"
        className="chat-tool-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setReaderOpen(!open)}
      >
        {icon}
        <span className="chat-tool-title">{title}</span>
        <ToolStatus state={status} />
        <IconChevronDown size={15} className="chat-tool-chevron" data-open={open} aria-hidden="true" />
      </button>
      {summary && <div className="chat-tool-summary">{summary}</div>}
      <div id={bodyId} className="chat-tool-body" hidden={!open}>
        {children}
      </div>
    </article>
  );
}

const providerLabel: Record<WebSearchCard["provider"], string> = {
  deepseek: "DeepSeek",
  zai: "Z.AI",
};

function WebSearchTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: WebSearchCard }) {
  const results = status === "completed" ? card.results ?? [] : null;
  return (
    <ExpandableToolCard
      title={`Web search · ${providerLabel[card.provider]}`}
      icon={<IconSearch size={16} aria-hidden="true" />}
      status={statusFor(status, { kind: "idle", label: `${card.results?.length ?? 0} results` }, "Searching…")}
      summary={<span className="chat-quote">“{card.query}”</span>}
      defaultOpen={status !== "completed"}
    >
      {results && (
        <>
          <ToolLabel>Results</ToolLabel>
          <ol className="chat-tool-results">
            {results.map((result) => (
              <li key={result.url}>
                <SafeLink href={result.url}>{result.title}</SafeLink>
              </li>
            ))}
          </ol>
        </>
      )}
      <ToolLabel>Arguments</ToolLabel>
      <div className="chat-tool-args">
        query: <span className="mono">“{card.query}”</span> · provider: <span className="mono">{card.provider}</span>
      </div>
      <ErrorLine error={error} />
    </ExpandableToolCard>
  );
}

function readKb(chars: number): string {
  const kb = chars / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function ReadSourceTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: ReadSourceCard }) {
  return (
    <ExpandableToolCard
      title="Read source"
      icon={<IconExternalLink size={16} aria-hidden="true" />}
      status={statusFor(status, { kind: "idle", label: `Read ${readKb(card.charsRead)}` }, "Reading…")}
      summary={hostOf(card.url)}
      defaultOpen={status !== "completed"}
    >
      <ToolLabel>Source</ToolLabel>
      <div className="chat-tool-args">
        <SafeLink href={card.url}>{card.url}</SafeLink>
        <br />
        {card.charsRead.toLocaleString("en-US")} characters read
      </div>
      <ErrorLine error={error} />
    </ExpandableToolCard>
  );
}

function MemorySaveTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: MemorySaveCard }) {
  // "Saved" appears only after the write is confirmed.
  const saved = status === "completed" && card.saved;
  return (
    <StaticToolCard
      title="Memory save"
      icon={<IconDeviceFloppy size={16} aria-hidden="true" />}
      status={statusFor(status, saved ? { kind: "ok", label: "Saved" } : { kind: "idle", label: "Not saved" }, "Saving…")}
    >
      <div className="chat-tool-note">{card.text}</div>
      <ErrorLine error={error} />
    </StaticToolCard>
  );
}

function PoolUpdateTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: PoolUpdateCard }) {
  return (
    <StaticToolCard
      title="Pool update"
      icon={<IconStack2 size={16} aria-hidden="true" />}
      status={statusFor(status, { kind: "ok", label: "Updated" }, "Updating…")}
    >
      <div className="chat-tool-note">
        <span className="mono">{card.pool}</span> · {card.change}
      </div>
      {status === "completed" && <div className="chat-tool-note">{card.result}</div>}
      <Anchor href="#/pools" className="chat-link" fz="sm">
        View pool
      </Anchor>
      <ErrorLine error={error} />
    </StaticToolCard>
  );
}

function RouterAskPoolTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: RouterAskPoolCard }) {
  return (
    <ExpandableToolCard
      title={`Asked ${card.pool}`}
      icon={<IconArrowsExchange size={16} aria-hidden="true" />}
      status={statusFor(status, { kind: "idle", label: "Answer received" }, "Asking…")}
      summary={<span className="chat-quote">“{card.question}”</span>}
      defaultOpen={status !== "running"}
    >
      {status === "completed" && (
        <>
          <ToolLabel>Answer</ToolLabel>
          <ChatMarkdown>{card.answer}</ChatMarkdown>
        </>
      )}
      <ToolLabel>Arguments</ToolLabel>
      <div className="chat-tool-args">
        <span className="mono">{card.pool}</span> · <span className="chat-quote">“{card.question}”</span>
      </div>
      <ErrorLine error={error} />
    </ExpandableToolCard>
  );
}

// Four backticks fence the code safely even when it contains ``` blocks.
function fenced(code: string): string {
  return "````javascript\n" + code + "\n````";
}

function JavaScriptTool({ status, error, card }: { status: ChatToolStatus; error?: string; card: JavaScriptCard }) {
  return (
    <ExpandableToolCard
      title="JavaScript"
      icon={<IconCode size={16} aria-hidden="true" />}
      status={statusFor(status, { kind: "idle", label: "Completed" }, "Running…")}
      summary={status === "completed" && card.result !== null ? <span className="mono">{card.result}</span> : undefined}
      defaultOpen={status !== "completed"}
    >
      <ToolLabel>Code</ToolLabel>
      <ChatMarkdown>{fenced(card.code)}</ChatMarkdown>
      {card.consoleLines.length > 0 && (
        <>
          <ToolLabel>Console</ToolLabel>
          <pre className="chat-tool-console">{card.consoleLines.join("\n")}</pre>
        </>
      )}
      {card.result !== null && (
        <>
          <ToolLabel>Result</ToolLabel>
          <div className="chat-tool-args">
            <span className="mono">{card.result}</span>
          </div>
        </>
      )}
      {card.previewHtml !== null && (
        <>
          <ToolLabel>Preview</ToolLabel>
          {/* The sandbox preview is never executed or injected in this prototype. */}
          <div className="chat-tool-args">
            Preview output is not rendered in this prototype; the isolated sandbox draws it once the tool is connected.
          </div>
        </>
      )}
      <ErrorLine error={error} />
    </ExpandableToolCard>
  );
}

function callStatus(part: ChatToolCallPart, result: ChatToolResultPart | undefined, active: boolean): CardStatus {
  if (result) return result.ok ? { kind: "ok", label: "Done" } : { kind: "error", label: "Error" };
  if (part.state === "invalid") return { kind: "error", label: "Invalid arguments" };
  if (!active) return { kind: "idle", label: "No result recorded" };
  return { kind: "running", label: part.state === "streaming" ? "Receiving arguments" : "Awaiting result" };
}

export function ToolCallView({ part, result, active }: {
  part: ChatToolCallPart; result?: ChatToolResultPart; active: boolean;
}) {
  const status = callStatus(part, result, active);
  return (
    <ExpandableToolCard
      title={part.name === "" ? "Tool call" : part.name}
      icon={<IconFunction size={16} aria-hidden="true" />}
      status={status}
      defaultOpen={status.kind === "error" || status.kind === "running"}
    >
      {part.state === "invalid" && (
        <Text component="p" className="chat-tool-error" fz="sm">
          Arguments are not valid JSON
        </Text>
      )}
      <ToolLabel>Arguments</ToolLabel>
      <div className="chat-tool-args">
        <span className="mono">{part.arguments === "" ? "…" : part.arguments}</span>
      </div>
      {result && <>
        <ToolLabel>{result.ok ? "Tool output" : "Tool error"}</ToolLabel>
        <pre className="chat-tool-console">{result.content || "(empty output)"}</pre>
      </>}
    </ExpandableToolCard>
  );
}

// The dispatcher's answer to one tool call: the exact text that was sent
// back to the model, or the typed error it carried.
export function ToolResultView({ part }: { part: ChatToolResultPart }) {
  const summary = part.content.split("\n")[0];
  return (
    <ExpandableToolCard
      title={`Result · ${part.name}`}
      icon={part.ok ? <IconCheck size={16} aria-hidden="true" /> : <IconAlertTriangle size={16} aria-hidden="true" />}
      status={part.ok ? { kind: "ok", label: "Done" } : { kind: "error", label: "Error" }}
      summary={summary === "" ? undefined : summary}
    >
      <ToolLabel>{part.ok ? "Tool output" : "Tool error"}</ToolLabel>
      <div className="chat-tool-args">
        <span className="mono">{part.content}</span>
      </div>
    </ExpandableToolCard>
  );
}

export function ToolPartView({ part }: { part: ChatToolPart }) {
  const { status, error, card } = part;
  switch (card.tool) {
    case "web_search":
      return <WebSearchTool status={status} error={error} card={card} />;
    case "read_source":
      return <ReadSourceTool status={status} error={error} card={card} />;
    case "memory_save":
      return <MemorySaveTool status={status} error={error} card={card} />;
    case "pool_update":
      return <PoolUpdateTool status={status} error={error} card={card} />;
    case "router_ask_pool":
      return <RouterAskPoolTool status={status} error={error} card={card} />;
    case "javascript":
      return <JavaScriptTool status={status} error={error} card={card} />;
  }
}
