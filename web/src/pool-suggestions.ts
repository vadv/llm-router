import type { Ban, LiveCatalogModel, Member, Pool } from "./api";

import type { CandidateEvidence, EvidenceGoal } from "./pool-evidence";

export type Goal = "fit" | "coding" | "reasoning" | "context" | EvidenceGoal;
export const memberKey = (m: Member) =>
  JSON.stringify([m.provider_id, m.upstream_id]);

// Rank saved configuration and catalog facts, not provider quality or traffic.
export function poolSuggestions(
  catalog: LiveCatalogModel[],
  pools: Pool[],
  members: Member[],
  reference: string,
  goal: Goal,
  query: string,
  connection: string,
  bans: Ban[],
  now: number,
  evidence?: Map<string, CandidateEvidence>,
  needsImage = goal === "vision",
) {
  const selected = new Set(members.map(memberKey));
  const connections = new Set(members.map((m) => m.provider_id));
  const primary =
    members[0] && catalog.find((m) => memberKey(m) === memberKey(members[0]));
  const banned = new Set(
    bans.filter((b) => b.expires_at_unix > now).map(memberKey),
  );
  const uses = new Map<string, string[]>();
  const neighbors = new Set<string>();
  for (const pool of pools) {
    if (pool.members.some((m) => selected.has(memberKey(m))))
      neighbors.add(pool.name);
    for (const m of pool.members) {
      const key = memberKey(m),
        names = uses.get(key);
      if (names) names.push(pool.name);
      else uses.set(key, [pool.name]);
    }
  }
  const pattern =
    goal === "coding"
      ? /(?:^|[^a-z])(?:cod(?:e|er|ing)|codex)(?:$|[^a-z])/i
      : goal === "reasoning"
        ? /(?:^|[^a-z])(?:reason(?:er|ing)|thinking|r1)(?:$|[^a-z])/i
        : null;
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return catalog
    .flatMap((model) => {
      const key = memberKey(model);
      if (selected.has(key) || (connection && model.provider_id !== connection))
        return [];
      const text =
        `${model.provider_id} ${model.upstream_id} ${model.knowledge_key}`.toLowerCase();
      if (!terms.every((t) => text.includes(t))) return [];
      const names = uses.get(key) ?? [],
        peer = names.find((n) => neighbors.has(n));
      const related = reference !== "" && names.includes(reference);
      const same =
        !!primary &&
        primary.knowledge_key === model.knowledge_key &&
        primary.provider_id !== model.provider_id;
      const fresh = members.length > 0 && !connections.has(model.provider_id);
      const tagged = pattern?.test(model.upstream_id),
        taskPool = pattern && names.find((n) => pattern.test(n));
      const context = model.context_tokens ?? -1;
      const detail = evidence?.get(model.knowledge_key);
      const reasons: string[] = [];
      if (needsImage)
        reasons.push(
          detail?.imageInput
            ? "Image input documented in Wiki"
            : "Image input unverified",
        );
      if (detail?.task) reasons.push(detail.task);
      if (goal === "design" && !detail?.task && !detail?.result && evidence)
        reasons.push("No direct UI evidence in saved briefs");
      if (same) reasons.push("Primary model on another connection");
      if (related) reasons.push(`In your ${reference} pool`);
      if (tagged)
        reasons.push(
          `${goal === "coding" ? "Coding" : "Reasoning"} tag in model ID`,
        );
      else if (taskPool && taskPool !== reference)
        reasons.push(`Used in ${taskPool}`);
      if (peer && peer !== reference && peer !== taskPool)
        reasons.push(`Paired in ${peer}`);
      if (fresh && !same) reasons.push("New connection for this route");
      if (!reasons.length)
        reasons.push(
          names.length === 1
            ? `In your ${names[0]} pool`
            : names.length
              ? `In ${names.length} of your pools`
              : "Listed in the catalog",
        );
      const rank = [
        Number(!banned.has(key)),
        Number(needsImage && !!detail?.imageInput),
        Number(!!detail?.result),
        detail?.result?.rating.value ?? 0,
        Number(!!detail?.task),
        goal === "context" ? context : Number(Boolean(tagged || taskPool)),
        Number(same),
        Number(related),
        Number(!!peer),
        Number(fresh),
        names.length,
      ];
      return [
        {
          model,
          reasons,
          rank,
          result: detail?.result,
          banned: banned.has(key),
        },
      ];
    })
    .sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++)
        if (a.rank[i] !== b.rank[i]) return b.rank[i] - a.rank[i];
      return (
        a.model.upstream_id.localeCompare(b.model.upstream_id) ||
        a.model.provider_id.localeCompare(b.model.provider_id)
      );
    });
}
