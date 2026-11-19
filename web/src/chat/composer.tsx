// Composer: message input with Send/Stop. Enter sends, Shift+Enter adds a
// newline; Escape cancels a pending edit. While the answer streams the
// input locks and Send becomes Stop. The text lives in the page so Edit
// can fill it from a message action.

import { IconArrowUp, IconPlayerStop } from "@tabler/icons-react";
import { Button, Textarea } from "@mantine/core";
import { type KeyboardEvent, type Ref } from "react";
import type { Pool } from "../api";

export function ChatComposer({
  selected,
  streaming,
  value,
  onChange,
  onSend,
  onStop,
  inputRef,
  editing,
  onCancelEdit,
}: {
  selected: Pool | null;
  streaming: boolean;
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  editing: boolean;
  onCancelEdit: () => void;
}) {
  const canSend = selected !== null && !streaming && value.trim() !== "";

  const submit = () => {
    if (!canSend) return;
    onSend(value.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter confirms an IME composition; only a plain Enter sends.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === "Escape" && editing) {
      event.preventDefault();
      onCancelEdit();
    }
  };

  return (
    <div className="chat-composer-box">
      <Textarea
        className="chat-composer-input"
        variant="unstyled"
        aria-label="Message"
        placeholder={
          selected
            ? `Message ${selected.name}`
            : "Create or select a pool to start"
        }
        autosize
        minRows={2}
        maxRows={8}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        disabled={streaming}
        ref={inputRef}
      />
      {streaming ? (
        <Button
          className="chat-send"
          aria-label="Stop generating"
          onClick={onStop}
        >
          <IconPlayerStop size={16} />
        </Button>
      ) : (
        <Button
          className="chat-send"
          aria-label="Send message"
          onClick={submit}
          disabled={!canSend}
        >
          <IconArrowUp size={16} />
        </Button>
      )}
    </div>
  );
}
