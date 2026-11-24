#!/usr/bin/env node
// Re-shoot the four images of the README from the mock UI, so they show the
// interface as it is rather than as it was when somebody last composed them
// by hand. Every crop is read off the page (where the fifth row ends, where
// the drawer begins), so a moved header does not cut a picture in the wrong
// place. The alt texts in README.md are prose and stay hand-written; keep
// them free of times and model names, since the mock's clock is relative.
//
// Needs Chrome (CHROME=/path/to/chrome for another one) and Pillow-free
// imaging: the composing happens in a canvas of the same headless browser.
// Nothing here reads or writes a real router.
//
// Usage: node scripts/readme-images.mjs [base-url]
//   or: npm run readme
// With nothing answering on the base URL, the mock dev server is started for
// the run and stopped after it.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { openPage } from "./headless-ui.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const README = fileURLToPath(new URL("../../assets/readme/", import.meta.url));
const BASE = process.argv[2] ?? "http://localhost:5199";
// The captures are taken at twice the resolution they are shown at.
const SCALE = 2;

// ---- Sources: what to open, what to do there, what to keep --------------

const byText = (selector, text) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => /${text}/.test(el.textContent))`;
// In the viewport, counted from its corner; a full-page capture starts there.
const viewportBox = (page, finder) =>
  page.evaluate(`(() => {
    const el = ${finder};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.right, r.bottom];
  })()`);
const around = (box_, pad) => [box_[0] - pad, box_[1] - pad, box_[2] + pad, box_[3] + pad];
// The bottom of the first row of cards, which may hold cards of different heights.
const firstRowBottom = (page, selector) =>
  page.evaluate(`(() => {
    const tops = [...document.querySelectorAll(${JSON.stringify(selector)})].map((el) => el.getBoundingClientRect());
    const first = tops[0]?.top;
    return Math.max(...tops.filter((r) => r.top === first).map((r) => r.bottom));
  })()`);
// The bottom of the nth match: where a list of rows is cut.
const nthBottom = (page, selector, nth) =>
  viewportBox(page, `[...document.querySelectorAll(${JSON.stringify(selector)})][${nth - 1}]`).then((found) => found[3]);

const SOURCES = {
  async wiki(page) {
    await page.navigate(`${BASE}/?mock=1#/wiki`);
    await settled(page, ".wiki-row:nth-of-type(7)");
    const [x0, , x1] = await viewportBox(page, 'document.querySelector(".wiki-row-head")');
    const top = (await viewportBox(page, 'document.querySelector(".wiki-count")'))[1] - 7;
    const bottom = await nthBottom(page, "a.wiki-row", 5);
    return { png: await page.screenshot({ full: true }), keep: [x0 - 7, top, x1 + 7, bottom] };
  },
  async board(page) {
    await page.navigate(`${BASE}/?mock=1#/wiki?view=leaderboard`);
    await settled(page, ".board-row:nth-of-type(9)");
    const [x0, , x1] = await viewportBox(page, 'document.querySelector(".board-head")');
    const top = (await viewportBox(page, 'document.querySelector(".wiki-order")'))[1] - 7;
    // Eight rows: with the directory above, the column stands as tall as the dossier.
    const bottom = await nthBottom(page, "a.board-row", 8);
    return { png: await page.screenshot(), keep: [x0 - 7, top, x1 + 7, bottom] };
  },
  async dossier(page) {
    await page.navigate(`${BASE}/?mock=1#/wiki?model=glm-4-6`);
    await settled(page, ".score:nth-of-type(3)");
    // The drawer takes the keyboard focus on opening; a pointer would not show it.
    await page.evaluate("document.activeElement?.blur(); true");
    await sleep(400);
    const [x0, , x1] = await viewportBox(page, 'document.querySelector(".mantine-Drawer-content")');
    // Through the second benchmark row: the next row starts with padding, which
    // would read as a row cut short.
    const bottom = (await viewportBox(page, 'document.querySelector(".score:nth-of-type(2)")'))[3];
    return { png: await page.screenshot(), keep: [x0, 0, x1, bottom] };
  },
  async balances(page) {
    await page.navigate(`${BASE}/?mock=1#/balances`);
    await settled(page, ".balance-card");
    const [x0, , x1] = await viewportBox(page, 'document.querySelector(".balance-grid")');
    const top = (await viewportBox(page, 'document.querySelector(".balance-filters")'))[1] - 6;
    return { png: await page.screenshot({ full: true }), keep: [x0 - 6, top, x1 + 6, (await firstRowBottom(page, ".balance-card")) + 8] };
  },
  async usage(page) {
    await page.navigate(`${BASE}/?mock=1#/usage`);
    await settled(page, ".usage-activity .calls-slot");
    const filters = await viewportBox(page, 'document.querySelector(".ux-controls")');
    const chart = await viewportBox(page, 'document.querySelector(".ux-chart")');
    return { png: await page.screenshot({ full: true }), keep: [filters[0] - 6, filters[1] - 6, filters[2] + 6, chart[3]] };
  },
  async pools(page) {
    await page.navigate(`${BASE}/?mock=1#/pools`);
    await settled(page, ".mantine-SimpleGrid-root .mantine-Paper-root");
    const [x0, , x1] = await viewportBox(page, 'document.querySelector(".pb-launch")');
    const top = (await viewportBox(page, 'document.querySelector(".pb-launch")'))[1] - 6;
    return { png: await page.screenshot({ full: true }), keep: [x0 - 6, top, x1 + 6, (await firstRowBottom(page, ".mantine-SimpleGrid-root .mantine-Paper-root")) + 8] };
  },
  // The busiest interval selected, and one of its calls open.
  async history(page) {
    await page.navigate(`${BASE}/?mock=1#/history`);
    await settled(page, ".request-open");
    await page.steps([
      'clickjs (() => { const slots = [...document.querySelectorAll(".calls-slot")]; return slots.reduce((best, el) => parseFloat(el.firstElementChild?.style.height || "0") > parseFloat(best.firstElementChild?.style.height || "0") ? el : best, slots[0]); })()',
      "click .request-open",
      '(() => { const panel = document.querySelector(".calls-plot").closest(".mantine-Paper-root"); scrollTo(0, panel.getBoundingClientRect().top + scrollY - 66); })()',
    ]);
    const [panelLeft, panelTop, ,] = await viewportBox(page, 'document.querySelector(".calls-plot").closest(".mantine-Paper-root")');
    const [drawerLeft, , drawerRight] = await viewportBox(page, 'document.querySelector(".mantine-Drawer-content")');
    const body = await viewportBox(page, 'document.querySelector(".mantine-Drawer-content .mantine-Drawer-body")');
    return {
      png: await page.screenshot(),
      keep: {
        page: [panelLeft, panelTop - 6, drawerLeft, 900 - 26],
        drawer: [drawerLeft, 0, drawerRight, body[3] + 14],
      },
    };
  },
  // The example thread, scrolled to the pool update and the sandbox run.
  async chat(page) {
    await page.navigate(`${BASE}/?mock=1#/chat`);
    await settled(page, ".thread-starters button");
    await page.steps([
      'clickjs [...document.querySelectorAll("button")].find((el) => el.getAttribute("aria-haspopup") === "menu")',
      'clickjs [...document.querySelectorAll("[role=menuitem]")].find((el) => /example/i.test(el.textContent))',
      `(() => { const scroller = document.querySelector(".thread-scroll"); const card = ${byText(".chat-tool", "Pool update")}; scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 14; })()`,
    ]);
    const pool = await viewportBox(page, byText(".chat-tool", "Pool update"));
    const script = await viewportBox(page, byText(".chat-tool", "JavaScript"));
    return { png: await page.screenshot(), keep: around([pool[0], pool[1], pool[2], script[3]], 10) };
  },
};

// Wait for the page to have what the picture needs, then let it settle.
async function settled(page, selector) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await page.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) break;
    await sleep(100);
  }
  await sleep(1500);
}

// ---- Sheets: which crops go side by side ---------------------------------

const SHEETS = [
  {
    name: "model-wiki",
    columns: [
      { width: 738, number: "01", title: "Каталог моделей и лидерборд", panels: [["wiki"], ["board"]] },
      { width: 738, number: "02", title: "GLM-4.6 · досье", panels: [["dossier"]] },
    ],
  },
  {
    name: "request-trace",
    columns: [
      // The open drawer covers the right of the page: the page stops where it begins.
      { width: 551, number: "01", title: "Журнал запросов: интервал, попытки и карточка вызова", panels: [["history", "page"]] },
      { width: 454, panels: [["history", "drawer"]] },
    ],
  },
  {
    name: "balances-and-usage",
    columns: [
      { width: 738, number: "01", title: "Балансы и квоты", panels: [["balances"]] },
      { width: 738, number: "02", title: "Usage за 24 часа", panels: [["usage"]] },
    ],
  },
  {
    name: "chat-to-pool",
    columns: [
      { width: 738, number: "01", title: "Чат вызывает pool_update", panels: [["chat"]] },
      { width: 738, number: "02", title: "Сохранённые пулы", panels: [["pools"]] },
    ],
  },
];

// ---- The mock dev server ------------------------------------------------

async function answering(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function devServer() {
  if (await answering(`${BASE}/`)) return () => {};
  const port = new URL(BASE).port || 80;
  const vite = spawn("npx", ["vite", "--port", port, "--strictPort", "--host", "127.0.0.1"], {
    cwd: WEB,
    stdio: ["ignore", "ignore", "pipe"],
  });
  vite.stderr.on("data", () => {});
  for (let attempt = 0; attempt < 100 && !(await answering(`${BASE}/`)); attempt++) await sleep(200);
  if (!(await answering(`${BASE}/`))) {
    vite.kill("SIGKILL");
    throw new Error(`nothing answers on ${BASE}, and the dev server did not start`);
  }
  return () => vite.kill("SIGTERM");
}

// ---- Composing, in a canvas ----------------------------------------------

const COMPOSE = `async (sheets, sources) => {
  const images = {};
  for (const [name, url] of Object.entries(sources)) {
    const image = new Image();
    image.src = url;
    await image.decode();
    images[name] = image;
  }
  const MARGIN = 24, GAP = 24, STACK = 16, TITLE = 52, RADIUS = 12, SCALE = ${SCALE};
  const FONT = '600 21px "Helvetica Neue", Helvetica, Arial, sans-serif';
  const round = (ctx, x, y, width, height) => {
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, RADIUS);
  };
  const sheetsOut = {};
  for (const sheet of sheets) {
    const width = MARGIN * 2 + sheet.columns.reduce((sum, column) => sum + column.width, 0) + GAP * (sheet.columns.length - 1);
    const heightOf = (column) =>
      column.panels.reduce((sum, [, crop]) => sum + Math.round(((crop[3] - crop[1]) * column.width) / (crop[2] - crop[0])), 0) +
      STACK * (column.panels.length - 1);
    const height = TITLE + Math.max(...sheet.columns.map(heightOf)) + MARGIN;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#111215";
    ctx.fillRect(0, 0, width, height);
    let left = MARGIN;
    for (const column of sheet.columns) {
      if (column.title) {
        ctx.font = FONT;
        ctx.fillStyle = "#2fbf8f";
        ctx.fillText(column.number, left, 34);
        ctx.fillStyle = "#eef0f3";
        ctx.fillText(column.title, left + 38, 34);
      }
      let top = TITLE;
      for (const [source, crop] of column.panels) {
        const panelWidth = column.width;
        const panelHeight = Math.round(((crop[3] - crop[1]) * panelWidth) / (crop[2] - crop[0]));
        ctx.save();
        round(ctx, left, top, panelWidth, panelHeight);
        ctx.clip();
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(images[source], crop[0] * SCALE, crop[1] * SCALE, (crop[2] - crop[0]) * SCALE, (crop[3] - crop[1]) * SCALE, left, top, panelWidth, panelHeight);
        ctx.restore();
        round(ctx, left + 0.5, top + 0.5, panelWidth - 1, panelHeight - 1);
        ctx.strokeStyle = "#2e3034";
        ctx.lineWidth = 1;
        ctx.stroke();
        top += panelHeight + STACK;
      }
      left += column.width + GAP;
    }
    const webp = canvas.toDataURL("image/webp", 0.84);
    if (!webp.startsWith("data:image/webp")) throw new Error("this Chrome cannot encode WebP");
    sheetsOut[sheet.name] = webp.slice(webp.indexOf(",") + 1);
  }
  return sheetsOut;
}`;

async function main() {
  const stop = await devServer();
  try {
    const sources = {};
    const crops = {};
    for (const [name, shoot] of Object.entries(SOURCES)) {
      const { png, keep } = await openPage({ width: 1440, height: 900, scale: SCALE }, shoot);
      sources[name] = `data:image/png;base64,${png.toString("base64")}`;
      crops[name] = keep;
      console.log(`captured ${name} ${JSON.stringify(keep)}`);
    }
    const sheets = SHEETS.map((sheet) => ({
      ...sheet,
      columns: sheet.columns.map((column) => ({
        ...column,
        panels: column.panels.map(([source, part]) => [source, part ? crops[source][part] : crops[source]]),
      })),
    }));
    const images = await openPage({ width: 1600, height: 1000 }, async (page) => {
      await page.navigate("about:blank");
      // One image per message: together they are more than a message should carry.
      for (const name of Object.keys(sources))
        await page.evaluate(`window.sources ??= {}; window.sources[${JSON.stringify(name)}] = ${JSON.stringify(sources[name])}; true`);
      return page.evaluate(`(${COMPOSE})(${JSON.stringify(sheets)}, window.sources)`);
    });
    for (const [name, webp] of Object.entries(images)) {
      writeFileSync(`${README}${name}.webp`, Buffer.from(webp, "base64"));
      console.log(`wrote assets/readme/${name}.webp`);
    }
  } finally {
    stop();
  }
}

await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
