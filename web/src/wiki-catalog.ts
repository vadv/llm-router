// The Wiki's view of the catalog: which listings are one model, what its
// card says, and how models compare. Pure functions over what the core and
// the card index send; the page renders their answers and decides nothing.

import type { LiveCatalogModel, ModelSummary } from "./api";
import { lowerIsBetter } from "./benchmarks.ts";
import {
  canonicalVendor,
  indexEras,
  modelSpecs,
  moreComparable,
  parsePricing,
  scoresOf,
  splitDescription,
  tagsOf,
  type Pricing,
  type Score,
  type Specs,
  type Tag,
} from "./model-facts.ts";

/// Every listing the catalog reports under one key, with the card that
/// describes them.
export type WikiGroup = {
  key: string;
  entries: LiveCatalogModel[];
  providers: string[];
  card: ModelSummary | null;
  name: string;
  vendor: string | null;
  tagline: string;
  /// The largest context any listing promises.
  context: number | null;
  scores: Map<string, Score>;
  pricing: Pricing | null;
  specs: Specs;
  tags: Tag[];
};

export function wikiGroups(rows: LiveCatalogModel[], summaries: ModelSummary[]): WikiGroup[] {
  const cards = new Map(summaries.map((card) => [card.key, card]));
  // Composite indexes are compared within one version, dated from the
  // whole catalog.
  const eras = indexEras(summaries);
  const byKey = new Map<string, LiveCatalogModel[]>();
  for (const row of rows) {
    const list = byKey.get(row.knowledge_key);
    if (list) list.push(row);
    else byKey.set(row.knowledge_key, [row]);
  }
  const groups: WikiGroup[] = [...byKey].map(([key, entries]) => {
    const card = cards.get(key) ?? null;
    const vendor = canonicalVendor(card?.vendor);
    const contexts = entries.flatMap((entry) => (entry.context_tokens ? [entry.context_tokens] : []));
    return {
      key,
      entries,
      providers: [...new Set(entries.map((entry) => entry.provider_id))].sort(),
      card,
      name: card?.canonical_name?.trim() || key,
      vendor,
      tagline: card ? splitDescription(card).lead : "",
      context: contexts.length ? Math.max(...contexts) : null,
      scores: scoresOf(card?.ratings, card?.vendor, eras),
      pricing: card ? parsePricing(card) : null,
      specs: card ? modelSpecs(card) : modelSpecs({ ratings: [] }),
      tags: card ? tagsOf(card, card.primary_use) : [],
    };
  });
  return groups.sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.key.localeCompare(b.key),
  );
}

/// A model as the directory lists it: its listings, the card that describes
/// it, and the other listing identities the researcher called the same model.
export type WikiModel = WikiGroup & {
  /// The listing identity that describes the model, before merging.
  primary: WikiGroup;
  variants: WikiGroup[];
  /// Which card each score was read from.
  origins: Map<string, WikiGroup>;
};

/// The researcher's name for a model, as one word with its vendor: two keys
/// are one model when both read the same here.
function modelKey(name: string | null | undefined, vendor: string | null): string | null {
  const clean = name?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  return clean ? `${vendor ?? "?"}:${clean}` : null;
}

export function wikiModels(groups: WikiGroup[]): WikiModel[] {
  const buckets = new Map<string, WikiGroup[]>();
  const models: WikiModel[] = [];
  for (const group of groups) {
    // Only a researched name folds: an unresearched key is just a key.
    const key = modelKey(group.card?.canonical_name, group.vendor);
    if (!key) {
      models.push({ ...group, primary: group, variants: [], origins: new Map() });
      continue;
    }
    buckets.set(key, [...(buckets.get(key) ?? []), group]);
  }
  for (const bucket of buckets.values()) {
    // The listing with the most connections describes the model; a rolling
    // alias ("gpt-5.1-latest") next to the model it points at becomes a variant.
    bucket.sort((a, b) => b.entries.length - a.entries.length || a.key.localeCompare(b.key));
    const [primary, ...variants] = bucket;
    const all = [primary, ...variants];
    const scores = new Map(primary.scores);
    const origins = new Map<string, WikiGroup>();
    for (const id of scores.keys()) origins.set(id, primary);
    // A variant's card may hold the better reading of a benchmark the
    // primary already scores: the one without an effort setting, from the
    // more independent source. Ties stay with the primary.
    for (const variant of variants)
      for (const [id, score] of variant.scores) {
        const current = scores.get(id);
        if (!current || moreComparable(score, current)) {
          scores.set(id, score);
          origins.set(id, variant);
        }
      }
    const contexts = all.map((group) => group.context).filter((context): context is number => context !== null);
    models.push({
      ...primary,
      entries: all.flatMap((group) => group.entries),
      providers: [...new Set(all.flatMap((group) => group.providers))].sort(),
      context: contexts.length ? Math.max(...contexts) : null,
      scores,
      origins,
      primary,
      variants,
      tags: primary.tags.length ? primary.tags : (variants.find((group) => group.tags.length)?.tags ?? []),
    });
  }
  models.sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.key.localeCompare(b.key),
  );
  // Nearly every model is "coding, agents, reasoning": those tags say
  // little. The rare ones come first, since they are what sets a model apart.
  const common = new Map<Tag, number>();
  for (const model of models) for (const tag of model.tags) common.set(tag, (common.get(tag) ?? 0) + 1);
  for (const model of models)
    model.tags = [...model.tags].sort((a, b) => (common.get(a) ?? 0) - (common.get(b) ?? 0));
  return models;
}

// ---- Comparing ----

export type BenchmarkOption = {
  id: string;
  label: string;
  /// The family without its version, so versions of one index sort together.
  base: string;
  /// The newest month any included score is dated.
  latest: string;
  /// Models with a score in this family.
  count: number;
  /// …of which scored by an independent lab.
  lab: number;
  lowerIsBetter: boolean;
};

/// One option per benchmark family, most-covered first. A family only one
/// model was scored on cannot rank anything, so the page hides those.
export function benchmarks(models: WikiModel[]): BenchmarkOption[] {
  const found = new Map<string, BenchmarkOption>();
  for (const model of models)
    for (const [id, score] of model.scores) {
      const option =
        found.get(id) ??
        {
          id,
          label: score.benchmark.label,
          base: id.replace(/ (?:v\d+|before v\d+)$/, ""),
          latest: "",
          count: 0,
          lab: 0,
          lowerIsBetter: lowerIsBetter(id),
        };
      option.count++;
      if (score.benchmark.kind === "lab") option.lab++;
      if ((score.rating.as_of ?? "") > option.latest) option.latest = score.rating.as_of ?? "";
      found.set(id, option);
    }
  return [...found.values()].sort(
    (a, b) => b.count - a.count || b.lab - a.lab || a.label.localeCompare(b.label),
  );
}

export const comparable = (option: BenchmarkOption) => option.count >= 2;

// A composite quality score ranks models better than any single test does,
// so it is what the directory opens on.
const PREFERRED = ["intelligence index", "gpqa diamond", "swe-bench verified", "coding index"];

export function defaultBenchmark(options: BenchmarkOption[]): BenchmarkOption | undefined {
  // Enough models to be a ranking, and the newest version of the index.
  const rankable = (option: BenchmarkOption) => option.count >= 5;
  for (const base of PREFERRED) {
    const hits = options.filter((option) => option.base === base && rankable(option));
    if (hits.length) return hits.sort((a, b) => b.latest.localeCompare(a.latest))[0];
  }
  return options.filter((option) => option.count >= 5).sort((a, b) => b.latest.localeCompare(a.latest))[0] ?? options.find(comparable) ?? options[0];
}

export type LeaderRow = { model: WikiModel; score: Score };

/// Every model scored on one benchmark, best first.
export function leaderboard(models: WikiModel[], benchmark: string, independentOnly: boolean): LeaderRow[] {
  const flip = lowerIsBetter(benchmark);
  return models
    .flatMap((model) => {
      const score = model.scores.get(benchmark);
      if (!score || (independentOnly && score.benchmark.kind !== "lab")) return [];
      return [{ model, score }];
    })
    .sort(
      (a, b) =>
        (flip
          ? a.score.rating.value - b.score.rating.value
          : b.score.rating.value - a.score.rating.value) ||
        a.model.name.localeCompare(b.model.name, undefined, { numeric: true }),
    );
}

// ---- Filtering and ordering ----

export type WikiSort =
  | "score"
  | "score-asc"
  | "name"
  | "context"
  | "connections"
  | "release"
  | "price"
  | "speed";

export type ResearchFilter = "all" | "cards" | "missing";

export type WikiFilters = {
  query?: string | null;
  connection?: string | null;
  vendor?: string | null;
  tag?: Tag | null;
  research?: ResearchFilter | null;
};

export type WikiResult = {
  rows: WikiModel[];
  /// For a score order: the place of each scored model, from 1.
  places: Map<string, number>;
  /// How many of the rows carry the value they are ordered by.
  measured: number;
};

export function wikiResults(
  models: WikiModel[],
  filters: WikiFilters,
  sort: WikiSort,
  benchmark: string | null,
): WikiResult {
  const words = (filters.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows = models.filter((model) => {
    const text = [
      model.name,
      model.key,
      model.vendor,
      model.tagline,
      ...model.tags,
      ...model.providers,
      ...model.variants.map((variant) => variant.key),
      ...model.entries.map((entry) => entry.upstream_id),
    ]
      .join(" ")
      .toLowerCase();
    const researched = !!model.card || model.variants.some((variant) => variant.card);
    return (
      words.every((word) => text.includes(word)) &&
      (!filters.connection || model.providers.includes(filters.connection)) &&
      (!filters.vendor || model.vendor === filters.vendor) &&
      (!filters.tag || model.tags.includes(filters.tag)) &&
      (filters.research !== "cards" || researched) &&
      (filters.research !== "missing" || !researched)
    );
  });
  const value = (model: WikiModel): number | null => {
    switch (sort) {
      case "context":
        return model.context;
      case "connections":
        return model.providers.length;
      case "release": {
        const date = model.card?.release_date;
        if (!date) return null;
        const at = Date.parse(date.length === 7 ? `${date}-01` : date);
        return Number.isNaN(at) ? null : at;
      }
      case "price":
        return model.pricing ? (model.pricing.input ?? 0) + (model.pricing.output ?? 0) : null;
      case "speed":
        return model.card?.speed?.output_tokens_per_second ?? null;
      default:
        return benchmark ? (model.scores.get(benchmark)?.rating.value ?? null) : null;
    }
  };
  const flip = benchmark ? lowerIsBetter(benchmark) : false;
  const descending =
    sort === "score"
      ? !flip
      : sort === "score-asc"
        ? flip
        : sort !== "name" && sort !== "price";
  const byName = (a: WikiModel, b: WikiModel) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }) || a.key.localeCompare(b.key);
  rows.sort((a, b) => {
    if (sort === "name") return byName(a, b);
    const x = value(a);
    const y = value(b);
    // What is not known sorts last, whichever way the column goes.
    if (x === null || y === null)
      return Number(x === null) - Number(y === null) || byName(a, b);
    return (descending ? y - x : x - y) || byName(a, b);
  });
  const places = new Map<string, number>();
  const measured = rows.filter((model) => value(model) !== null).length;
  if (sort === "score" || sort === "score-asc")
    rows.forEach((model, index) => {
      if (value(model) !== null) places.set(model.key, index + 1);
    });
  return { rows, places, measured };
}

export type Counted = { value: string; label: string; count: number };

export function vendorOptions(models: WikiModel[]): Counted[] {
  return count(models.map((model) => model.vendor).filter((vendor): vendor is string => !!vendor));
}

export function connectionOptions(models: WikiModel[]): Counted[] {
  return count(models.flatMap((model) => model.providers));
}

export function tagOptions(models: WikiModel[]): Counted[] {
  return count(models.flatMap((model) => model.tags));
}

function count(values: string[]): Counted[] {
  const totals = new Map<string, number>();
  for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1);
  return [...totals]
    .map(([value, number]) => ({ value, label: value, count: number }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/// The address of a model's dossier. Any listing id works: the page finds
/// the model behind it.
export function wikiLink(upstreamId: string): string {
  return `#/wiki?model=${encodeURIComponent(upstreamId)}`;
}

/// Where a link into the Wiki points: a catalog key, a key of a spelling
/// family, or an upstream id.
export function findModel(models: WikiModel[], target: string | null | undefined): WikiModel | null {
  if (!target) return null;
  const needle = target.toLowerCase();
  const fold = (key: string) => key.replace(/-/g, "");
  return (
    models.find((model) => model.key === target) ??
    models.find((model) => model.variants.some((variant) => variant.key === target)) ??
    models.find((model) =>
      model.entries.some((entry) => entry.upstream_id.toLowerCase() === needle),
    ) ??
    models.find((model) => fold(model.key) === fold(needle)) ??
    models.find((model) => model.variants.some((variant) => fold(variant.key) === fold(needle))) ??
    null
  );
}
