// javascript tool: runs model code in the sandbox worker. The sandbox has
// no network, no DOM and no access to the chat page or its credentials.

import { runJavaScript } from "../sandbox/host";
import { requireObject, requireString, toolError, type ToolDefinition, type ToolResult } from "./types";

export const javascriptTool: ToolDefinition = {
  name: "javascript",
  description:
    "Run synchronous JavaScript locally in QuickJS, not at a provider. Use the last expression for the result (no top-level return), and input for supplied JSON. No network, DOM or files.",
  permission: "javascript",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Program source. The value of the last statement becomes the result; use console.log for intermediate output." },
      input: { description: "JSON value available to the code as the global `input`." },
    },
    required: ["code"],
  },
  async execute(raw, ctx): Promise<ToolResult> {
    const args = requireObject(raw);
    if (args === null) return toolError("invalid_arguments", "arguments must be an object");
    const code = requireString(args, "code");
    if (code === null) return toolError("invalid_arguments", "code (non-empty string) is required");
    const run = await runJavaScript(code, args.input, ctx.signal);
    if (run.error !== undefined) return toolError(run.errorType, run.error);
    const blocks: string[] = [];
    if (run.stdout !== "") blocks.push(`console:\n${run.stdout}`);
    if ("result" in run) blocks.push(`result:\n${JSON.stringify(run.result, null, 2)}`);
    return { ok: true, result: blocks.length > 0 ? blocks.join("\n\n") : "undefined" };
  },
};
