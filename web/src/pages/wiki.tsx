// Model Wiki: every model the connections list, what the researcher knows
// about each, and how they compare. The view lives in the URL, so it can be
// reloaded, bookmarked and sent.

import {
  ActionIcon,
  Alert,
  Button,
  Drawer,
  Menu,
  Modal,
  Progress,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconFilter2,
  IconLayoutList,
  IconSearch,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { benchmarkInfo, type BenchmarkInfo } from "../benchmarks";
import { EmptyState, Field, PageHeader, Panel } from "../components/ui";
import { eta } from "../format";
import { usePoll } from "../hooks";
import { indexEras, setIndexEras, TAG_LABELS, type Tag } from "../model-facts";
import { useModelSummaries } from "../use-model-summaries";
import {
  benchmarks,
  comparable,
  connectionOptions,
  defaultBenchmark,
  findModel,
  leaderboard,
  tagOptions,
  vendorOptions,
  wikiGroups,
  wikiModels,
  wikiResults,
  type BenchmarkOption,
  type LeaderRow,
  type ResearchFilter,
  type WikiFilters,
  type WikiModel,
  type WikiSort,
} from "../wiki-catalog";
import { LeaderboardTable, ModelRow } from "./wiki-rows";
import { ModelDossier } from "./wiki-dossier";
import "./wiki.css";

const PAGE = 40;
const SORTS: WikiSort[] = ["score", "score-asc", "name", "context", "connections", "release", "price", "speed"];
const RESEARCH: ResearchFilter[] = ["all", "cards", "missing"];
type View = "directory" | "leaderboard";

type State = {
  view: View;
  q: string;
  connection: string;
  vendor: string;
  tag: string;
  research: ResearchFilter;
  sort: WikiSort;
  /// "" = the benchmark most of the catalog was scored on.
  bench: string;
  /// Leaderboard: leave out numbers the model's vendor published itself.
  independent: boolean;
  /// Leaderboard: leave out readings taken at a named effort or condition,
  /// so what remains was measured as the model answers out of the box.
  plain: boolean;
  /// The open dossier: a catalog key or a listing id. "" = closed.
  model: string;
};

const DEFAULTS: State = {
  view: "directory",
  q: "",
  connection: "",
  vendor: "",
  tag: "",
  research: "all",
  sort: "score",
  bench: "",
  independent: true,
  plain: false,
  model: "",
};

function readState(): State {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  const one = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = params.get(name);
    return allowed.includes(value as T) ? (value as T) : fallback;
  };
  return {
    view: one("view", ["directory", "leaderboard"], DEFAULTS.view),
    q: params.get("q") ?? "",
    connection: params.get("connection") ?? "",
    vendor: params.get("vendor") ?? "",
    tag: params.get("tag") ?? "",
    research: one("research", RESEARCH, DEFAULTS.research),
    sort: one("sort", SORTS, DEFAULTS.sort),
    bench: params.get("bench") ?? "",
    independent: params.get("all") !== "1",
    plain: params.get("effort") === "default",
    model: params.get("model") ?? "",
  };
}

function address(state: State): string {
  const params = new URLSearchParams();
  const put = (name: string, value: string, skip: string) => {
    if (value && value !== skip) params.set(name, value);
  };
  put("view", state.view, DEFAULTS.view);
  put("q", state.q.trim(), "");
  put("connection", state.connection, "");
  put("vendor", state.vendor, "");
  put("tag", state.tag, "");
  put("research", state.research, DEFAULTS.research);
  put("sort", state.sort, DEFAULTS.sort);
  put("bench", state.bench, "");
  put("all", state.independent ? "" : "1", "");
  put("effort", state.plain ? "default" : "", "");
  put("model", state.model, "");
  const query = params.toString();
  return `#/wiki${query ? `?${query}` : ""}`;
}

/// Filter options with their counts. A filter named in the URL but gone
/// from the catalog stays selectable, so the URL keeps meaning what it says.
function counted(options: { value: string; label: string; count: number }[], current: string) {
  const list = options.map((option) => ({ ...option, label: `${option.label} (${option.count})` }));
  return current && !list.some((option) => option.value === current)
    ? [{ value: current, label: current, count: 0 }, ...list]
    : list;
}

function sortOptions() {
  // The benchmark is chosen next to this control; naming it again would
  // not fit.
  return [
    { value: "score", label: "Highest score" },
    { value: "score-asc", label: "Lowest score" },
    { value: "name", label: "Name, A to Z" },
    { value: "price", label: "Cheapest first" },
    { value: "context", label: "Largest context" },
    { value: "speed", label: "Fastest first" },
    { value: "connections", label: "Most connections" },
    { value: "release", label: "Newest release" },
  ];
}

export function WikiPage() {
  const catalog = usePoll(api.catalog, []);
  // The catalog polls on its own; the summaries are read again only when it
  // names new keys, or after a card changed.
  const keys = useMemo(
    () =>
      catalog.data
        ? JSON.stringify([...new Set(catalog.data.map((row) => row.knowledge_key))].sort())
        : null,
    [catalog.data],
  );
  const index = useModelSummaries(keys);
  const [state, setState] = useState(readState);
  const [shown, setShown] = useState(PAGE);
  const [variant, setVariant] = useState<string | null>(null);
  const [confirmResearch, setConfirmResearch] = useState<null | "missing" | "all">(null);
  // On a phone the facet filters wait behind one button, so the list starts
  // near the top.
  const [moreFilters, setMoreFilters] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A link, the Back button and this page's own controls all change the
  // hash; the hash is the one place the view is stored.
  useEffect(() => {
    const sync = () => {
      setState(readState());
      setVariant(null);
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  // Filters replace the current entry, so Back leaves the page instead of
  // stepping through every keystroke; opening a dossier adds one, so Back
  // closes it.
  const update = useCallback((patch: Partial<State>, keepEntry = true) => {
    setState((previous) => {
      const next = { ...previous, ...patch };
      if (keepEntry) window.history.replaceState(null, "", address(next));
      else window.location.hash = address(next);
      return next;
    });
  }, []);

  const cards = index.state?.cards;
  const groups = useMemo(
    () => wikiGroups(catalog.data ?? [], cards ?? []),
    [catalog.data, cards],
  );
  // Dossiers and hover cards elsewhere name benchmarks as this catalog does.
  useEffect(() => setIndexEras(indexEras(cards ?? [])), [cards]);
  const models = useMemo(() => wikiModels(groups), [groups]);
  const options = useMemo(() => benchmarks(models), [models]);
  const shared = useMemo(() => options.filter(comparable), [options]);
  const benchmark: BenchmarkOption | null =
    (state.bench && shared.find((option) => option.id === state.bench)) ||
    defaultBenchmark(shared) ||
    null;
  const filters: WikiFilters = useMemo(
    () => ({
      query: state.q,
      connection: state.connection || null,
      vendor: state.vendor || null,
      tag: (state.tag || null) as Tag | null,
      research: state.research,
    }),
    [state.q, state.connection, state.vendor, state.tag, state.research],
  );
  // Without any score there is nothing to rank by: names are the honest order.
  const sort: WikiSort =
    benchmark || (state.sort !== "score" && state.sort !== "score-asc")
      ? state.sort
      : "name";
  const result = useMemo(
    () => wikiResults(models, filters, sort, benchmark?.id ?? null),
    [models, filters, sort, benchmark],
  );
  // The leaderboard keeps the filters and takes its order from the benchmark.
  const passing = useMemo(
    () => new Set(wikiResults(models, filters, "name", null).rows.map((model) => model.key)),
    [models, filters],
  );
  const ranked = useMemo(
    () => (benchmark ? leaderboard(models, benchmark.id, false).filter((row) => passing.has(row.model.key)) : []),
    [benchmark, models, passing],
  );
  const independent = useMemo(
    () => (state.independent ? ranked.filter((row) => row.score.benchmark.kind !== "vendor") : ranked),
    [ranked, state.independent],
  );
  const board = useMemo(
    () => (state.plain ? independent.filter((row) => !row.score.benchmark.variant) : independent),
    [independent, state.plain],
  );
  // What each switch is holding back, so the table can offer to show it.
  const vendorOnly = state.independent ? ranked.length - independent.length : 0;
  const withSetting = state.plain ? independent.length - board.length : 0;

  const missing = models.filter(
    (model) => !model.card && !model.variants.some((group) => group.card),
  ).length;

  // Every new view starts the list over; further rows load when scrolled to.
  useEffect(() => {
    setShown(PAGE);
  }, [state.q, state.connection, state.vendor, state.tag, state.research, state.sort, state.bench, state.view, benchmark?.id]);
  useEffect(() => {
    if (shown >= result.rows.length) return;
    const sentinel = document.getElementById("wiki-more");
    if (!sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShown((count) => count + PAGE);
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [shown, result.rows.length, state.view]);

  // "/" looks something up, as it does in the tools this one sits next to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable], [role='dialog']")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- The research job ----
  const job = usePoll(api.researchStatus, [], false);
  const { reload: reloadJob } = job;
  // A core without the job endpoint answers 404: its controls then stay away.
  const jobSupported = job.errorStatus !== 404;
  const running = job.data?.running === true;
  const { reload: reloadIndex } = index;
  const { reload: reloadCatalog } = catalog;
  const wasRunning = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(
      () => !document.hidden && void reloadJob(),
      running ? 2500 : 15_000,
    );
    return () => window.clearInterval(timer);
  }, [running, reloadJob]);
  // Cards arrive while the job runs; the directory follows along.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void reloadIndex(), 12_000);
    return () => window.clearInterval(timer);
  }, [running, reloadIndex]);
  useEffect(() => {
    const done = job.data;
    if (wasRunning.current && !running && done && done.total > 0 && done.done >= done.total) {
      void reloadIndex();
      void reloadCatalog();
      notifications.show({
        message: `Research finished: ${done.updated} updated, ${done.failed} failed, ${done.skipped} skipped.`,
      });
    }
    wasRunning.current = running;
  }, [running, job.data, reloadIndex, reloadCatalog]);

  const startResearch = async (scope: "missing" | "all") => {
    setConfirmResearch(null);
    try {
      await api.startResearch(scope === "all");
      notifications.show({
        message:
          scope === "all"
            ? "Research started for every model. It runs on the router."
            : `Research started for ${missing} models. It runs on the router.`,
      });
      void reloadJob();
    } catch (failure: unknown) {
      notifications.show({ color: "red", message: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  // ---- The dossier ----
  const selected = findModel(models, state.model);
  const order = state.view === "leaderboard" ? board.map((row) => row.model) : result.rows;
  const place = selected ? order.findIndex((model) => model.key === selected.key) : -1;
  const places = useMemo(() => {
    const map = new Map<string, { place: number; of: number }>();
    if (!selected) return map;
    for (const id of selected.scores.keys()) {
      // Counted as the leaderboard counts when it opens: with vendor figures
      // left out, a vendor's own number has no place.
      const rows = leaderboard(models, id, false);
      const eligible = rows.filter(
        (row) =>
          !(state.independent && row.score.benchmark.kind === "vendor") &&
          !(state.plain && row.score.benchmark.variant),
      );
      const at = eligible.findIndex((row) => row.model.key === selected.key);
      // A place among two is no place; one among a hundred is.
      if (at >= 0 && eligible.length >= 3) map.set(id, { place: at + 1, of: eligible.length });
    }
    return map;
  }, [selected, models, state.independent, state.plain]);

  const filtered =
    !!state.q.trim() || !!state.connection || !!state.vendor || !!state.tag || state.research !== "all";
  const clear = () => update({ q: "", connection: "", vendor: "", tag: "", research: "all" });
  const info: BenchmarkInfo | null = benchmark ? benchmarkInfo(benchmark.id) : null;
  const ready = catalog.data !== undefined;

  return (
    <div className="wiki">
      <PageHeader
        title="Model Wiki"
        description="Every model your connections list, what it costs and how it compares."
        actions={
          jobSupported ? (
            <Menu position="bottom-end" withArrow shadow="lg" withinPortal>
              <Menu.Target>
                <Button
                  size="compact-sm"
                  variant="default"
                  disabled={running}
                  rightSection={<IconChevronDown size={14} />}
                  leftSection={<IconSparkles size={15} />}
                >
                  Research
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Ask the researcher</Menu.Label>
                <Menu.Item disabled={!missing} onClick={() => setConfirmResearch("missing")}>
                  Research {missing} missing {missing === 1 ? "card" : "cards"}
                </Menu.Item>
                <Menu.Item onClick={() => setConfirmResearch("all")}>
                  Research all {models.length} again…
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          ) : undefined
        }
      />

      {running && job.data && (
        <div className="wiki-job" role="status">
          <div className="wiki-job-text">
            <strong>
              Researching · {Math.min(job.data.done, job.data.total)} of {job.data.total}
            </strong>
            <span>
              {job.data.updated} updated
              {job.data.failed ? ` · ${job.data.failed} failed` : ""}
              {job.data.cancel_requested
                ? " · stopping"
                : ` · ${eta(job.data.started_at_unix, job.data.done, job.data.total) ?? "estimating"}`}
            </span>
          </div>
          <Progress
            value={job.data.total ? (100 * job.data.done) / job.data.total : 0}
            size="sm"
            radius="xl"
            aria-label="Research progress"
          />
          <span className="wiki-job-current">
            {job.data.current.slice(0, 2).map((key) => (
              <button key={key} type="button" className="link-button" onClick={() => update({ model: key }, false)}>
                {key}
              </button>
            ))}
          </span>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="Stop research after the cards in flight"
            title={job.data.cancel_requested ? "Stopping" : "Stop after the cards in flight"}
            disabled={job.data.cancel_requested}
            onClick={() => void api.cancelResearch().then(reloadJob)}
          >
            <IconX size={15} />
          </ActionIcon>
        </div>
      )}

      {catalog.error && (
        <Alert color="red" radius="md" title="Catalog unavailable">
          {catalog.error}{" "}
          <Button size="compact-xs" variant="default" onClick={catalog.reload}>
            Retry
          </Button>
        </Alert>
      )}
      {index.state?.error && (
        <Alert color="orange" radius="md" title="Research cards unavailable">
          Listings still work; cards and scores do not.{" "}
          <Button size="compact-xs" variant="default" onClick={index.reload}>
            Retry
          </Button>
        </Alert>
      )}
      {state.model && ready && !selected && (
        <Alert color="orange" radius="md" title="No such model in this catalog">
          No connection lists it now.{" "}
          <Button size="compact-xs" variant="default" onClick={() => update({ model: "" })}>
            Back to the directory
          </Button>
        </Alert>
      )}

      <div className="wiki-controls">
        <div className="wiki-filters">
          <Field label="Search" grow>
            <TextInput
              ref={searchRef}
              size="sm"
              placeholder="Model, vendor, ID or use"
              leftSection={<IconSearch size={15} />}
              rightSection={<kbd className="wiki-kbd">/</kbd>}
              value={state.q}
              onChange={(event) => update({ q: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape" && state.q) {
                  event.stopPropagation();
                  update({ q: "" });
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  listRef.current?.querySelector<HTMLElement>(".wiki-row:not(.wiki-row-head)")?.focus();
                }
              }}
            />
          </Field>
          <button
            type="button"
            className="wiki-more-filters"
            data-open={moreFilters || undefined}
            aria-expanded={moreFilters}
            onClick={() => setMoreFilters((open) => !open)}
          >
            <IconFilter2 size={14} />
            Filters
            {!!(state.connection || state.vendor || state.tag || state.research !== "all") && (
              <b>{[state.connection, state.vendor, state.tag, state.research !== "all"].filter(Boolean).length}</b>
            )}
          </button>
          <div className="wiki-filters-extra" data-open={moreFilters || undefined}>
          <Field label="Connection">
            <Select
              size="sm"
              placeholder="All"
              data={counted(connectionOptions(models), state.connection)}
              value={state.connection || null}
              onChange={(value) => update({ connection: value ?? "" })}
              searchable
              clearable
              allowDeselect={false}
            />
          </Field>
          <Field label="Vendor">
            <Select
              size="sm"
              placeholder="All"
              data={counted(vendorOptions(models), state.vendor)}
              value={state.vendor || null}
              onChange={(value) => update({ vendor: value ?? "" })}
              searchable
              clearable
              allowDeselect={false}
            />
          </Field>
          <Field label="Use">
            <Select
              size="sm"
              placeholder="Any"
              data={counted(
                tagOptions(models).map((tag) => ({
                  ...tag,
                  label: TAG_LABELS[tag.value as Tag] ?? tag.value,
                })),
                state.tag,
              )}
              value={state.tag || null}
              onChange={(value) => update({ tag: value ?? "" })}
              clearable
              allowDeselect={false}
            />
          </Field>
          <Field label="Cards">
            <Select
              size="sm"
              data={[
                { value: "all", label: "Any" },
                { value: "cards", label: "Researched" },
                { value: "missing", label: "Not researched yet" },
              ]}
              value={state.research}
              onChange={(value) => update({ research: (value as ResearchFilter) ?? "all" })}
              allowDeselect={false}
            />
          </Field>
          </div>
          {filtered && (
            <Button
              variant="subtle"
              color="gray"
              size="compact-sm"
              className="wiki-clear"
              leftSection={<IconX size={13} />}
              onClick={clear}
            >
              Clear
            </Button>
          )}
        </div>

        <div className="wiki-order">
          <SegmentedControl
            size="xs"
            value={state.view}
            onChange={(value) => update({ view: value as View })}
            data={[
              { value: "directory", label: "Directory" },
              { value: "leaderboard", label: "Leaderboard" },
            ]}
          />
          {benchmark && (
            <Field label="Benchmark" grow>
              <Select
                size="sm"
                searchable
                allowDeselect={false}
                value={benchmark.id}
                onChange={(value) => update({ bench: value ?? "" })}
                data={shared.map((option) => ({
                  value: option.id,
                  label: `${option.label} · ${option.count}`,
                }))}
              />
            </Field>
          )}
          {state.view === "directory" ? (
            <Field label="Order">
              <Select
                size="sm"
                allowDeselect={false}
                value={sort}
                onChange={(value) => update({ sort: (value as WikiSort) ?? "name" })}
                data={sortOptions()}
              />
            </Field>
          ) : (
            <div className="wiki-switches">
              <Switch
                size="xs"
                label="Independent measurements only"
                checked={state.independent}
                onChange={(event) => update({ independent: event.currentTarget.checked })}
                styles={{ label: { fontSize: 12 } }}
              />
              <Switch
                size="xs"
                label="Default settings only"
                checked={state.plain}
                onChange={(event) => update({ plain: event.currentTarget.checked })}
                styles={{ label: { fontSize: 12 } }}
              />
            </div>
          )}
        </div>
      </div>

      {state.view === "leaderboard" && benchmark && (
        <section className="wiki-board-head">
          <div>
            <h2>{benchmark.label}</h2>
            <p>
              {info?.what ||
                "No description of this benchmark yet. Compare only models that were measured the same way."}
            </p>
          </div>
          <dl className="wiki-board-facts">
            <div>
              <dt>Scale</dt>
              <dd>{info?.scale ?? "Higher is better"}</dd>
            </div>
            <div>
              <dt>Models</dt>
              <dd>{board.length}</dd>
            </div>
            <div>
              <dt>Score range</dt>
              <dd>{range(board)}</dd>
            </div>
          </dl>
        </section>
      )}

      {!ready && !catalog.error ? (
        <div className="wiki-skeleton" aria-label="Reading the catalog">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} height={64} radius="md" />
          ))}
        </div>
      ) : ready && models.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<IconLayoutList size={18} />}
            title="No models listed"
            action={
              <Button size="compact-sm" variant="light" component="a" href="#/providers">
                Open providers
              </Button>
            }
          >
            The connections list nothing yet. Their catalogs are on the providers page.
          </EmptyState>
        </Panel>
      ) : state.view === "leaderboard" && benchmark ? (
        <LeaderboardTable
          rows={board}
          benchmark={benchmark}
          heldBack={[
            {
              count: vendorOnly,
              onShow: () => update({ independent: false }),
              text: (count) =>
                `${count} ${count === 1 ? "model was" : "models were"} scored by ${count === 1 ? "its" : "their"} vendor${count === 1 ? "" : "s"} only.`,
            },
            {
              count: withSetting,
              onShow: () => update({ plain: false }),
              text: (count) =>
                `${count} ${count === 1 ? "model has" : "models have"} only a reading at a named effort or condition.`,
            },
          ]}
        />
      ) : (
        <>
          <div className="wiki-count">
            <span>
              <b>{result.rows.length}</b> {result.rows.length === 1 ? "model" : "models"}
              {filtered && ` of ${models.length}`}
              {` · ${models.length - missing} researched`}
              {missing ? ` · ${missing} without a card` : ""}
            </span>
            {benchmark && result.measured > 0 && (
              <span>
                {result.measured} scored on {benchmark.label}
                {benchmark.lowerIsBetter ? ", lower is better" : ""}
              </span>
            )}
          </div>
          {result.rows.length === 0 ? (
            <Panel>
              <EmptyState
                icon={<IconSearch size={18} />}
                title="No model matches"
                action={
                  <Button size="compact-sm" variant="light" onClick={clear}>
                    Clear filters
                  </Button>
                }
              >
                Try a name, a vendor or a connection, or clear the filters.
              </EmptyState>
            </Panel>
          ) : (
            <div
              className="wiki-list"
              ref={listRef}
              onKeyDown={(event) => {
                // Arrow keys walk the rows, as they do in any list.
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                const rows = [...(listRef.current?.querySelectorAll<HTMLElement>(".wiki-row") ?? [])];
                const at = rows.indexOf(document.activeElement as HTMLElement);
                if (at < 0) return;
                event.preventDefault();
                rows[at + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
              }}
            >
              <div className="wiki-row wiki-row-head" aria-hidden>
                <span>Model</span>
                <SortHead active={sort === "price"} label="Price / 1M" onClick={() => update({ sort: "price" })} />
                <SortHead active={sort === "context"} label="Context" onClick={() => update({ sort: "context" })} />
                <span className="wiki-col-providers">Listed on</span>
                <SortHead
                  active={sort === "score" || sort === "score-asc" || sort === "speed" || sort === "connections" || sort === "release"}
                  label={headLabel(sort, benchmark)}
                  onClick={() =>
                    update({
                      sort:
                        sort === "score" ? "score-asc" : sort === "score-asc" ? "score" : sort === "speed" || sort === "connections" || sort === "release" ? "name" : "score",
                    })
                  }
                />
                <span />
              </div>
              {result.rows.slice(0, shown).map((model) => (
                <ModelRow
                  key={model.key}
                  model={model}
                  benchmark={benchmark}
                  place={sort === "score" || sort === "score-asc" ? result.places.get(model.key) : undefined}
                  of={sort === "score" || sort === "score-asc" ? result.measured : undefined}
                  sort={sort}
                />
              ))}
              <div id="wiki-more" />
              {shown < result.rows.length && (
                <Button
                  variant="subtle"
                  color="gray"
                  size="compact-sm"
                  mx="auto"
                  onClick={() => setShown((count) => count + PAGE)}
                >
                  Show {Math.min(PAGE, result.rows.length - shown)} more · {shown} of {result.rows.length}
                </Button>
              )}
            </div>
          )}
        </>
      )}

      <Modal
        opened={confirmResearch !== null}
        onClose={() => setConfirmResearch(null)}
        title={confirmResearch === "all" ? "Research every model again?" : "Research the missing cards?"}
        centered
        size="sm"
      >
        <div className="wiki-confirm">
          <p>
            {confirmResearch === "all"
              ? `${models.length} cards, one research call each, fresh ones included. The job runs on the router, so this page can be closed.`
              : `${missing} ${missing === 1 ? "model has" : "models have"} no card yet: one research call ${missing === 1 ? "for it" : "each"}. The job runs on the router, so this page can be closed.`}
          </p>
          <div className="wiki-confirm-actions">
            <Button variant="default" size="compact-sm" onClick={() => setConfirmResearch(null)}>
              Cancel
            </Button>
            <Button
              size="compact-sm"
              leftSection={<IconSparkles size={14} />}
              onClick={() => void startResearch(confirmResearch ?? "missing")}
            >
              Start research
            </Button>
          </div>
        </div>
      </Modal>

      <Drawer
        opened={!!selected}
        onClose={() => {
          setVariant(null);
          update({ model: "" });
        }}
        position="right"
        size="min(700px, 100vw)"
        withCloseButton
        title={
          selected ? (
            <div className="wiki-drawer-nav">
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Previous model"
                disabled={place <= 0}
                onClick={() => step(order, place, -1, update)}
              >
                <IconChevronLeft size={16} />
              </ActionIcon>
              <span>{place >= 0 ? `${place + 1} of ${order.length}` : ""}</span>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="sm"
                aria-label="Next model"
                disabled={place < 0 || place >= order.length - 1}
                onClick={() => step(order, place, 1, update)}
              >
                <IconChevronRight size={16} />
              </ActionIcon>
            </div>
          ) : null
        }
      >
        {selected && (
          <div className="wiki-drawer-body">
            <ModelDossier
              model={selected}
              places={places}
              variantKey={variant}
              onVariant={setVariant}
              onBenchmark={(id) => update({ view: "leaderboard", bench: id, model: "" }, false)}
              onResearched={index.reload}
            />
          </div>
        )}
      </Drawer>
    </div>
  );
}

/// The label of the column the list is ordered by, when it is not a column
/// of its own.
function headLabel(sort: WikiSort, benchmark: BenchmarkOption | null): string {
  if (sort === "speed") return "Speed";
  if (sort === "connections") return "Connections";
  if (sort === "release") return "Released";
  return benchmark?.label ?? "Score";
}

function range(rows: LeaderRow[]): string {
  if (!rows.length) return "—";
  const values = rows.map((row) => row.score.rating.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  return low === high ? String(low) : `${low} – ${high}`;
}

/// Move to a neighbour in the list, adding a history entry per dossier.
function step(
  order: WikiModel[],
  place: number,
  offset: number,
  update: (patch: Partial<State>, keepEntry?: boolean) => void,
) {
  const next = order[place + offset];
  if (next) update({ model: next.key }, false);
}

function SortHead({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="wiki-sort-head"
      data-active={active || undefined}
      aria-sort={active ? "descending" : undefined}
      onClick={onClick}
    >
      {label}
      <IconChevronDown size={12} className="wiki-sort-mark" />
    </button>
  );
}
