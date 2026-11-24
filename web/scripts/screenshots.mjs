#!/usr/bin/env node
// Screenshot the UI against the in-memory mock: no core process, no credentials.
// With ROUTER_KEY in the environment the same shots come from a live core
// instead. The key is never printed. It reaches the page through localStorage
// on the expected origin only, inside a throwaway browser profile that is
// deleted when the run ends, so no credential survives on disk.
// Mobile shots need real device emulation because headless Chrome cannot open a
// window narrower than 500 CSS px. Node 22+ ships a global WebSocket, so this
// talks to the DevTools protocol without extra packages.
//
// Usage: node scripts/screenshots.mjs [base-url] [out-dir]

import { spawn } from "node:child_process";
import { chmodSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://localhost:5199";
const OUT = process.argv[3] ?? "../shots";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Live mode: a real client key, supplied only through the environment.
const KEY = process.env.ROUTER_KEY ?? "";
const QUERY = KEY ? "" : "mock=1&";
const ORIGIN = new URL(BASE).origin;

// `route` follows the "#/" of the address; `name` names the file, so a
// route with a query stays a clean file name.
const PAGES = [
  { route: "overview", name: "overview" },
  { route: "usage", name: "usage" },
  { route: "balances", name: "balances" },
  { route: "providers", name: "providers" },
  { route: "pools", name: "pools" },
  { route: "history", name: "history" },
  { route: "activity", name: "activity" },
  { route: "wiki", name: "wiki" },
  { route: "wiki?view=leaderboard", name: "wiki-leaderboard" },
  // A job in progress: the mock opens with one for this route.
  { route: "wiki?job=running", name: "wiki-research" },
  // A key of the mock catalog.
  { route: "wiki?model=glm-4-6", name: "wiki-dossier" },
  { route: "chat", name: "chat" },
];

// Widths matter more than device names: 1440 hides an overflow that appears
// just above the two-column breakpoint, and 390 never shows two columns at all.
const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000, scale: 2 },
  { name: "laptop", width: 1280, height: 900, scale: 1 },
  { name: "narrow", width: 1024, height: 900, scale: 1 },
  { name: "tablet", width: 820, height: 900, scale: 1 },
  { name: "window", width: 628, height: 900, scale: 1 },
  { name: "mobile", width: 390, height: 844, scale: 1, mobile: true },
];

// One browser per viewport: Chrome dies after roughly thirty reloads of a
// chart-heavy page, and a lost DevTools socket ends the run without an error.
// A fresh browser per viewport keeps every batch well below that.
async function launch() {
  // A private profile per browser: a reused one would keep the injected key.
  const profile = await mkdtemp(join(tmpdir(), "llm-router-shots-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      // Port 0 lets Chrome pick a free one and print the endpoint on stderr.
      // Taking the URL from OUR child's stderr — not from whoever answers on
      // a known port — keeps the key away from an impostor process and a
      // stale browser off our cleanup list.
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // The one startup line that names the endpoint; the rest is noise.
  let url = null;
  let tail = "";
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("chrome did not name a devtools endpoint")),
      15000,
    );
    chrome.stderr.on("data", (chunk) => {
      if (url) return;
      tail += chunk.toString();
      const line = tail.split("\n").find((part) => part.startsWith("DevTools listening on "));
      if (line) {
        url = line.slice("DevTools listening on ".length).trim();
        clearTimeout(timer);
        resolve(url);
      }
    });
    chrome.once("exit", () => {
      if (!url) {
        clearTimeout(timer);
        reject(new Error("chrome exited before naming a devtools endpoint"));
      }
    });
  });
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  const stop = async () => {
    chrome.kill("SIGKILL");
    await exited;
  };
  const clean = () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  LIVE.push({ stop, clean });
  return { stop, url: ready, profile, clean };
}

// Live mode stores the client key in Chrome profiles. Interruption by signal
// skips `finally`, so the signal paths run the same cleanup as a normal exit.
// Best-effort only: SIGKILL can still leave a profile behind.
const LIVE = [];
async function cleanupAll() {
  for (const one of LIVE) {
    try {
      await one.stop();
      one.clean();
    } catch {
      // A dead Chrome or a removed profile is already the wanted end state.
    }
  }
}
process.on("exit", () => {
  for (const one of LIVE) one.clean();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanupAll().then(() => process.exit(0));
  });
}

class Session {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #events = new Map();

  static async open(url) {
    const session = new Session();
    session.#ws = new WebSocket(url);
    session.#ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const waiter = session.#pending.get(message.id);
        session.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
        return;
      }
      session.#events.get(message.method)?.(message.params);
    });
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener("open", resolve, { once: true });
      session.#ws.addEventListener("error", reject, { once: true });
    });
    return session;
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  once(method) {
    return new Promise((resolve) => this.#events.set(method, resolve));
  }

  close() {
    this.#ws.close();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  // Live shots carry real balances and history: keep them for this user only.
  // chmod also fixes a directory that already existed with broader rights.
  if (KEY) chmodSync(OUT, 0o700);

  // An old core process once kept the port and served an old embedded build,
  // so the shots looked fine while the fixes were invisible. In live mode the
  // served index must name the same bundle as the dist we just built.
  if (KEY) {
    const bundle = (html) => (html.match(/assets\/index-[\w-]+\.js/) ?? ["none"])[0];
    const local = bundle(await readFile(new URL("../dist/index.html", import.meta.url), "utf8"));
    const served = bundle(await (await fetch(`${BASE}/`)).text());
    if (local !== served) {
      throw new Error(`core serves ${served}, dist has ${local}: rebuild and restart the core`);
    }
  }

  const openTab = async (browser) => {
    const { targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await browser.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Runtime.enable", {}, sessionId);
    return { targetId, sessionId };
  };

  const waitReady = async (send) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const { result } = await send("Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (result.value === "complete") return;
      await sleep(100);
    }
    throw new Error("page did not reach readyState complete");
  };

  // Element whose right edge passes the viewport, as a short css-ish path.
  const PROBE = `(() => {
    const path = (el) => {
      const names = [];
      let node = el;
      for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
        const cls = node.className?.toString().split(" ")[0];
        names.push(node.tagName.toLowerCase() + (cls ? "." + cls : ""));
      }
      return names.join("<");
    };
    const wide = Array.from(document.querySelectorAll("*"))
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 3)
      .map((el) => path(el) + "=" + Math.round(el.getBoundingClientRect().right));
    return JSON.stringify({ viewport: window.innerWidth, scroll: document.documentElement.scrollWidth, wide });
  })()`;

  // Each shot gets its own URL so the document reloads: a hash change alone
  // fires no load event and keeps the previous route on screen.
  const shoot = async (send, url, file, beyondViewport = true) => {
    await send("Page.navigate", { url });
    await waitReady(send);
    await sleep(700);
    const shot = await send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      captureBeyondViewport: beyondViewport,
    });
    if (!shot?.data) throw new Error(`no screenshot for ${url}`);
    const probe = await send("Runtime.evaluate", {
      expression: PROBE,
      returnByValue: true,
    });
    await writeFile(file, Buffer.from(shot.data, "base64"));
    if (KEY) chmodSync(file, 0o600);
    console.log(file, probe.result.value);
  };

  for (const viewport of [
    ...VIEWPORTS,
    { name: "extra", width: 1440, height: 900, scale: 1 },
  ]) {
    const { stop, url, profile } = await launch();
    try {
      const browser = await Session.open(await url);
      const { targetId, sessionId } = await openTab(browser);
      const send = (method, params) => browser.send(method, params, sessionId);
      let injected = null;
      if (KEY) {
        // Runs before the app on every document, so the key gate never appears.
        const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", {
          source: `if (location.origin === ${JSON.stringify(ORIGIN)}) localStorage.setItem("llm-router.key", ${JSON.stringify(KEY)});`,
        });
        injected = identifier;
      }
      await send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.scale,
        mobile: Boolean(viewport.mobile),
      });

      if (viewport.name !== "extra") {
        for (const { route, name } of PAGES) {
          await shoot(
            send,
            `${BASE}/?${QUERY}shot=${name}${viewport.name}#/${route}`,
            `${OUT}/${name}-${viewport.name}.jpg`,
            // A tall page at scale 2 exceeds the capture limit, so a phone
            // gets the first screen. The probe still measures the document.
            !viewport.mobile,
          );
        }
      } else {
        // Locked state: no key in this document, so the gate is what shows.
        // The injection is removed and the stored key cleared, then restored
        // for the authenticated light-theme shot after it.
        if (injected !== null) {
          await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected });
        }
        await send("Runtime.evaluate", {
          expression: `localStorage.removeItem("llm-router.key")`,
        });
        await shoot(
          send,
          `${BASE}/?shot=gate#/overview`,
          `${OUT}/gate-desktop.jpg`,
          false,
        );
        if (injected !== null) {
          const { identifier } = await send("Page.addScriptToEvaluateOnNewDocument", {
            source: `if (location.origin === ${JSON.stringify(ORIGIN)}) localStorage.setItem("llm-router.key", ${JSON.stringify(KEY)});`,
          });
          injected = identifier;
        }
        // Light theme, stored the same way the toggle stores it.
        await send("Runtime.evaluate", {
          expression: `localStorage.setItem("llm-router.scheme", "light")`,
        });
        await shoot(
          send,
          `${BASE}/?${QUERY}shot=light#/overview`,
          `${OUT}/overview-light.jpg`,
        );
      }
      await browser.send("Target.closeTarget", { targetId });
      browser.close();
    } finally {
      await stop();
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
