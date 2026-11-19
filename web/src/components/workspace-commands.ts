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
export const shortcuts = [
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
];

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
