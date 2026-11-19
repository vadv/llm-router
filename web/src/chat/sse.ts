// Parser for OpenAI-compatible chat completion streams. The router proxies
// upstream SSE bytes unchanged, so this module owns the wire format:
// LF and CRLF line ends, multi-line data fields, comment lines, events
// split across network chunks and code points split across UTF-8 chunks.

export type OpenAiToolCallDelta = {
  // Position of the call inside one assistant message; absent in some
  // providers when a single call is streamed.
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

export type OpenAiStreamDelta = {
  content?: string | null;
  // DeepSeek-style reasoning text.
  reasoning_content?: string | null;
  // Moonshot/Kimi and some OpenAI-compatible APIs use this alias.
  reasoning?: string | null;
  // OpenRouter detail list; text entries are displayable, encrypted or
  // signature-only entries are continuation data and carry no text.
  reasoning_details?: unknown;
  tool_calls?: OpenAiToolCallDelta[];
};

export type OpenAiStreamChoice = {
  delta?: OpenAiStreamDelta;
  finish_reason?: string | null;
};

export type OpenAiStreamError = { message?: string; type?: string } | string | undefined;

export type OpenAiStreamChunk = {
  choices?: OpenAiStreamChoice[];
  usage?: {
    completion_tokens?: number;
    output_tokens?: number;
  };
  // Some upstreams report a failed request as an in-stream error event.
  error?: OpenAiStreamError;
};

// A dispatch result: a chunk, the end marker, or nothing when the blank
// line closed an event without data fields.
type Dispatched = OpenAiStreamChunk | "done" | null;

export async function* parseOpenAiStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenAiStreamChunk> {
  const reader = stream.getReader();
  // stream: true keeps a code point split across chunks intact.
  const decoder = new TextDecoder();
  // A partial line and the data fields of the event being read.
  let pendingLine = "";
  let dataLines: string[] | null = null;

  const dispatch = (): Dispatched => {
    if (!dataLines) return null;
    const data = dataLines.join("\n");
    dataLines = null;
    if (data === "[DONE]") return "done";
    // A malformed data event must surface, not silently drop content.
    return JSON.parse(data) as OpenAiStreamChunk;
  };

  const consumeLine = (rawLine: string): Dispatched => {
    // SSE allows CRLF; the reader split on \n, so \r remains on the line.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return dispatch();
    // Comments and keep-alive lines carry no data.
    if (line.startsWith(":")) return null;
    if (line.startsWith("data:")) {
      (dataLines ??= []).push(line.slice("data:".length).replace(/^ /, ""));
    }
    // Other SSE fields (event, id, retry) do not appear in chat streams.
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pendingLine += decoder.decode(value, { stream: true });
      let newline = pendingLine.indexOf("\n");
      while (newline !== -1) {
        const event = consumeLine(pendingLine.slice(0, newline));
        if (event === "done") return;
        if (event) yield event;
        pendingLine = pendingLine.slice(newline + 1);
        newline = pendingLine.indexOf("\n");
      }
    }
    // Flush the decoder, then the last unterminated line and event: a
    // stream may end right after its final data field.
    pendingLine += decoder.decode();
    if (pendingLine !== "") {
      const tail = consumeLine(pendingLine);
      if (tail === "done") return;
      if (tail) yield tail;
    }
    const tail = dispatch();
    if (tail === "done") return;
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

// Human-readable text of an in-stream error event, for the error banner.
export function openAiErrorText(error: OpenAiStreamError): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return null;
}
