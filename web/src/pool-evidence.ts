import type { KnowledgeRating, LiveCatalogModel, ModelSummary } from "./api";
import { benchmarks, wikiGroups } from "./wiki-catalog.ts";

export type EvidenceGoal = "design" | "vision";
export type CandidateEvidence = {
  imageInput: boolean;
  task: string | null;
  result?: KnowledgeRating;
};

// Accept explicit image input, never image generation or unspecified multimodality.
export function documentsImageInput(modality: string | null | undefined) {
  const text = modality?.toLowerCase() ?? "";
  return text.split(/[;.]/).some((clause) => {
    const source = clause.split(/→|->|,\s*(?:[\w +/&-]+\s+)?outputs?\b/)[0];
    if (
      /\b(?:no|not|without|unsupported|output|generation|generates?|generated)\b/.test(
        source,
      )
    )
      return false;
    const imageList =
      /\bimages?\b[\s,+/&]*(?:(?:and|or|text|video|audio)\b[\s,+/&]*)*inputs?\b/.test(
        source,
      );
    const inputList =
      /\binputs?(?: modalities)?\s*[:(]\s*(?:(?:text|video|audio|and|or)\b|[,+/&\s])*images?\b/.test(
        source,
      );
    return (
      imageList ||
      inputList ||
      (/(?:→|->)/.test(clause) && /\bimages?\b/.test(source))
    );
  });
}

function relevantMetric(goal: EvidenceGoal, metric: string) {
  // Ranking is descending. Do not mix rank, error or latency with higher-is-better scores.
  if (/rank|error|latency|cost|\btime\b|lower|\bloss\b/i.test(metric))
    return false;
  return goal === "design"
    ? /\b(?:web[ -]?dev|design2code|frontend[ -]?bench)\b/i.test(metric) &&
        /elo|score|accuracy|similarity|win rate|pass@/i.test(metric)
    : /\b(?:screen[ -]?spot|screenqa|visualwebbench)\b/i.test(metric) &&
        /accuracy|score|success|grounding|%/i.test(metric);
}

export function poolEvidence(
  rows: LiveCatalogModel[],
  cards: ModelSummary[],
  goal: EvidenceGoal,
  requested: string,
) {
  const groups = wikiGroups(rows, cards);
  const options = benchmarks(groups).filter((o) =>
    relevantMetric(goal, JSON.parse(o.value)[1]),
  );
  const metric = options.find((o) => o.value === requested) ?? options[0];
  const byKey = new Map<string, CandidateEvidence>();
  for (const g of groups) {
    const fields = [g.card?.primary_use, g.card?.description];
    const taskPattern =
      goal === "design"
        ? /\b(?:front[ -]?end|user interfaces?|UI|UX|web design|web development|design.to.code|CSS|web interfaces?)\b/i
        : /\b(?:screenshots?|screen understanding|GUI grounding|user interface grounding)\b/i;
    const mentioned = fields.some((t) =>
      t
        ?.split(/[.!?;]/)
        .some(
          (sentence) =>
            taskPattern.test(sentence) &&
            !/\b(?:not|without|weak|poor|lacks?|limited)\b/i.test(sentence),
        ),
    );
    byKey.set(g.key, {
      imageInput: documentsImageInput(g.card?.modality),
      task: mentioned
        ? goal === "design"
          ? "UI work mentioned in Wiki"
          : "Screen tasks mentioned in Wiki"
        : null,
      result: metric ? g.scores.get(metric.value) : undefined,
    });
  }
  return { options, metric, byKey };
}
