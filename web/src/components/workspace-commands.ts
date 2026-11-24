import type { Route } from "../hooks";

export const sections: Record<Route, string> = {
  overview: "Monitor",
  usage: "Monitor",
  balances: "Monitor",
  providers: "Routing",
  pools: "Routing",
  history: "Diagnostics",
  activity: "Diagnostics",
  wiki: "Reference",
  chat: "Workspace",
};

/// Tasks the command menu can do. A target that is not a `#/…` link names
/// an action the shell performs itself.
export type CommandAction =
  | "system"
  | "connection"
  | "copy-api"
  | "theme"
  | "refresh-balances"
  | "refresh-catalog";

export const shortcuts: { label: string; target: string; detail: string; keywords: string }[] =
  [
    {
      label: "Investigate failed requests",
      target: "#/history?period=24h&outcome=error",
      detail: "Requests · last 24 hours",
      keywords: "errors failures troubleshooting",
    },
    {
      label: "Inspect recent traffic",
      target: "#/history?period=1h",
      detail: "Requests · last hour",
      keywords: "volume frequency spikes activity calls",
    },
    {
      label: "Check system health",
      target: "system",
      detail: "Core checks & refresh settings",
      keywords: "polling interval cadence pause uptime monitor",
    },
    {
      label: "Find the client API URL",
      target: "connection",
      detail: "Endpoint & browser session",
      keywords: "copy base endpoint key credential logout forget",
    },
    {
      label: "Copy API base URL",
      target: "copy-api",
      detail: "The endpoint clients are configured with",
      keywords: "copy base url endpoint v1 base_url openai client",
    },
    {
      label: "Switch light or dark theme",
      target: "theme",
      detail: "Appearance of this browser",
      keywords: "appearance light dark mode color scheme",
    },
    {
      label: "Refresh balances",
      target: "refresh-balances",
      detail: "Ask the core to poll every connection",
      keywords: "balances quota credits poll update",
    },
    {
      label: "Refresh model catalogs",
      target: "refresh-catalog",
      detail: "Ask the core to re-list every connection",
      keywords: "catalog models list update providers",
    },
  ];

export function isAction(target: string): target is CommandAction {
  return !target.startsWith("#");
}

export function findCommands(
  nav: readonly { route: Route; label: string }[],
  query: string,
) {
  const pages = nav.map(({ route, label }) => ({
    label,
    target: "#/" + route,
    detail: sections[route],
    keywords: route,
  }));
  const term = query.toLowerCase().trim();
  const words = term.split(/\s+/);
  const matches = [...shortcuts, ...pages].filter(
    ({ label, detail, keywords }) =>
      words.every((word) =>
        (label + " " + detail + " " + keywords).toLowerCase().includes(word),
      ),
  );
  // A page name should open that page, not a narrower preset with a similar name.
  const rank = (label: string) =>
    label.toLowerCase() === term
      ? 0
      : label.toLowerCase().startsWith(term)
        ? 1
        : 2;
  return term ? matches.sort((a, b) => rank(a.label) - rank(b.label)) : matches;
}
