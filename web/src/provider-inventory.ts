import type { LiveCatalogModel, LocalState, ModelSummary } from "./api";

// A label belongs to this upstream ID, not to every alias of its Wiki card.
export function freeLabel(id: string) {
  const name = id.split("/").at(-1) ?? "";
  return /(?:^|[:-])free$/i.test(name);
}

export function idleSlots(local: LocalState) {
  const { slots, busy } = local;
  return slots !== null &&
    busy !== null &&
    Number.isSafeInteger(slots) &&
    Number.isSafeInteger(busy) &&
    slots >= busy &&
    busy >= 0
    ? slots - busy
    : null;
}

const idHints: [RegExp, string][] = [
  [/(?:^|[-_.:])(?:coder?|coding|codex)(?=$|[-_.:])/i, "Coding"],
  [/(?:^|[-_.:])(?:reasoner|reasoning|thinking|r1)(?=$|[-_.:])/i, "Reasoning"],
  [/(?:^|[-_.:])(?:vision|vl)(?=$|[-_.:])/i, "Vision"],
  [/(?:^|[-_.:])(?:embedding|embed)(?=$|[-_.:])/i, "Embeddings"],
  [/(?:^|[-_.:])chat(?=$|[-_.:])/i, "Chat"],
];

export function modelBrief(row: LiveCatalogModel, card?: ModelSummary) {
  const use = card?.primary_use?.trim() || card?.description?.trim();
  if (use) return { text: use, source: "Model Wiki" };
  const name = row.upstream_id.split("/").at(-1) ?? "";
  const tags = idHints
    .filter(([re]) => re.test(name))
    .map(([, label]) => label);
  return tags.length
    ? { text: tags.join(" · "), source: "ID hint" }
    : { text: "No documented use case", source: "" };
}

export function inventoryRows(
  rows: LiveCatalogModel[],
  cards: Map<string, ModelSummary>,
  query: string,
  free: boolean,
  sort: string,
) {
  const words = query.trim().toLowerCase().split(/\s+/);
  return rows
    .flatMap((row) => {
      const labeled = freeLabel(row.upstream_id);
      if (free && !labeled) return [];
      const card = cards.get(row.knowledge_key),
        brief = modelBrief(row, card);
      const name = card?.canonical_name?.trim() || row.upstream_id;
      const text = [
        name,
        row.upstream_id,
        card?.vendor,
        card?.description,
        brief.text,
      ]
        .join(" ")
        .toLowerCase();
      return words.every((w) => text.includes(w))
        ? [{ row, name, brief, labeled }]
        : [];
    })
    .sort(
      (a, b) =>
        (sort === "context"
          ? (b.row.context_tokens ?? -1) - (a.row.context_tokens ?? -1)
          : sort === "free"
            ? Number(b.labeled) - Number(a.labeled)
            : 0) ||
        a.name.localeCompare(b.name) ||
        a.row.upstream_id.localeCompare(b.row.upstream_id),
    );
}
