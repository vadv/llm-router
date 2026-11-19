// Message rendering: user bubbles and assistant answers with reasoning,
// text, citations and tool cards, all in the order the parts arrive.

import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconEdit,
  IconRefresh,
} from "@tabler/icons-react";
import { CopyButton, Tooltip } from "@mantine/core";
import { useId, useState, type ReactNode } from "react";
import type {
  ChatCitationPart,
  ChatMessage,
  ChatMessageMetrics,
  ChatMessagePart,
  ChatReasoningPart,
  ChatToolResultPart,
} from "./fixtures";
import { ChatMarkdown, SafeLink } from "./markdown";
import { toolCallId } from "./openai-history";
import { isToolMarkup } from "./tool-markup";
import { ToolCallView, ToolPartView, ToolResultView } from "./tool-cards";

function messageText(parts: ChatMessagePart[]): string {
  return parts
    .map((part) => (part.kind === "text" ? part.markdown : ""))
    .join("\n\n");
}

function secondsLabel(ms: number): string {
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

function MessageMetrics({ metrics }: { metrics: ChatMessageMetrics | undefined }) {
  if (!metrics) return null;
  const items: string[] = [];
  if (metrics.ttftMs !== undefined) items.push(`TTFT ${secondsLabel(metrics.ttftMs)}`);
  if (metrics.tokensPerSecond !== undefined) {
    const rate = metrics.tokensPerSecond;
    items.push(`${rate < 100 ? rate.toFixed(1) : Math.round(rate)} tok/s`);
  }
  if (metrics.outputTokens !== undefined) items.push(`${metrics.outputTokens} output tokens`);
  if (items.length === 0) return null;
  return (
    <div
      className="chat-message-metrics"
      aria-label="Response timing"
      title="TTFT: request start to first output token. Speed: upstream output tokens per second after the first token."
    >
      {items.join(" · ")}
    </div>
  );
}

function ReasoningBlock({ part }: { part: ChatReasoningPart }) {
  const bodyId = useId();
  // The reader's choice wins; without it a streaming block stays open
  // and a finished one starts collapsed.
  const [readerOpen, setReaderOpen] = useState<boolean | null>(null);
  const open = readerOpen ?? part.streaming === true;
  return (
    <div className="chat-reasoning">
      <button
        type="button"
        className="chat-reasoning-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setReaderOpen(!open)}
      >
        {open ? (
          <IconChevronDown size={14} aria-hidden="true" />
        ) : (
          <IconChevronRight size={14} aria-hidden="true" />
        )}
        {part.streaming ? "Thinking" : `Reasoned for ${secondsLabel(part.durationMs)}`}
      </button>
      <div id={bodyId} className="chat-reasoning-body" hidden={!open}>
        {part.text}
      </div>
    </div>
  );
}

function Sources({ items }: { items: ChatCitationPart[] }) {
  return (
    <div className="chat-sources">
      <span className="chat-sources-label">Sources</span>
      {items.map((citation) => (
        <span key={citation.index} className="chat-source">
          <span className="chat-source-num">[{citation.index}]</span>{" "}
          <SafeLink href={citation.url}>{citation.title}</SafeLink>
        </span>
      ))}
    </div>
  );
}

// Consecutive citation parts join into one footnote list.
function messageParts(parts: ChatMessagePart[], active: boolean): ReactNode[] {
  // Parallel calls can finish in a different order. Never pair by position or name alone.
  const callById = new Map<string, number | null>();
  let ordinal = 0;
  parts.forEach((part, index) => {
    if (part.kind !== "tool-call") return;
    const id = toolCallId(part, ordinal++);
    callById.set(id, callById.has(id) ? null : index);
  });
  const outcomes = new Map<number, ChatToolResultPart>();
  const paired = new Set<number>();
  parts.forEach((part, index) => {
    if (part.kind !== "tool-result") return;
    const pos = callById.get(part.id);
    if (pos == null || outcomes.has(pos)) return;
    const call = parts[pos];
    if (call.kind !== "tool-call" || call.name !== part.name) return;
    outcomes.set(pos, part);
    paired.add(index);
  });
  const nodes: ReactNode[] = [];
  let index = 0;
  while (index < parts.length) {
    const part = parts[index];
    if (part.kind === "citation") {
      const group: ChatCitationPart[] = [];
      while (index < parts.length) {
        const current = parts[index];
        if (current.kind !== "citation") break;
        group.push(current);
        index += 1;
      }
      nodes.push(<Sources key={index - group.length} items={group} />);
      continue;
    }
    if (part.kind === "reasoning") {
      nodes.push(<ReasoningBlock key={index} part={part} />);
    } else if (part.kind === "text") {
      nodes.push(isToolMarkup(part.markdown) ? (
        <div key={index} className="chat-tool" aria-label="Unexecuted tool markup">
          <div className="chat-tool-static-body">
            <strong>Tool request sent as text</strong>
            <span className="chat-tool-note">The model printed tool syntax. No tools were run from this text.</span>
            <details>
              <summary>View original text</summary>
              <pre className="chat-tool-console">{part.markdown}</pre>
            </details>
          </div>
        </div>
      ) : <ChatMarkdown key={index}>{part.markdown}</ChatMarkdown>);
    } else if (part.kind === "tool-call") {
      nodes.push(<ToolCallView key={index} part={part} result={outcomes.get(index)} active={active} />);
    } else if (part.kind === "tool-result") {
      if (!paired.has(index)) nodes.push(<ToolResultView key={index} part={part} />);
    } else {
      nodes.push(<ToolPartView key={index} part={part} />);
    }
    index += 1;
  }
  return nodes;
}

function DisabledAction({
  label,
  icon,
  hint,
}: {
  label: string;
  icon: ReactNode;
  hint: string;
}) {
  // The span keeps the tooltip working on a disabled button.
  return (
    <Tooltip label={hint} withArrow>
      <span className="chat-action-wrap">
        <button type="button" className="chat-icon-btn" disabled aria-label={label}>
          {icon}
        </button>
      </span>
    </Tooltip>
  );
}

function CopyAction({ text, label }: { text: string; label: string }) {
  return (
    <CopyButton value={text} timeout={1200}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : label} withArrow>
          <button
            type="button"
            className="chat-icon-btn"
            onClick={copy}
            aria-label={copied ? "Copied" : label}
          >
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </button>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function UserMessage({
  message,
  streaming,
  onEdit,
}: {
  message: ChatMessage;
  streaming: boolean;
  onEdit?: () => void;
}) {
  const text = messageText(message.parts);
  return (
    <div className="chat-user-row">
      <div className="chat-user-bubble">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
      <div className="chat-msg-actions">
        <CopyAction text={text} label="Copy message" />
        {onEdit === undefined ? null : streaming ? (
          <DisabledAction
            label="Edit message"
            icon={<IconEdit size={14} />}
            hint="Wait for the answer to finish"
          />
        ) : (
          <Tooltip label="Edit message" withArrow>
            <button type="button" className="chat-icon-btn" aria-label="Edit message" onClick={onEdit}>
              <IconEdit size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({
  message,
  pool,
  streaming,
  canRegenerate,
  onRegenerate,
}: {
  message: ChatMessage;
  pool: string;
  streaming: boolean;
  canRegenerate: boolean;
  onRegenerate?: () => void;
}) {
  const text = messageText(message.parts);
  return (
    <div className="chat-assistant">
      <div className="chat-assistant-caption">{pool}</div>
      {messageParts(message.parts, streaming && canRegenerate)}
      <MessageMetrics metrics={message.metrics} />
      <div className="chat-msg-actions chat-assistant-actions">
        <CopyAction text={text} label="Copy answer" />
        {onRegenerate === undefined || !canRegenerate ? null : streaming ? (
          <DisabledAction
            label="Regenerate answer"
            icon={<IconRefresh size={14} />}
            hint="Wait for the answer to finish"
          />
        ) : (
          <Tooltip label="Regenerate answer" withArrow>
            <button
              type="button"
              className="chat-icon-btn"
              aria-label="Regenerate answer"
              onClick={onRegenerate}
            >
              <IconRefresh size={14} />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  pool,
  actions,
}: {
  messages: ChatMessage[];
  pool: string;
  // Absent for read-only views (fixtures): no Edit or Regenerate.
  actions?: {
    streaming: boolean;
    onEdit: (index: number) => void;
    onRegenerate: () => void;
  };
}) {
  return (
    <div className="chat-messages">
      {messages.map((message, index) =>
        message.role === "user" ? (
          <UserMessage
            key={index}
            message={message}
            streaming={actions?.streaming ?? false}
            onEdit={actions === undefined ? undefined : () => actions.onEdit(index)}
          />
        ) : (
          <AssistantMessage
            key={index}
            message={message}
            pool={pool}
            streaming={actions?.streaming ?? false}
            canRegenerate={index === messages.length - 1}
            onRegenerate={actions === undefined ? undefined : actions.onRegenerate}
          />
        ),
      )}
    </div>
  );
}
