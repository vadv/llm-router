// Only plain values cross the worker boundary. Terminating the worker also
// stops a synchronous guest loop that cannot process an abort message.
export type SandboxedRun =
  | { stdout: string; result?: unknown; error?: never }
  | { stdout: string; error: string; errorType: "sandbox_unavailable" | "javascript_error" | "sandbox_timeout" | "aborted" };

const RUN_TIMEOUT_MS = 10_000;
const unavailable = (): SandboxedRun => ({ stdout: "", errorType: "sandbox_unavailable", error: "The local JavaScript sandbox could not start." });
const stopped = (): SandboxedRun => ({ stdout: "", errorType: "aborted", error: "Stopped by the user." });

export function runJavaScript(code: string, input?: unknown, signal?: AbortSignal): Promise<SandboxedRun> {
  if (signal?.aborted) return Promise.resolve(stopped());
  if (typeof Worker === "undefined") return Promise.resolve(unavailable());
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./quickjs-worker.ts", import.meta.url), { type: "module" });
    } catch {
      resolve(unavailable());
      return;
    }
    const abort = () => finish(stopped());
    const finish = (run: SandboxedRun) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      resolve(run);
    };
    const timer = setTimeout(() => finish({ stdout: "", errorType: "sandbox_timeout", error: "Local JavaScript exceeded its 10 second limit." }), RUN_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event: MessageEvent<SandboxedRun>) => finish(event.data);
    worker.onerror = worker.onmessageerror = () => finish(unavailable());
    try {
      worker.postMessage({ code, input });
    } catch {
      finish(unavailable());
    }
  });
}
