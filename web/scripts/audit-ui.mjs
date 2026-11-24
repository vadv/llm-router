#!/usr/bin/env node
// Audit the pages of the UI for what a person notices without looking for
// it: a link left in the browser's default look, a control in the browser's
// default font, a clickable thing without a pointer, a field to type in
// without a text cursor, a disabled thing that still shows a pointer.
// Runs against the in-memory mock by default, so it needs no core and no
// credentials; with ROUTER_KEY in the environment and a live base URL the
// same scenarios run against a real router. The key reaches the page through
// localStorage inside a throwaway browser profile that is deleted when the
// run ends, and is never printed.
//
// A scenario is a route plus the steps that lead to a state worth auditing:
// opening a drawer, a menu or the command menu. The steps are those of
// ./headless-ui.mjs. A scenario whose step finds nothing counts as a finding:
// that state was never audited.
//
// Usage: node scripts/audit-ui.mjs [base-url] [scenarios-file] [width]
// Without a scenarios file the built-in list for the width is used; it names
// models of the mock catalog, so a live router needs a file of its own. One
// scenario per line, a step after "::":
//   wiki?model=glm-4-6 :: click .dossier-variants [role="tab"]:last-child
// Exit status is 1 when there is anything to look at.

import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { openPage } from "./headless-ui.mjs";

const BASE = process.argv[2] ?? "http://localhost:5199";
const KEY = process.env.ROUTER_KEY ?? "";
const QUERY = KEY ? "" : "mock=1&";
const WIDTH = Number(process.argv[4] ?? 1440);
// A phone shows other controls (a Filters button, a collapsed filter form).
const PHONE = WIDTH < 500;

// The states worth auditing, named after the mock's catalog. The phone list
// adds the controls a narrow screen has instead.
const DESKTOP_SCENARIOS = [
  "overview",
  "overview :: key k meta",
  "usage",
  'balances :: click button[aria-label^="History for"]',
  "limits",
  "limits :: click .limit-row-toggle",
  'providers :: clickjs [...document.querySelectorAll("button, a")].find((el) => /^openrouter/.test(el.textContent.trim()))',
  "pools :: hover .model-hover-target",
  'pools :: clickjs [...document.querySelectorAll("button, a")].find((el) => el.textContent.trim() === "New pool")',
  "history :: click .request-open",
  "activity",
  'wiki :: click button[aria-haspopup="menu"]',
  "wiki?model=glm-4-6",
  'wiki?model=kimi-latest :: click .dossier-variants [role="tab"]:first-child',
  "wiki?view=leaderboard",
  "wiki?job=running",
  "chat",
  "chat :: key k meta",
  "chat :: click .thread-starters button",
  "chat :: click .thread-pool",
  "chat :: click .thread-effort",
];
const PHONE_SCENARIOS = [
  "overview",
  "overview :: key k meta",
  "usage",
  'balances :: click button[aria-label^="History for"]',
  "limits",
  "limits :: click .limit-row-toggle",
  'pools :: clickjs [...document.querySelectorAll("button, a")].find((el) => el.textContent.trim() === "New pool")',
  "history :: click .diag-filters-toggle",
  "history :: click .request-open",
  "activity",
  "wiki",
  'wiki :: click button[aria-haspopup="menu"]',
  'wiki :: clickjs [...document.querySelectorAll("button")].find((el) => /^Filters/.test(el.textContent.trim()))',
  "wiki?model=glm-4-6",
  "wiki?view=leaderboard",
  "chat",
  "chat :: click .thread-starters button",
  "chat :: click .thread-pool",
];

const given = process.argv[3];
// A file of scenarios, or the scenarios themselves, or the list for the width.
const listing =
  (existsSync(given) ? readFileSync(given, "utf8") : given) ||
  (PHONE ? PHONE_SCENARIOS : DESKTOP_SCENARIOS).join("\n");
const scenarios = listing
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("//"))
  .map((line) => {
    const [route, ...steps] = line.split("::");
    return { route: route.trim(), steps: steps.map((step) => step.trim()).filter(Boolean) };
  });

// What the page answers about itself.
const AUDIT = `(() => {
  const describe = (el) => {
    const path = [];
    for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      const cls = node.className?.toString?.().split(" ").filter(Boolean).slice(0, 2).join(".");
      path.push(node.tagName.toLowerCase() + (cls ? "." + cls : ""));
    }
    const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "")
      .replace(/\\s+/g, " ").slice(0, 50);
    return path.join("<") + " :: " + text;
  };
  const visible = (el) => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  const links = [...document.querySelectorAll("a[href]")].filter(visible).filter((a) => {
    const style = getComputedStyle(a);
    return style.textDecorationLine.includes("underline") || style.color === "rgb(0, 0, 238)";
  }).map(describe);
  const fonts = [...document.querySelectorAll("button, input, select, textarea")].filter(visible).filter((el) => {
    const family = getComputedStyle(el).fontFamily.toLowerCase();
    return family.includes("times") || (family.includes("serif") && !family.includes("sans"));
  }).map(describe);
  // A field to type in shows the text cursor; a select's field opens a list.
  const typing = (el) => el.tagName === "TEXTAREA" ? !el.readOnly
    : (el.tagName === "INPUT" && !el.readOnly && el.getAttribute("role") !== "combobox"
      && !/^(checkbox|radio|range|button|submit|reset|color|file)$/.test(el.type));
  const off = (el) => el.disabled || el.getAttribute("aria-disabled") === "true"
    || !!el.closest("[disabled], [data-disabled], [inert]")
    || (el.tagName === "LABEL" && !!el.querySelector(":disabled, [data-disabled], [aria-disabled=true]"));
  const clickable = "a[href], button, [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=switch], [role=checkbox], [role=radio], summary, label[for], label:has(input, select, textarea), select, input:not([type=hidden]), [onclick], .model-hover-target, .copy-id, .request-open, .score";
  const cursors = [...document.querySelectorAll(clickable)].filter(visible)
    .map((el) => [el, getComputedStyle(el).cursor])
    .filter(([el, cursor]) => cursor !== (off(el) ? "not-allowed" : typing(el) ? "text" : "pointer"))
    .map(([el]) => describe(el) + " cursor=" + getComputedStyle(el).cursor);
  return JSON.stringify({ links, fonts, cursors });
})()`;

async function run({ route, steps }) {
  const init = KEY ? `localStorage.setItem("llm-router.key", ${JSON.stringify(KEY)});` : "";
  return openPage({ width: WIDTH, mobile: PHONE, init }, async (page) => {
    await page.navigate(`${BASE}/?${QUERY}audit=1#/${route}`);
    await sleep(Number(process.env.AUDIT_WAIT_MS ?? 4500));
    try {
      await page.steps(steps);
    } catch (error) {
      if (error.message.startsWith("no element for: ")) return { missed: error.message };
      throw error;
    }
    return JSON.parse(await page.evaluate(AUDIT));
  });
}

let findings = 0;
for (const { route, steps } of scenarios) {
  const found = await run({ route, steps });
  const label = `${route}${steps.length ? ` after ${steps.join(", ")}` : ""}`;
  if (found.missed) {
    console.log(`== ${label}: ${found.missed}`);
    findings += 1;
    continue;
  }
  const total = found.links.length + found.fonts.length + found.cursors.length;
  findings += total;
  console.log(`== ${label}: ${total === 0 ? "clean" : `${total} to look at`}`);
  for (const [kind, items] of Object.entries(found))
    for (const item of items) console.log(`   ${kind}: ${item}`);
}
console.log(findings === 0 ? "AUDIT CLEAN" : `AUDIT: ${findings} to look at`);
process.exit(findings === 0 ? 0 : 1);
