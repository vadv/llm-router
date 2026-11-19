import type { KnowledgeRating, LiveCatalogModel, ModelSummary } from "./api";
import { groupByKnowledgeKey } from "./model-key.ts";

export type WikiGroup = ReturnType<typeof wikiGroups>[number];
export type WikiSort =
  "high" | "low" | "name" | "context" | "providers" | "release";
export function wikiGroups(
  rows: LiveCatalogModel[],
  summaries: ModelSummary[],
) {
  const cards = new Map(summaries.map((c) => [c.key, c]));
  return Array.from(groupByKnowledgeKey(rows), ([key, entries]) => {
    const card = cards.get(key);
    const providers = [...new Set(entries.map((r) => r.provider_id))].sort();
    const contexts = entries.flatMap((e) =>
      e.context_tokens === null ? [] : [e.context_tokens],
    );
    const scores = new Map<string, KnowledgeRating>();
    // Use the latest dated measurement. Do not choose a winner from conflicting values on the same date.
    const conflicts = new Set<string>();
    for (const r of card?.ratings ?? []) {
      if (
        !r.source?.trim() ||
        !r.metric?.trim() ||
        r.metric === "value" ||
        !Number.isFinite(r.value)
      )
        continue;
      const id = JSON.stringify([r.source.trim(), r.metric.trim()]);
      const old = scores.get(id);
      if (!old || (r.as_of ?? "") > (old.as_of ?? "")) {
        scores.set(id, r);
        conflicts.delete(id);
      } else if (r.as_of === old.as_of && r.value !== old.value)
        conflicts.add(id);
    }
    for (const id of conflicts) scores.delete(id);
    return {
      key,
      entries,
      providers,
      card,
      name: card?.canonical_name || key,
      scores,
      context: contexts.length ? Math.max(...contexts) : null,
    };
  });
}
export function benchmarks(groups: WikiGroup[]) {
  const found = new Map<
    string,
    { value: string; label: string; count: number }
  >();
  for (const g of groups)
    for (const [id, r] of g.scores) {
      const option = found.get(id);
      if (option) option.count++;
      else
        found.set(id, {
          value: id,
          label: `${r.metric} · ${r.source}`,
          count: 1,
        });
    }
  return [...found.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}
export function wikiResults(
  groups: WikiGroup[],
  query: string,
  provider: string | null,
  vendor: string | null,
  scope: string,
  sort: WikiSort,
  benchmark: string | null,
) {
  const q = query.trim().toLowerCase();
  const rows = groups.filter(
    (g) =>
      (!provider || g.providers.includes(provider)) &&
      (!vendor || g.card?.vendor === vendor) &&
      (scope !== "cards" || g.card) &&
      (scope !== "missing" || !g.card) &&
      (!q ||
        [
          g.key,
          g.name,
          g.card?.vendor,
          g.card?.description,
          ...g.providers,
          ...g.entries.map((e) => e.upstream_id),
        ].some((s) => s?.toLowerCase().includes(q))),
  );
  const value = (g: WikiGroup) =>
    sort === "context"
      ? g.context
      : sort === "providers"
        ? g.providers.length
        : g.scores.get(benchmark ?? "")?.value;
  return rows.sort((a, b) => {
    const tie = a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
    if (sort === "name") return tie;
    if (sort === "release")
      return (
        (b.card?.release_date ?? "").localeCompare(
          a.card?.release_date ?? "",
        ) || tie
      );
    const x = value(a),
      y = value(b);
    return x == null || y == null
      ? Number(x == null) - Number(y == null) || tie
      : (sort === "low" ? x - y : y - x) || tie;
  });
}
