// Drives one page of the UI in a headless Chrome: opens it, acts on it the
// way a person would, reads it, photographs it. The scripts that check the
// interface share it, so each says only what it wants to see.
//
// Steps, the same in every script that uses them:
//   click SELECTOR        a pointer click on the first match
//   clickjs EXPRESSION    the same, on the element the expression returns
//   hover SELECTOR        the pointer moved over the first match
//   key k meta            a shortcut (meta, ctrl, shift)
//   anything else         script that runs in the page
// The pointer steps act like a pointer because that is what component menus
// listen to; a scripted .click() does not open them.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Profiles of the browsers still running. Interruption by signal skips
// `finally`, so the signal paths run the same cleanup as a normal exit.
const LIVE = new Set();
process.on("exit", () => {
  for (const profile of LIVE)
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => process.exit(130));
}

// One browser per page: headless Chrome stops answering after a run of
// reloads, and a browser that died silently would end a run without an error.
// `view` is the page's: width and height in CSS pixels, `scale` the device
// pixel ratio, `mobile` a phone's viewport behaviour, `init` script that runs
// before the app on every document (a stored key, for one).
// `body` gets the page and returns what the caller needs.
export async function openPage(
  { width = 1440, height = 1000, scale = 1, mobile = false, init = "" } = {},
  body,
) {
  // A private profile: a run against a live router stores the key in it.
  const profile = mkdtempSync(join(tmpdir(), "llm-router-ui-"));
  LIVE.add(profile);
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      // Port 0 lets Chrome pick a free one and print the endpoint on stderr.
      // Taking the URL from OUR child's stderr keeps a stale browser off the
      // cleanup list.
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let tail = "";
      const timer = setTimeout(
        () => reject(new Error("chrome did not name a devtools endpoint")),
        15000,
      );
      chrome.stderr.on("data", (chunk) => {
        const line = (tail += chunk.toString())
          .split("\n")
          .find((part) => part.startsWith("DevTools listening on "));
        if (line) {
          clearTimeout(timer);
          resolve(line.slice("DevTools listening on ".length).trim());
        }
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 1;
    const waiting = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = waiting.get(message.id);
      if (!waiter) return;
      waiting.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    const send = (method, params = {}, sessionId) => {
      const answer = new Promise((resolve, reject) => {
        const id = nextId++;
        waiting.set(id, { resolve, reject });
        socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      });
      // A page reloading under a command never answers it.
      let timer;
      const limit = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${method} did not answer`)),
          20000,
        );
      });
      return Promise.race([answer, limit]).finally(() => clearTimeout(timer));
    };
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height, deviceScaleFactor: scale, mobile },
      sessionId,
    );
    if (init) await send("Page.addScriptToEvaluateOnNewDocument", { source: init }, sessionId);

    const evaluate = async (expression) => {
      const reply = await send(
        "Runtime.evaluate",
        { returnByValue: true, expression, awaitPromise: true },
        sessionId,
      );
      if (reply.exceptionDetails)
        throw new Error(
          `in the page: ${reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text}`,
        );
      return reply.result.value;
    };
    const navigate = async (url) => {
      await send("Page.navigate", { url }, sessionId);
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await evaluate("document.readyState")) === "complete") return;
        await sleep(100);
      }
      throw new Error(`${url} did not finish loading`);
    };
    const steps = async (list) => {
      for (const step of list) {
        const [verb, ...rest] = step.trim().split(/\s+/);
        const target = rest.join(" ");
        if (verb === "click" || verb === "clickjs" || verb === "hover") {
          // The element never leaves the page: only the point to aim at does.
          const finder =
            verb === "clickjs" ? `(() => (${target}))()` : `document.querySelector(${JSON.stringify(target)})`;
          const point = await evaluate(`(() => {
            const el = ${finder};
            if (!el) return null;
            el.scrollIntoView({ block: "center" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          if (!point) throw new Error(`no element for: ${step.trim()}`);
          const at = { x: point.x, y: point.y, button: verb === "hover" ? "none" : "left" };
          await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }, sessionId);
          if (verb !== "hover") {
            await send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, buttons: 1, clickCount: 1 }, sessionId);
            await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, buttons: 0, clickCount: 1 }, sessionId);
          }
          await sleep(1100);
          continue;
        }
        if (verb === "key") {
          const [key, ...mods] = rest;
          const pressed = {
            key,
            code: `Key${key.toUpperCase()}`,
            modifiers:
              (mods.includes("meta") ? 4 : 0) |
              (mods.includes("ctrl") ? 2 : 0) |
              (mods.includes("shift") ? 8 : 0),
            windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
          };
          await send("Input.dispatchKeyEvent", { type: "keyDown", ...pressed }, sessionId);
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...pressed }, sessionId);
          await sleep(1100);
          continue;
        }
        await evaluate(`(() => { ${step.trim()}; return true; })()`);
        await sleep(900);
      }
    };
    // A PNG of what the page shows, or of the whole document with `full`.
    const screenshot = async ({ full = false } = {}) =>
      Buffer.from(
        (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full }, sessionId)).data,
        "base64",
      );
    const page = { send, sessionId, evaluate, navigate, steps, screenshot };
    const result = await body(page);
    await send("Target.closeTarget", { targetId });
    socket.close();
    return result;
  } finally {
    chrome.kill("SIGKILL");
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    LIVE.delete(profile);
  }
}
