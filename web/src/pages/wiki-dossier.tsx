// The dossier: everything the Wiki knows about one model, in the order a
// person asks: what is it, what does it cost, how good is it, when to use
// it, where to get it, and where the facts come from.

import { Alert, Button, Skeleton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconClock,
  IconExternalLink,
  IconRefresh,
  IconSparkles,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type LiveCatalogModel } from "../api";
import { benchmarkInfo, benchmarkOrder, type BenchmarkInfo } from "../benchmarks";
import { VendorBadge } from "../components/model-card";
import { ProviderLogo } from "../components/provider-logo";
import { Copyable, EmptyState, RelTime } from "../components/ui";
import { contextWindow, dateLabel, scoreText } from "../format";
import {
  modelSpecs,
  otherScoresOf,
  parsePricing,
  priceText,
  scoresOf,
  sourceHost,
  splitDescription,
  TAG_LABELS,
  type Score,
} from "../model-facts";
import { ensureKnowledge, invalidateKnowledge, useKnowledge } from "../model-knowledge";
import { safeHttpUrl } from "../model-key";
import type { WikiGroup, WikiModel } from "../wiki-catalog";

function tokens(count: number | null): string | null {
  return count ? contextWindow(count) : null;
}

/// The listing to ask the researcher about: a plain id before a ":free"
/// route, a route before a rolling "~…" alias.
function plainest(entries: LiveCatalogModel[]): LiveCatalogModel {
  const rank = (entry: LiveCatalogModel) =>
    entry.upstream_id.startsWith("~") ? 2 : entry.upstream_id.includes(":") ? 1 : 0;
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.upstream_id.localeCompare(b.upstream_id))[0];
}

export function ModelDossier({
  model,
  places,
  variantKey,
  onVariant,
  onBenchmark,
  onResearched,
}: {
  model: WikiModel;
  /// For each benchmark the model was scored on: its place in the catalog.
  places: Map<string, { place: number; of: number }>;
  /// The listing identity whose card is shown; the model's own by default.
  variantKey: string | null;
  onVariant: (key: string) => void;
  /// Open the leaderboard of one benchmark.
  onBenchmark: (id: string) => void;
  /// A card changed: the directory reads its summaries again.
  onResearched: () => void;
}) {
  const groups = useMemo(() => [model.primary, ...model.variants], [model]);
  const active = groups.find((group) => group.key === (variantKey ?? model.key)) ?? groups[0];
  // Every card of the model is read once, so switching between them is instant.
  useEffect(() => {
    for (const group of groups) ensureKnowledge(group.entries[0].upstream_id);
  }, [groups]);
  return (
    <div className="dossier">
      <Variant
        key={active.key}
        group={active}
        model={model}
        places={places}
        groups={groups}
        onVariant={onVariant}
        onBenchmark={onBenchmark}
        onResearched={onResearched}
      />
    </div>
  );
}

function Variant({
  group,
  model,
  places,
  groups,
  onVariant,
  onBenchmark,
  onResearched,
}: {
  group: WikiGroup;
  model: WikiModel;
  places: Map<string, { place: number; of: number }>;
  groups: WikiGroup[];
  onVariant: (key: string) => void;
  onBenchmark: (id: string) => void;
  onResearched: () => void;
}) {
  const upstreamId = group.entries[0].upstream_id;
  const state = useKnowledge(upstreamId);
  const card = state.data?.card ?? null;
  const { lead, rest } = useMemo(() => splitDescription(card ?? { ratings: [] }), [card]);
  const pricing = useMemo(() => (card ? parsePricing(card) : null), [card]);
  const specs = useMemo(() => (card ? modelSpecs(card) : modelSpecs({ ratings: [] })), [card]);
  const listed = model.context;
  const released = dateLabel(card?.release_date ?? group.card?.release_date);
  const hasReleased = released !== "—";
  const facts: { label: string; value: ReactNode; sub?: ReactNode }[] = [];
  facts.push({
    label: "Price per 1M",
    value:
      pricing && pricing.input !== null && pricing.output !== null
        ? `${priceText(pricing.input, pricing.currency)} → ${priceText(pricing.output, pricing.currency)}`
        : pricing?.free
          ? "Free"
          : "—",
    sub: !pricing
      ? undefined
      : pricing.cachedInput != null
        ? `cached ${priceText(pricing.cachedInput, pricing.currency)}`
        : pricing.free
          ? "in and out"
          : pricing.input === null
            ? pricing.note
            : "in → out",
  });
  facts.push({
    label: "Context",
    value: tokens(Math.max(specs.context ?? 0, listed ?? 0)) ?? "—",
    sub: specs.maxOutput ? `up to ${tokens(specs.maxOutput)} output` : listed ? "largest listing" : undefined,
  });
  const speed = card?.speed;
  if (speed?.output_tokens_per_second != null || speed?.time_to_first_token_seconds != null)
    facts.push({
      label: "Speed",
      value: speed.output_tokens_per_second != null ? `${Math.round(speed.output_tokens_per_second)} tok/s` : "—",
      // A wait of minutes is a confused figure, not a wait anyone measured.
      sub: [
        speed.time_to_first_token_seconds != null &&
          speed.time_to_first_token_seconds < 120 &&
          `${speed.time_to_first_token_seconds} s to first token`,
        speed.source,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  if (specs.license)
    facts.push({
      label: "License",
      value: specs.license,
      sub: specs.openWeights === true ? "open weights" : specs.openWeights === false ? "closed weights" : undefined,
    });
  const takes = specs.input.map((modality) => (modality === "pdf" ? "PDF" : modality));
  if (takes.length)
    facts.push({
      label: "Input",
      value: takes.join(", "),
      sub: [
        specs.toolCalling === true && "tool calling",
        specs.reasoning === "always" ? "always reasons" : specs.reasoning === "optional" ? "reasoning optional" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  if (hasReleased)
    facts.push({
      label: "Released",
      value: released,
      sub: specs.parameters ?? undefined,
    });
  const tags = model.tags.filter((tag) => tag !== "open-weights");
  const scores = useMemo(() => scoresOf(card?.ratings, card?.vendor), [card]);
  // The same test at another effort, or the vendor's figure beside the lab's.
  const extra = useMemo(() => otherScoresOf(card?.ratings, card?.vendor), [card]);
  // Familiar benchmarks first, then the rest by name; within one, the lab
  // number the normalizer already chose.
  const ordered = [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort(
      (a, b) =>
        benchmarkOrder(a.id) - benchmarkOrder(b.id) ||
        a.score.benchmark.label.localeCompare(b.score.benchmark.label),
    );
  const [allScores, setAllScores] = useState(false);
  const shown = allScores ? ordered : ordered.slice(0, 6);
  const uses = card?.use_cases ?? [];

  return (
    <>
      <header className="dossier-head">
        <div className="dossier-title">
          <h2>{card?.canonical_name || group.name}</h2>
          <VendorBadge vendor={card?.vendor ?? group.card?.vendor} />
        </div>
        <p className="dossier-meta">
          {[
            model.providers.length === 1 ? "1 connection" : `${model.providers.length} connections`,
            listed ? `${contextWindow(listed)} context` : null,
            ...model.variants.map((variant) => variant.key),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {lead && <p className="dossier-tagline">{lead}</p>}
        {rest && (
          <details className="disclosure">
            <summary>Full description</summary>
            <p>{rest}</p>
          </details>
        )}
      </header>

      {state.error ? (
        <Alert color="orange" radius="md" title="Research card unavailable">
          {state.error}{" "}
          <Button size="compact-xs" variant="default" onClick={() => ensureKnowledge(upstreamId, true)}>
            Retry
          </Button>
        </Alert>
      ) : !state.data ? (
        <Skeleton height={180} radius="md" />
      ) : !card ? (
        <EmptyState
          icon={<IconSparkles size={19} />}
          title="No research card yet"
          action={<ResearchButton group={group} onResearched={onResearched} />}
        >
          The listings below come from the connections. Research asks the configured model with web
          search, one call.
        </EmptyState>
      ) : (
        <>
          {!state.data.fresh && (
            <div className="dossier-stale" role="status">
              <IconClock /> This card is {Math.max(1, Math.round((Date.now() / 1000 - (state.data.collected_at_unix ?? 0)) / 86_400))}{" "}
              days old. Prices and scores may have moved.
              <ResearchButton group={group} onResearched={onResearched} compact />
            </div>
          )}

          <div className="dossier-facts" data-count={Math.min(facts.length, 6)}>
            {facts.map((fact) => (
              <div className="fact" key={fact.label}>
                <small>{fact.label}</small>
                <b title={typeof fact.value === "string" ? fact.value : undefined}>{fact.value}</b>
                {fact.sub && <span title={typeof fact.sub === "string" ? fact.sub : undefined}>{fact.sub}</span>}
              </div>
            ))}
          </div>

          {(tags.length > 0 || uses.length > 0) && (
            <section className="dossier-section">
              {(tags.length > 0 || uses.length > 0) && <h3>Good for</h3>}
              {tags.length > 0 && (
                <div className="dossier-tags">
                  {tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {TAG_LABELS[tag]}
                    </span>
                  ))}
                </div>
              )}
              {uses.length > 0 && <p className="dossier-uses">{uses.join(" · ")}</p>}
            </section>
          )}

          {ordered.length > 0 && (
            <section className="dossier-section">
              <div className="dossier-section-head">
                <h3>Benchmarks</h3>
                <span>
                  {ordered.length} benchmark{ordered.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="scores">
                {shown.map(({ id, score }) => (
                  <ScoreRow
                    key={id}
                    score={score}
                    others={extra.get(id)}
                    place={places.get(id)}
                    info={benchmarkInfo(id)}
                    onOpen={() => onBenchmark(id)}
                  />
                ))}
              </div>
              {ordered.length > shown.length && (
                <button type="button" className="link-button" onClick={() => setAllScores(true)}>
                  Show {ordered.length - shown.length} more
                </button>
              )}
            </section>
          )}

          {(card.strengths.length > 0 || card.weaknesses.length > 0) && (
            <section className="dossier-section">
              <div className="dossier-columns">
                <div>
                  <h3>Strengths</h3>
                  <ul className="dossier-list">
                    {card.strengths.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3>Watch out</h3>
                  <ul className="dossier-list is-caution">
                    {card.weaknesses.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      <section className="dossier-section">
        <div className="dossier-section-head">
          <h3>Where to get it</h3>
          {groups.length > 1 && (
            <div className="dossier-variants" role="tablist" aria-label="Researched as">
              {groups.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={item.key === group.key}
                  onClick={() => onVariant(item.key)}
                >
                  {item.key}
                </button>
              ))}
            </div>
          )}
        </div>
        <Listings model={model} />
        <p className="dossier-hint">
          Copy an ID and use it with that connection. Context is what each connection lists.
        </p>
      </section>

      {card && state.data && (
        <section className="dossier-section dossier-provenance">
          <div className="dossier-section-head">
            <h3>Sources</h3>
            <span className="dossier-age">
              <RelTime unix={state.data.collected_at_unix} /> by {state.data.generator ?? "the researcher"}
            </span>
          </div>
          {card.sources.length > 0 ? (
            <div className="dossier-sources">
              {card.sources.map((source) => {
                const url = safeHttpUrl(source);
                return url ? (
                  <a key={source} href={url} target="_blank" rel="noreferrer noopener" className="tag is-link">
                    {sourceHost(source)} <IconExternalLink size={11} />
                  </a>
                ) : (
                  <span key={source} className="tag">
                    {source}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="dossier-hint">The card lists no sources.</p>
          )}
          <details className="disclosure">
            <summary>Card details</summary>
            <dl className="dossier-details">
              {card.snapshot && (
                <>
                  <dt>Alias of</dt>
                  <dd>{card.snapshot}</dd>
                </>
              )}
              {card.family_line && (
                <>
                  <dt>Family</dt>
                  <dd>{card.family_line}</dd>
                </>
              )}
              {specs.knowledgeCutoff && (
                <>
                  <dt>Knowledge cutoff</dt>
                  <dd>{dateLabel(`${specs.knowledgeCutoff}-01`)}</dd>
                </>
              )}
              {card.parameters && !hasReleased && (
                <>
                  <dt>Parameters</dt>
                  <dd>{card.parameters}</dd>
                </>
              )}
              {card.pricing_hint && (
                <>
                  <dt>Pricing note</dt>
                  <dd>{card.pricing_hint}</dd>
                </>
              )}
              {card.modality && (
                <>
                  <dt>Modality</dt>
                  <dd>{card.modality}</dd>
                </>
              )}
            </dl>
          </details>
          <ResearchButton group={group} onResearched={onResearched} />
        </section>
      )}
    </>
  );
}

function Listings({ model }: { model: WikiModel }) {
  // Every listing of the model, by connection, whichever card describes it.
  const byConnection = new Map<string, LiveCatalogModel[]>();
  for (const entry of model.entries) {
    const list = byConnection.get(entry.provider_id);
    if (list) list.push(entry);
    else byConnection.set(entry.provider_id, [entry]);
  }
  return (
    <div className="listings">
      {[...byConnection].map(([provider, entries]) => (
        <div className="listing" key={provider}>
          <div className="listing-head">
            <ProviderLogo providerId={provider} size={18} />
            <strong>{provider}</strong>
          </div>
          {entries
            .sort(
              (a, b) =>
                Number(/free/.test(a.upstream_id)) - Number(/free/.test(b.upstream_id)) ||
                a.upstream_id.localeCompare(b.upstream_id),
            )
            .map((entry) => (
              <div className="listing-row" key={entry.upstream_id}>
                <Copyable value={entry.upstream_id} size="xs" block />
                {/free/i.test(entry.upstream_id) && <span className="listing-free">free</span>}
                <span className="listing-context">
                  {entry.context_tokens ? `${contextWindow(entry.context_tokens)} ctx` : "ctx —"}
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function ScoreRow({
  score,
  others,
  place,
  info,
  onOpen,
}: {
  score: Score;
  /// Other readings of the same benchmark that differ in how they were taken.
  others?: Score[];
  place?: { place: number; of: number };
  info: BenchmarkInfo;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="score"
      onClick={onOpen}
      title={`${info.what ? `${info.what} ` : ""}Opens the ranking of every model on ${score.benchmark.label}.`}
    >
      <span className="score-main">
        <span className="score-label">
          {score.benchmark.label}
          {score.benchmark.variant && <em>{score.benchmark.variant}</em>}
        </span>
        <span className="score-bar" aria-hidden>
          <i style={{ width: `${place ? Math.max(8, (100 * (place.of - place.place + 1)) / place.of) : 100}%` }} />
        </span>
      </span>
      <span className="score-value">{scoreText(score.rating.value)}</span>
      <span className="score-meta">
        <span className="source" data-kind={score.benchmark.kind}>
          {score.benchmark.kind === "vendor" ? "vendor" : score.benchmark.source}
        </span>
        {score.rating.as_of && <span>{score.rating.as_of}</span>}
        {place && (
          <span>
            #{place.place} of {place.of}
          </span>
        )}
        {safeHttpUrl(score.rating.url ?? "") && <IconExternalLink size={12} />}
      </span>
      {others && others.length > 0 && (
        <span className="score-others">
          {others.map((other) => {
            // What sets this reading apart: who measured, how, or both.
            const apart = [
              other.benchmark.kind !== score.benchmark.kind
                ? other.benchmark.kind === "vendor"
                  ? "vendor"
                  : other.benchmark.source
                : null,
              other.benchmark.variant,
            ].filter(Boolean);
            return (
              <span key={`${other.rating.source}-${other.rating.as_of}-${other.rating.value}`}>
                {apart.length > 0 ? `${apart.join(" · ")} ` : ""}
                <b>{scoreText(other.rating.value)}</b>
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}

/// Ask the researcher for this model again. Fresh cards ask twice: the call
/// costs a little, and the last one may have been minutes ago.
function ResearchButton({
  group,
  onResearched,
  compact = false,
}: {
  group: WikiGroup;
  onResearched: () => void;
  compact?: boolean;
}) {
  const entry = plainest(group.entries);
  const state = useKnowledge(entry.upstream_id);
  // The card is the same for every listing of the model; read it under this one too.
  useEffect(() => ensureKnowledge(entry.upstream_id), [entry.upstream_id]);
  const fresh = state.data?.fresh === true && !!state.data.card;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const result = await api.collectKnowledge({
        providerId: entry.provider_id,
        upstreamId: entry.upstream_id,
        force: fresh,
      });
      notifications.show({
        message: result.collected ? "Research card updated." : "The card is fresh. Nothing to do.",
      });
      invalidateKnowledge(entry.upstream_id);
      ensureKnowledge(entry.upstream_id, true);
      setConfirm(false);
      onResearched();
    } catch (failure: unknown) {
      notifications.show({
        color: "red",
        message: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="research">
      {confirm ? (
        <>
          <Button size="compact-xs" color="teal" loading={busy} onClick={run} leftSection={<IconRefresh size={13} />}>
            Research again
          </Button>
          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setConfirm(false)}>
            Keep this card
          </Button>
        </>
      ) : (
        <Button
          size={compact ? "compact-xs" : "compact-md"}
          variant={fresh ? "default" : "light"}
          color="teal"
          leftSection={<IconRefresh size={14} />}
          loading={busy}
          onClick={() => (fresh ? setConfirm(true) : run())}
        >
          {state.data?.card ? "Research again" : "Research this model"}
        </Button>
      )}
    </span>
  );
}
