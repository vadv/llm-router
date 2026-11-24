import { ActionIcon, Button, Menu, TextInput } from "@mantine/core";
import {
  IconDots,
  IconEdit,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import type { ConversationSummary } from "./store";

export function ConversationLibrary({
  conversations,
  activeId,
  disabled,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onClear,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  disabled: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (item: ConversationSummary) => void;
  onDelete: (item: ConversationSummary) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const visible = conversations.filter((c) =>
    (c.title + " " + c.pool).toLowerCase().includes(query),
  );
  return (
    <section className="thread-library" aria-label="Conversation library">
      <div className="thread-library-head">
        <h2>
          Conversations{" "}
          {conversations.length > 0 && <span className="thread-count">{conversations.length}</span>}
        </h2>
        <Button
          fullWidth
          size="sm"
          leftSection={<IconPlus size={16} />}
          onClick={onNew}
          disabled={disabled}
        >
          New chat
        </Button>
        <TextInput
          type="search"
          size="xs"
          aria-label="Find conversations"
          placeholder="Find a conversation"
          leftSection={<IconSearch size={14} />}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
      </div>
      <div className="thread-library-items">
        {visible.length > 0 ? (
          <>
            <div className="thread-section-label">{query ? "Matches" : "Recent"}</div>
            {visible.map((c) => (
              <div
                key={c.id}
                className="thread-link-row"
                data-selected={c.id === activeId}
              >
                <button
                  type="button"
                  className="thread-link"
                  aria-current={c.id === activeId ? "true" : undefined}
                  disabled={disabled}
                  onClick={() => onSelect(c.id)}
                >
                  <strong title={c.title}>{c.title}</strong>
                  <small>
                    {c.pool || "No pool"} ·{" "}
                    {c.messageCount
                      ? `${c.messageCount} ${c.messageCount === 1 ? "message" : "messages"}`
                      : "Empty chat"}
                  </small>
                </button>
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      disabled={disabled}
                      aria-label={`Actions for ${c.title}`}
                    >
                      <IconDots size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={<IconEdit size={14} />}
                      onClick={() => onRename(c)}
                    >
                      Rename
                    </Menu.Item>
                    <Menu.Item
                      color="red"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => onDelete(c)}
                    >
                      Delete
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </div>
            ))}
          </>
        ) : (
          <p className="thread-no-results">
            {query
              ? "No matching conversations."
              : "Your conversations will appear here."}
          </p>
        )}
      </div>
      {conversations.length > 0 && (
        <footer>
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            leftSection={<IconTrash size={14} />}
            disabled={disabled}
            onClick={onClear}
          >
            Clear all conversations
          </Button>
        </footer>
      )}
    </section>
  );
}
