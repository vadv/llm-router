// Only the bundled QuickJS runtime executes guest code. The worker's own
// network, storage and page credentials are not exposed to the guest.
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, type QuickJSContext } from "quickjs-emscripten-core";
import type { SandboxedRun } from "./host";

type RunRequest = { code: string; input?: unknown };
const port = self as unknown as {
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null;
  postMessage: (message: SandboxedRun) => void;
};

function run(context: QuickJSContext, { code, input }: RunRequest): SandboxedRun {
  const evaluate = (source: string) => context.unwrapResult(context.evalCode(source, "tool.js"));
  evaluate("var __out = []; var console = { log: function () { __out.push(Array.prototype.join.call(arguments, ' ')); } };").dispose();
  if (input !== undefined) {
    context.newString(JSON.stringify(input)).consume(handle => context.setProp(context.global, "__inputJson", handle));
    evaluate("var input = JSON.parse(__inputJson);").dispose();
  }
  const output = () => evaluate("__out.join('\\n')").consume(handle => context.getString(handle));
  try {
    const handle = evaluate(code);
    try {
      const result = context.dump(handle);
      const stdout = output();
      if (result === undefined) return { stdout };
      if (typeof result === "symbol" || typeof result === "bigint") {
        return { stdout, errorType: "javascript_error", error: "Return a JSON value; convert symbols and big integers to strings." };
      }
      return { stdout, result };
    } finally {
      // QuickJS dump can consume a promise handle itself.
      if (handle.alive) handle.dispose();
    }
  } catch (cause) {
    return { stdout: output(), errorType: "javascript_error", error: String(cause).slice(0, 512) };
  }
}

port.onmessage = async ({ data }) => {
  let reply: SandboxedRun;
  try {
    const module = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
    const runtime = module.newRuntime();
    try {
      runtime.setMemoryLimit(128 * 1024 * 1024);
      const context = runtime.newContext();
      try {
        reply = run(context, data);
      } finally {
        context.dispose();
      }
    } finally {
      runtime.dispose();
    }
  } catch {
    reply = { stdout: "", errorType: "sandbox_unavailable", error: "The local QuickJS runtime could not load or complete the run." };
  }
  port.postMessage(reply);
};
