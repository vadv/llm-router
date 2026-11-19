import {
  ActionIcon,
  Button,
  Drawer,
  Menu,
  Modal,
  NativeSelect,
  TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconArrowDown,
  IconArrowUp,
  IconArrowUpRight,
  IconBooks,
  IconChartBar,
  IconDatabase,
  IconDots,
  IconEdit,
  IconLayoutSidebar,
  IconMessages,
  IconPlus,
  IconRoute,
} from "@tabler/icons-react";
import { useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { usePoll } from "../hooks";
import { ChatComposer } from "../chat/composer";
import { readReasoningEffort } from "../chat/reasoning-effort";
import { fixtureMessages } from "../chat/fixtures";
import { ConversationLibrary } from "../chat/history-drawer";
import { MemoryPanel } from "../chat/memory-panel";
import { MessageList } from "../chat/messages";
import { TITLE_CAP, type ConversationSummary } from "../chat/store";
import { useConversation } from "../chat/use-conversation";
import "../chat/chat.css";
import "../chat/workspace.css";

const starters = [
  {
    icon: IconChartBar,
    title: "Usage summary",
    text: "Summarize router usage over the last 24 hours. Which pool handled the most traffic?",
  },
  {
    icon: IconRoute,
    title: "Inspect a pool",
    text: "List my model pools and explain their fallback order. Do not change any settings.",
  },
  {
    icon: IconBooks,
    title: "Research a topic",
    text: "Help me research a topic using public sources: ",
  },
];

type Dialog =
  | { type: "new" | "clear" }
  | { type: "rename" | "delete"; item: ConversationSummary };

export function ChatPage() {
  const pools = usePoll(api.pools, []);
  const [pool, setPool] = useState<string | null>(null);
  const chat = useConversation(pool, setPool);
  const [sample, setSample] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [railHidden, setRailHidden] = useState(false);
  const narrow = useMediaQuery("(max-width: 68em)");
  const [memory, setMemory] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const drafts = useRef(new Map<string, string>());
  const draftKey = chat.conversationId ?? "";
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const list = pools.data ?? [];
  const selected = list.find((p) => p.name === pool) ?? null;
  const thread = chat.conversations.find((c) => c.id === chat.conversationId);
  const streaming = chat.status === "streaming" || chat.status === "working";
  const displayed = sample ? fixtureMessages : chat.messages;
  const title = sample
    ? "Example conversation"
    : (thread?.title ?? "New conversation");
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [edges, setEdges] = useState({ top: true, end: true });

  function measure() {
    const node = scroller.current;
    if (!node) return;
    const top = node.scrollTop <= 2,
      end = node.scrollHeight - node.clientHeight - node.scrollTop <= 4;
    follow.current = end;
    setEdges((old) =>
      old.top === top && old.end === end ? old : { top, end },
    );
  }
  // Track the reader, not the token stream. Code blocks and tool details can resize late.
  useLayoutEffect(() => {
    const node = scroller.current,
      body = content.current;
    if (!node || !body) return;
    follow.current = true;
    const resize = () => {
      if (follow.current) node.scrollTop = node.scrollHeight;
      measure();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    observer.observe(node);
    return () => observer.disconnect();
  }, [chat.conversationId, sample]);
  function jump(end: boolean) {
    const node = scroller.current;
    if (node) {
      node.scrollTop = end ? node.scrollHeight : 0;
      measure();
    }
  }
  function editDraft(text: string) {
    if (text) drafts.current.set(draftKey, text);
    else drafts.current.delete(draftKey);
    setDraft(text);
  }
  function openDialog(next: Dialog) {
    setName(next.type === "rename" ? next.item.title : "");
    setLibraryOpen(false);
    setError("");
    setDialog(next);
  }
  function mayLeave() {
    return (
      !streaming ||
      window.confirm(
        "Stop this response and switch conversations? The partial answer will stay here.",
      )
    );
  }
  async function action(fn: () => Promise<void>) {
    if (busy.current || !chat.ready) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await fn();
    } catch {
      setError(
        "Could not update the browser’s chat history. Check storage access and try again.",
      );
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  function select(id: string) {
    if (id === chat.conversationId) {
      setLibraryOpen(false);
      setSample(false);
      return;
    }
    if (!mayLeave()) return;
    void action(async () => {
      await chat.selectConversation(id);
      setSample(false);
      setLibraryOpen(false);
      setDraft(drafts.current.get(id) ?? "");
    });
  }
  function confirm() {
    if (!dialog || (dialog.type === "rename" && !name.trim())) return;
    if (
      (dialog.type === "new" ||
        dialog.type === "clear" ||
        (dialog.type === "delete" && dialog.item.id === chat.conversationId)) &&
      !mayLeave()
    )
      return;
    void action(async () => {
      switch (dialog.type) {
        case "new":
          await chat.createConversation(name);
          setDraft("");
          setSample(false);
          break;
        case "rename":
          await chat.renameConversation(dialog.item.id, name);
          break;
        case "delete":
          await chat.removeConversation(dialog.item.id);
          drafts.current.delete(dialog.item.id);
          if (dialog.item.id === chat.conversationId) setDraft("");
          break;
        case "clear":
          await chat.clearAllConversations();
          drafts.current.clear();
          setDraft("");
          break;
      }
      setDialog(null);
    });
  }
  const library = (
    <ConversationLibrary
      conversations={chat.conversations}
      activeId={chat.conversationId}
      disabled={!chat.ready || pending}
      onNew={() => openDialog({ type: "new" })}
      onSelect={select}
      onRename={(item) => openDialog({ type: "rename", item })}
      onDelete={(item) => openDialog({ type: "delete", item })}
      onClear={() => openDialog({ type: "clear" })}
    />
  );
  const naming = dialog?.type === "rename" || dialog?.type === "new";
  return (
    <div className="thread-workspace" data-rail={!railHidden}>
      {!narrow && !railHidden && library}
      <section className="thread-studio" aria-label="Chat workspace">
        <header className="thread-head">
          <ActionIcon
            variant="default"
            aria-label="Toggle conversation library"
            aria-expanded={narrow ? libraryOpen : !railHidden}
            title="Conversations"
            onClick={() =>
              narrow ? setLibraryOpen((v) => !v) : setRailHidden((v) => !v)
            }
          >
            <IconLayoutSidebar size={18} />
          </ActionIcon>
          <div className="thread-heading">
            <small className="thread-kicker">
              CHAT <b>/</b> {sample ? "EXAMPLE" : "CONVERSATION"}
            </small>
            <h1 title={title}>{title}</h1>
          </div>
          <div className="thread-head-actions">
            <ActionIcon
              title="New chat"
              aria-label="Start a new conversation"
              variant="light"
              disabled={!chat.ready || pending}
              onClick={() => openDialog({ type: "new" })}
            >
              <IconPlus size={18} />
            </ActionIcon>
            <Menu position="bottom-end">
              <Menu.Target>
                <ActionIcon
                  variant="subtle"
                  color="gray"
                  title="Conversation options"
                  aria-label="Conversation options"
                >
                  <IconDots size={20} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  leftSection={<IconEdit size={15} />}
                  disabled={!thread || pending || streaming || sample}
                  onClick={() =>
                    thread && openDialog({ type: "rename", item: thread })
                  }
                >
                  Rename chat
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconDatabase size={15} />}
                  onClick={() => setMemory(true)}
                >
                  Saved memory
                </Menu.Item>
                <Menu.Item
                  leftSection={<IconMessages size={15} />}
                  disabled={streaming}
                  onClick={() => setSample((v) => !v)}
                >
                  {sample ? "Return to chat" : "View example thread"}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>
        </header>
        <div
          className="thread-scroll"
          ref={scroller}
          onScroll={measure}
          role="region"
          aria-label="Conversation messages"
          tabIndex={0}
        >
          <div
            ref={content}
            className={`thread-content${displayed.length ? "" : " thread-content-empty"}`}
          >
            {displayed.length ? (
              <MessageList
                messages={displayed}
                pool={sample ? "research" : (selected?.name ?? pool ?? "pool")}
                actions={
                  sample
                    ? undefined
                    : {
                        streaming,
                        onEdit: (index) => {
                          const text = chat.beginEdit(index);
                          if (text !== null) {
                            editDraft(text);
                            inputRef.current?.focus();
                          }
                        },
                        onRegenerate: () => void chat.regenerate(),
                      }
                }
              />
            ) : (
              <div className="thread-welcome">
                <span className="thread-emblem" aria-hidden="true">
                  <IconMessages size={28} />
                </span>
                <div className="thread-kicker">MODEL POOLS</div>
                <h2>
                  Chat with a
                  <br />
                  <em>model pool</em>
                </h2>
                <p>
                  Choose a pool below. The model can use router data, memory,
                  and web search.
                </p>
                <div className="thread-starters">
                  {starters.map(({ icon: Icon, title: label, text }) => (
                    <button
                      key={label}
                      onClick={() => {
                        editDraft(text);
                        inputRef.current?.focus();
                      }}
                    >
                      <Icon size={17} />
                      <span>{label}</span>
                      <IconArrowUpRight size={13} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <footer className="thread-dock">
          {sample ? (
            <div className="thread-sample">
              Example data · No requests sent{" "}
              <Button
                size="xs"
                variant="light"
                onClick={() => setSample(false)}
              >
                Return to chat
              </Button>
            </div>
          ) : (
            <>
              {(chat.error || chat.storageNotice || (error && !dialog)) && (
                <div className="chat-error-banner" role="alert">
                  {error || chat.error || chat.storageNotice}
                </div>
              )}
              {chat.editIndex !== null && (
                <div className="chat-edit-note">
                  Sending replaces the conversation after this message.
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={chat.cancelEdit}
                  >
                    Cancel edit
                  </Button>
                </div>
              )}
              <div className="thread-controls">
                <label className="thread-pool">
                  <IconRoute size={16} />
                  <NativeSelect
                    aria-label="Pool"
                    size="xs"
                    value={pool ?? ""}
                    onChange={(e) => setPool(e.currentTarget.value || null)}
                    disabled={streaming || pending || !list.length}
                    data={[
                      { value: "", label: "Select a pool" },
                      ...list.map((p) => ({ value: p.name, label: p.name })),
                    ]}
                  />
                </label>
                <label className="thread-effort" title="Request a reasoning level for this chat. Auto uses the model default; support varies by model.">
                  Reasoning
                  <NativeSelect
                    aria-label="Reasoning effort"
                    size="xs"
                    value={chat.reasoningEffort}
                    disabled={!chat.ready || streaming || pending}
                    onChange={e => {
                      const next = readReasoningEffort(e.currentTarget.value);
                      void action(() => chat.changeReasoningEffort(next));
                    }}
                    data={[
                      { value: "auto", label: "Auto" },
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                    ]}
                  />
                </label>
                <span className="thread-status" role="status">
                  {streaming ? (
                    chat.status === "working" ? (
                      "Running tools…"
                    ) : (
                      "Generating…"
                    )
                  ) : selected ? (
                    `${selected.members.length} ${selected.members.length === 1 ? "model" : "models"}`
                  ) : pools.error ? (
                    "Pools unavailable"
                  ) : !pools.data ? (
                    "Loading pools…"
                  ) : !list.length ? (
                    <a href="#/pools">Create a pool</a>
                  ) : (
                    "Choose where to send"
                  )}
                </span>
                {(!edges.top || !edges.end) && (
                  <div className="thread-jumps">
                    <ActionIcon
                      aria-label="Go to first message"
                      title="First message"
                      variant="subtle"
                      color="gray"
                      disabled={edges.top}
                      onClick={() => jump(false)}
                    >
                      <IconArrowUp size={16} />
                    </ActionIcon>
                    <button
                      type="button"
                      disabled={edges.end}
                      onClick={() => jump(true)}
                    >
                      <IconArrowDown size={14} /> Latest
                    </button>
                  </div>
                )}
              </div>
              <ChatComposer
                selected={chat.ready && !pending ? selected : null}
                streaming={streaming}
                value={draft}
                onChange={editDraft}
                onSend={(text) => {
                  editDraft("");
                  follow.current = true;
                  void chat.send(text);
                }}
                onStop={chat.stop}
                inputRef={inputRef}
                editing={chat.editIndex !== null}
                onCancelEdit={chat.cancelEdit}
              />
              <div className="thread-dock-note">
                <span>Saved chats don’t sync across devices.</span>
                <span>
                  <kbd>Enter</kbd> send <i>·</i> <kbd>Shift Enter</kbd> newline
                </span>
              </div>
            </>
          )}
        </footer>
      </section>
      <Drawer
        opened={!!narrow && libraryOpen}
        onClose={() => setLibraryOpen(false)}
        title="Conversations"
        size={310}
        padding={0}
        position="left"
      >
        {library}
      </Drawer>
      <Modal
        opened={!!dialog}
        onClose={() => !pending && setDialog(null)}
        title={
          dialog?.type === "new"
            ? "Start a conversation"
            : dialog?.type === "rename"
              ? "Rename conversation"
              : dialog?.type === "delete"
                ? "Delete conversation?"
                : "Clear all conversations?"
        }
        centered
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          {naming ? (
            <TextInput
              data-autofocus
              label={
                dialog?.type === "new" ? "Chat name (optional)" : "Chat name"
              }
              maxLength={TITLE_CAP}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              description={
                dialog?.type === "new"
                  ? "Leave blank to use your first message as the title."
                  : undefined
              }
              placeholder="e.g. API design review"
            />
          ) : (
            <p>
              {dialog?.type === "delete"
                ? `“${dialog.item.title}” and its messages will be removed from this browser.`
                : "All conversations for this key will be removed from this browser. Saved memory stays."}
            </p>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="thread-dialog-actions">
            <Button
              type="button"
              variant="default"
              disabled={pending}
              onClick={() => setDialog(null)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              color={naming ? undefined : "red"}
              loading={pending}
              disabled={dialog?.type === "rename" && !name.trim()}
            >
              {dialog?.type === "new"
                ? "Create chat"
                : dialog?.type === "rename"
                  ? "Save name"
                  : "Delete"}
            </Button>
          </div>
        </form>
      </Modal>
      <MemoryPanel opened={memory} onClose={() => setMemory(false)} />
    </div>
  );
}
