// The rows of the Wiki: one model in the directory, one scored model in a
// leaderboard. They only lay out what the catalog logic already decided.

import { IconArrowUpRight, IconChevronRight, IconExternalLink } from "@tabler/icons-react";
import { ProviderLabels, VendorBadge } from "../components/model-card";
import { contextWindow, dateLabel, scoreText } from "../format";
import { priceText, type Pricing, type Score } from "../model-facts";
import type { BenchmarkOption, LeaderRow, WikiModel, WikiSort } from "../wiki-catalog";

/// The two list prices of a model, or "Free", or nothing.
export function priceCells(pricing: Pricing | null): { in: string | null; out: string | null } {
  if (!pricing) return { in: null, out: null };
  const text = (value: number | null) => (value === null ? null : priceText(value, pricing.currency));
  if (pricing.free) return { in: "Free", out: null };
  return { in: text(pricing.input), out: text(pricing.output) };
}

/// What the last column of a directory row shows for a sort.
export function metricOf(
  model: WikiModel,
  sort: WikiSort,
  benchmark: BenchmarkOption | null,
): { value: string; caption: string; note?: string } {
  const score = benchmark ? model.scores.get(benchmark.id) : undefined;
  switch (sort) {
    case "connections":
      return { value: `${model.providers.length}`, caption: model.providers.length === 1 ? "connection" : "connections" };
    case "release":
      return { value: dateLabel(model.card?.release_date) ?? "—", caption: "released" };
    case "speed": {
      const speed = model.card?.speed?.output_tokens_per_second;
      return { value: speed ? `${Math.round(speed)}` : "—", caption: "tok/s out" };
    }
    default:
      // A model the benchmark never scored gets a dash that says so on
      // hover. A caption would repeat the absence under every such row.
      return score
        ? { value: scoreText(score.rating.value), caption: benchmark?.label ?? "score" }
        : { value: "—", caption: "", note: benchmark ? `Not scored on ${benchmark.label}` : undefined };
  }
}

export function ModelRow({
  model,
  benchmark,
  place,
  of,
  sort,
}: {
  model: WikiModel;
  benchmark: BenchmarkOption | null;
  /// Place in the ranking, when the row is ordered by score.
  place?: number;
  /// How many rows carry that score.
  of?: number;
  sort: WikiSort;
}) {
  const price = priceCells(model.pricing);
  const metric = metricOf(model, sort, benchmark);
  const researched = !!model.card;
  return (
    <a
      className="wiki-row"
      href={`#/wiki?model=${encodeURIComponent(model.key)}`}
      aria-label={`${model.name}: open the dossier`}
    >
      <span className="wiki-row-main">
        <span className="wiki-row-title">
          <span className="wiki-row-name">{model.name}</span>
          <VendorBadge vendor={model.card?.vendor} />
        </span>
        <span className="wiki-row-tagline" data-muted={!researched || undefined}>
          {researched ? model.tagline : "No research card yet"}
        </span>
      </span>
      <span
        className="wiki-col-price"
        title={model.pricing ? "List price per 1M tokens, input and output" : "No list price on file"}
      >
        <span data-empty={!price.in}>
          <small>in</small>
          {price.in ?? "—"}
        </span>
        <span data-empty={!price.out}>
          <small>out</small>
          {price.out ?? ""}
        </span>
      </span>
      <span className="wiki-col-context" title="Largest context any connection lists">
        {model.context ? contextWindow(model.context) : "—"}
      </span>
      <span className="wiki-col-providers">
        <ProviderLabels providers={model.providers} limit={2} line="one" />
      </span>
      <span className="wiki-col-metric" title={metric.note}>
        <b data-empty={metric.value === "—" || undefined}>{metric.value}</b>
        <small>{place && of ? `#${place} of ${of}` : metric.caption}</small>
      </span>
      <IconChevronRight size={16} className="wiki-row-chevron" aria-hidden />
    </a>
  );
}

/// Every model scored on one benchmark, best first.
export function LeaderboardTable({
  rows,
  benchmark,
  heldBack,
}: {
  rows: LeaderRow[];
  benchmark: BenchmarkOption;
  /// What the switches above hold back, each with the line that offers to
  /// show it. Only the ones holding something are drawn.
  heldBack: { count: number; onShow: () => void; text: (count: number) => string }[];
}) {
  const values = rows.map((row) => row.score.rating.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  // The leader's bar is full; the others show how far behind they are.
  const share = (value: number) =>
    max === min ? 1 : benchmark.lowerIsBetter ? (max - value) / (max - min) : (value - min) / (max - min);
  return (
    <div className="board">
      <div className="board-row board-head" aria-hidden>
        <span className="board-place">#</span>
        <span>Model</span>
        <span>Score</span>
        <span className="board-col-source">Measured by</span>
        <span className="board-col-price">Price / 1M</span>
        <span className="board-col-speed">Speed</span>
        <span />
      </div>
      {rows.map((row, index) => (
        <BoardRow
          key={row.model.key}
          row={row}
          place={index + 1}
          share={share(row.score.rating.value)}
          best={index === 0}
        />
      ))}
      {!rows.length && (
        <p className="board-empty">
          No model passes these filters on {benchmark.label}.
        </p>
      )}
      {heldBack.filter((item) => item.count > 0).map((item) => (
        <button type="button" className="board-hidden" key={item.text(item.count)} onClick={item.onShow}>
          {item.text(item.count)}
          <span>Show {item.count === 1 ? "it" : "them"} anyway</span>
        </button>
      ))}
    </div>
  );
}

function BoardRow({ row, place, share, best }: { row: LeaderRow; place: number; share: number; best: boolean }) {
  const { model, score } = row;
  const price = priceCells(model.pricing);
  const speed = model.card?.speed?.output_tokens_per_second;
  const url = score.rating.url && /^https?:\/\//i.test(score.rating.url) ? score.rating.url : null;
  return (
    <a
      className="board-row"
      href={`#/wiki?model=${encodeURIComponent(model.key)}`}
      aria-label={`${model.name}, ${scoreText(score.rating.value)} on ${score.benchmark.label}: open the dossier`}
    >
      <span className="board-place" data-top={place <= 3 || undefined}>
        {place}
      </span>
      <span className="board-model">
        <span className="board-name">{model.name}</span>
        <VendorBadge vendor={model.card?.vendor} />
        <small className="mono">{model.key}</small>
      </span>
      <span className="board-score">
        <b>{scoreText(score.rating.value)}</b>
        <span className="board-bar" aria-hidden>
          <i style={{ width: `${Math.max(6, 100 * share)}%` }} data-best={best || undefined} />
        </span>
      </span>
      <span className="board-col-source">
        <SourceOf score={score} />
      </span>
      <span className="board-col-price">
        {price.in ?? "—"}
        {price.out ? ` / ${price.out}` : ""}
      </span>
      <span className="board-col-speed">{speed ? `${Math.round(speed)} tok/s` : "—"}</span>
      <span className="board-open" aria-hidden>
        {url ? <IconExternalLink size={14} /> : <IconArrowUpRight size={14} />}
      </span>
    </a>
  );
}

function SourceOf({ score }: { score: Score }) {
  const { benchmark, rating } = score;
  const url = rating.url && /^https?:\/\//i.test(rating.url) ? rating.url : null;
  return (
    <>
      <span
        className="source"
        data-kind={benchmark.kind}
        title={benchmark.kind === "vendor" ? `Reported by the model's vendor: ${benchmark.source}` : undefined}
      >
        {benchmark.kind === "vendor" ? "vendor" : benchmark.source}
      </span>
      <small>
        {[benchmark.variant, rating.as_of].filter(Boolean).join(" · ")}
        {url && (
          <>
            {" · "}
            <IconExternalLink size={11} />
          </>
        )}
        {!benchmark.variant && !rating.as_of && !url ? "—" : null}
      </small>
    </>
  );
}
