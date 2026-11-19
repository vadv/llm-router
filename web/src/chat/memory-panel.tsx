// Memory panel: the saved notes of the current key, read and mutated
// through the same server bridge the memory tools use. No new backend
// routes.

import { Button, Drawer, Group, Text, Textarea, TextInput } from "@mantine/core";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { parseEntries, postChat, recallEntries, type MemoryEntry } from "./tools/server";

// The recall endpoint requires a non-empty query and matches substrings.
// shortcut: "e" lists almost any note but can miss odd ones; replace with a
// real list endpoint when the memory panel grows.
const BROAD_QUERY = "e";

type EditState = { id: number; topic: string; note: string };

export function MemoryPanel({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    setEntries(null);
    setError(null);
    setEditing(null);
    void (async () => {
      const response = await recallEntries(BROAD_QUERY, undefined, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setError(response.failure.message);
        return;
      }
      const parsed = parseEntries(response.value);
      if (parsed === null) {
        setError("Memory recall returned an invalid response.");
        return;
      }
      setEntries(parsed);
    })();
    return () => controller.abort();
  }, [opened, reloadToken]);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  const mutate = useCallback(
    async (path: string, body: unknown) => {
      setError(null);
      const response = await postChat(path, body, new AbortController().signal);
      if (!response.ok) {
        setError(response.failure.message);
        return false;
      }
      reload();
      return true;
    },
    [reload],
  );

  const removeEntry = (entry: MemoryEntry) => {
    if (!window.confirm(`Delete the memory entry "${entry.topic}"?`)) return;
    void mutate("/v1/chat/memory/delete", { id: entry.id });
  };

  const saveEdit = async () => {
    if (editing === null) return;
    const topic = editing.topic.trim();
    const note = editing.note.trim();
    if (topic === "" || note === "") {
      setError("Topic and note must not be empty.");
      return;
    }
    if (await mutate("/v1/chat/memory/edit", { id: editing.id, topic, note })) {
      setEditing(null);
    }
  };

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="Memory"
      position="right"
      size={360}
    >
      <div className="chat-drawer-body">
        {error !== null && (
          <Text size="sm" c="red" role="alert">
            {error}
          </Text>
        )}
        {entries === null ? (
          error === null && (
            <Text size="sm" c="dimmed">
              Loading saved notes…
            </Text>
          )
        ) : entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No saved notes for this key yet. The model saves notes through the memory tool.
          </Text>
        ) : (
          <div className="chat-drawer-list" role="list">
            {entries.map((entry) => (
              <div key={entry.id} role="listitem" className="chat-memory-entry">
                {editing !== null && editing.id === entry.id ? (
                  <div className="chat-memory-edit">
                    <TextInput
                      aria-label="Topic"
                      placeholder="Topic"
                      value={editing.topic}
                      onChange={(event) => setEditing({ ...editing, topic: event.currentTarget.value })}
                    />
                    <Textarea
                      aria-label="Note"
                      placeholder="Note"
                      autosize
                      minRows={2}
                      maxRows={6}
                      value={editing.note}
                      onChange={(event) => setEditing({ ...editing, note: event.currentTarget.value })}
                    />
                    <Group gap="xs">
                      <Button size="xs" onClick={() => void saveEdit()}>
                        Save
                      </Button>
                      <Button size="xs" variant="default" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </Group>
                  </div>
                ) : (
                  <>
                    <div className="chat-memory-text">
                      <span className="chat-memory-topic">{entry.topic}</span>
                      <span className="chat-memory-note">{entry.note}</span>
                    </div>
                    <div className="chat-memory-actions">
                      <Button
                        variant="subtle"
                        size="compact-xs"
                        leftSection={<IconPencil size={13} />}
                        aria-label={`Edit memory entry: ${entry.topic}`}
                        onClick={() => setEditing({ id: entry.id, topic: entry.topic, note: entry.note })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="subtle"
                        color="red"
                        size="compact-xs"
                        leftSection={<IconTrash size={13} />}
                        aria-label={`Delete memory entry: ${entry.topic}`}
                        onClick={() => removeEntry(entry)}
                      >
                        Delete
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}
