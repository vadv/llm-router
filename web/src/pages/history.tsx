import { Badge, Button, Group, NativeSelect, TextInput } from "@mantine/core";
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconRotateClockwise2,
  IconSearch,
} from "@tabler/icons-react";
import { useRef, useState, type FormEvent } from "react";
import { api, type RequestQuery, type RequestRecord, type RunningRequest } from "../api";
import { localInput } from "../components/usage-pivot";
import { RequestDrawer } from "../components/request-drawer";
import { OutcomeBadge, PageHeader, Panel } from "../components/ui";
import { clock, compact, dateTime, money, span, tpsFormat } from "../format";
import { routeParam, useNow, usePoll } from "../hooks";
import { Drill, drillUrl, SourceNote } from "./overview-links";
import { ActivityPanel, intervalLabel } from "./request-activity";
import type { CallInterval } from "../components/request-timeline";
import "./diagnostics.css";

const periods: Record<string, number> = {
  "1h": 3600,
  "24h": 86400,
  "7d": 604800,
  all: 0,
};
const outcomes = [
  { value: "", label: "Any result" },
  { value: "ok", label: "Successful" },
  { value: "error", label: "Failed" },
  { value: "client_cancel", label: "Client cancelled" },
];
const sizes = [25, 50, 100, 200];

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const fieldTime = (unix: number) =>
  localInput(unix) +
  (unix % 60 ? `:${String(unix % 60).padStart(2, "0")}` : "");
function routeWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): CallInterval | null {
  const from = Number(start),
    to = Number(end);
  return start &&
    end &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(to) &&
    from >= 0 &&
    to > from &&
    to <= 253402300799
    ? { from, to }
    : null;
}

export function HistoryPage() {
  const pool = routeParam("pool") ?? "",
    key = routeParam("key") ?? "";
  const provider = routeParam("provider") ?? "",
    model = routeParam("model") ?? "";
  const outcome =
    outcomes.find((o) => o.value === routeParam("outcome"))?.value ?? "";
  const period = routeParam("period") ?? "24h",
    range = Object.hasOwn(periods, period) ? period : "24h";
  const size = sizes.find((n) => n === Number(routeParam("size"))) ?? 50;
  const pools = usePoll(api.pools, [], false),
    providers = usePoll(api.providers, [], false);
  const [query, setQuery] = useState("");
  const [cursors, setCursors] = useState<{ id: string; since?: number }[]>([]);
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  const cursor = cursors.at(-1);
  // Calls being served live in the core's memory only; they reach the log
  // once they end.
  const running = usePoll(api.running);
  // Usage links select attempts; the history picker selects request starts.
  const attempts = routeWindow(routeParam("from"), routeParam("to"));
  const fixed = routeWindow(routeParam("since"), routeParam("until"));
  const [interval, setIntervalFilter] = useState<CallInterval | null>(null);
  const [initial] = useState(() => {
    const to = Math.floor(Date.now() / 60000) * 60 + 60;
    return (
      attempts ??
      fixed ??
      (periods[range] ? { from: to - periods[range], to } : null)
    );
  });
  const [timeError, setTimeError] = useState("");
  // On a phone the filters wait behind their title, so the calls start
  // near the top of the page.
  const [filtersOpen, setFiltersOpen] = useState(() =>
    window.matchMedia("(min-width: 56em)").matches,
  );
  const bounds = interval ?? attempts ?? fixed;
  const family = routeParam("family") ?? "";
  const log = useRef<HTMLDivElement>(null);
  function pickInterval(value: CallInterval | null) {
    if (!value && attempts) {
      const query = new URLSearchParams(window.location.hash.split("?")[1]);
      query.delete("from");
      query.delete("to");
      window.location.hash = drillUrl("history", Object.fromEntries(query));
      return;
    }
    setIntervalFilter(value);
    setCursors([]);
    setQuery("");
    if (value) {
      log.current?.focus({ preventScroll: true });
      log.current?.scrollIntoView({ block: "start" });
    }
  }
  const filters = {
    provider,
    model,
    family,
    metamodel: pool,
    keyAlias: key,
    outcome,
  };
  const active = [
    pool && `Pool: ${pool}`,
    key && `Key: ${key}`,
    provider && `Provider: ${provider}`,
    model && `Model: ${model}`,
    family && `Model across providers: ${family}`,
    outcome && outcomes.find((o) => o.value === outcome)?.label,
  ].filter(Boolean);
  // The default day is not a filter someone chose; a linked window is.
  const activeCount = active.length + (attempts || fixed ? 1 : 0);
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const params: Record<string, string> = {};
    const form = new FormData(e.currentTarget);
    const from = String(form.get("start") ?? ""),
      to = String(form.get("end") ?? "");
    if (!from && !to) {
      params.period = "all";
    } else {
      const parse = (value: string, original?: number) =>
        original !== undefined && fieldTime(original) === value
          ? original
          : Date.parse(value) / 1000;
      const start = parse(from, initial?.from),
        end = parse(to, initial?.to);
      if (
        !from ||
        !to ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > 253402300799 ||
        fieldTime(start) !== from ||
        fieldTime(end) !== to
      ) {
        setTimeError(
          "Enter both local dates and times. Until must be later than From. Clear both for all retained calls.",
        );
        return;
      }
      params[attempts ? "from" : "since"] = String(start);
      params[attempts ? "to" : "until"] = String(end);
    }
    if (family) params.family = family;
    for (const [name, raw] of form) {
      if (name === "start" || name === "end") continue;
      const value = String(raw).trim();
      if (value && !(name === "size" && value === "50")) params[name] = value;
    }
    setTimeError("");
    setIntervalFilter(null);
    setCursors([]);
    setQuery("");
    setFiltersOpen(false);
    window.location.hash = drillUrl("history", params);
  }
  if (
    ((routeParam("since") || routeParam("until")) && !fixed) ||
    ((routeParam("from") || routeParam("to")) && !attempts) ||
    (fixed && attempts)
  ) {
    return (
      <div className="diag-page" role="alert">
        Invalid time range.{" "}
        <a className="diag-action" href="#/history">
          Reset request filters
        </a>
      </div>
    );
  }
  return (
    <div className="diag-page">
      <PageHeader
        title="Requests"
        description="Every saved call, from the pool that took it to the attempt that answered."
        actions={<Drill href="#/activity">Router events</Drill>}
      />
      <Panel
        p={0}
        className="diag-filters"
        data-open={filtersOpen || undefined}
        title={
          <>
            <h2 className="diag-filters-title">Filters</h2>
            <button
              type="button"
              className="diag-filters-toggle"
              aria-expanded={filtersOpen}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              Filters
              {activeCount > 0 && <b>{activeCount} on</b>}
              <IconChevronDown className="diag-filters-chevron" size={16} aria-hidden />
            </button>
          </>
        }
      >
        <form onSubmit={apply} className="diag-history-form">
          <div className="diag-time-range">
            <TextInput
              name="start"
              label="From"
              type="datetime-local"
              step={initial && initial.from % 60 ? 1 : 60}
              size="xs"
              defaultValue={initial ? fieldTime(initial.from) : ""}
            />
            <TextInput
              name="end"
              label="Until"
              type="datetime-local"
              step={initial && initial.to % 60 ? 1 : 60}
              size="xs"
              defaultValue={initial ? fieldTime(initial.to) : ""}
            />
            <small>
              {attempts ? "Attempt start" : "Start time"} · {timezone} · end excluded. Clear both for every saved call.
            </small>
          </div>
          {timeError && (
            <p className="diag-time-error" role="alert">
              {timeError}
            </p>
          )}
          <div className="diag-filter-fields">
            <NativeSelect
              name="outcome"
              label="Call outcome"
              size="xs"
              defaultValue={outcome}
              data={outcomes}
            />
            <TextInput
              name="pool"
              label="Pool"
              size="xs"
              defaultValue={pool}
              list="call-pools"
              placeholder="Any pool"
            />
            <TextInput
              name="key"
              label="Client key alias"
              size="xs"
              defaultValue={key}
              placeholder="Any alias"
            />
            <TextInput
              name="provider"
              label="Provider"
              size="xs"
              defaultValue={provider}
              list="call-providers"
              placeholder="Any provider"
            />
            <TextInput
              name="model"
              label="Model ID"
              size="xs"
              defaultValue={model}
              placeholder="Any model"
            />
            <datalist id="call-pools">
              {pools.data?.map((p) => (
                <option key={p.name} value={p.name} />
              ))}
            </datalist>
            <datalist id="call-providers">
              {providers.data?.map((p) => (
                <option key={p.provider_id} value={p.provider_id} />
              ))}
            </datalist>
          </div>
          <div className="diag-filter-footer">
            <div className="diag-page-size">
              <label htmlFor="request-page-size">Rows per page</label>
              <NativeSelect
                id="request-page-size"
                name="size"
                size="xs"
                defaultValue={String(size)}
                data={sizes.map(String)}
              />
            </div>
            <div className="diag-filter-buttons">
              <Button
                type="reset"
                variant="default"
                size="xs"
                leftSection={
                  <IconRotateClockwise2 size={14} aria-hidden="true" />
                }
                onClick={(e) => {
                  e.preventDefault();
                  e.currentTarget.form?.reset();
                  setCursors([]);
                  setQuery("");
                  setTimeError("");
                  setIntervalFilter(null);
                  window.location.hash = "#/history";
                }}
              >
                Reset
              </Button>
              <Button
                type="submit"
                size="xs"
                leftSection={<IconCheck size={15} aria-hidden="true" />}
              >
                Apply filters
              </Button>
            </div>
          </div>
        </form>
      </Panel>
      {!attempts && (
        <ActivityPanel
          filters={{ ...filters, sinceUnix: fixed?.from, toUnix: fixed?.to }}
          period={range}
          selected={interval}
          onPick={pickInterval}
        />
      )}
      {!!running.data?.length && (
        <Panel
          p={0}
          title={<h2>In flight</h2>}
          description="What the router is serving now. A call joins the log below once it ends."
        >
          <div className="diag-ledger diag-inflight" role="list" aria-label="Calls in flight">
            {running.data.map((call) => (
              <RunningCall key={call.id} call={call} />
            ))}
          </div>
        </Panel>
      )}
      <div
        className="calls-log-target"
        tabIndex={-1}
        aria-label="Filtered request log"
        ref={log}
      >
        {(interval || attempts) && (
          <div className="calls-selection">
            <strong>
              {attempts ? "Attempt interval" : "Interval"} ·{" "}
              {intervalLabel((interval ?? attempts)!)}
            </strong>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => pickInterval(null)}
            >
              Clear interval
            </Button>
          </div>
        )}
        <HistoryResults
          key={JSON.stringify([cursor?.id, interval])}
          filters={{
            ...filters,
            sinceUnix: bounds?.from,
            toUnix: bounds?.to,
            attemptWindow: !!attempts,
          }}
          size={size}
          range={range}
          active={active}
          cursor={cursor}
          page={cursors.length + 1}
          query={query}
          setQuery={setQuery}
          open={setSelected}
          next={(id, since) => setCursors((c) => [...c, { id, since }])}
          prev={() => setCursors((c) => c.slice(0, -1))}
        />
      </div>
      <RequestDrawer request={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

type ResultsProps = {
  filters: Partial<RequestQuery>;
  range: string;
  size: number;
  active: (string | undefined)[];
  cursor?: { id: string; since?: number };
  page: number;
  query: string;
  setQuery: (s: string) => void;
  open: (r: RequestRecord) => void;
  next: (id: string, since?: number) => void;
  prev: () => void;
};
function HistoryResults({
  filters,
  size,
  range,
  active,
  cursor,
  page,
  query,
  setQuery,
  open,
  next,
  prev,
}: ResultsProps) {
  // A page cursor pins its lower time bound; only the newest page polls.
  const state = usePoll(
    async () => {
      const since = cursor
        ? cursor.since
        : (filters.sinceUnix ??
          (periods[range]
            ? Math.floor(Date.now() / 1000) + 1 - periods[range]
            : undefined));
      const records = await api.requests({
        ...filters,
        sinceUnix: since,
        beforeId: cursor?.id,
        limit: size + 1,
      });
      return { records, since };
    },
    [],
    !cursor && !filters.toUnix,
  );
  const loaded = state.data?.records.slice(0, size) ?? [];
  const needle = query.trim().toLowerCase();
  const visible = loaded.filter(
    (r) =>
      !needle ||
      [
        r.id,
        r.metamodel,
        r.key_alias,
        ...r.attempts.flatMap((a) => [
          a.provider_id,
          a.upstream_id,
          ...(a.tool_names ?? []),
        ]),
      ].some((s) => s.toLowerCase().includes(needle)),
  );
  return (
    <Panel
      p={0}
      title={<h2>Log</h2>}
      description="Newest first. Open a call to see its attempts, tools and previews."
      actions={
        <Badge variant="default" tt="none">
          Page {page}
        </Badge>
      }
    >
      <div className="diag-log-tools">
        <Group gap={5}>
          <Badge variant="light" tt="none">
            {filters.sinceUnix !== undefined && filters.toUnix !== undefined
              ? intervalLabel({ from: filters.sinceUnix, to: filters.toUnix })
              : range === "all"
                ? "All retained"
                : `Last ${range}`}
          </Badge>
          {active.map((a) => (
            <Badge key={a} title={a} tt="none" variant="default">
              {a}
            </Badge>
          ))}
        </Group>
        <TextInput
          size="xs"
          aria-label="Search this page"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          leftSection={<IconSearch size={14} />}
          placeholder="Find ID, model or tool on this page"
        />
      </div>
      <SourceNote source={state} name="Request log" />
      {state.data && (
        <>
          {visible.length > 0 ? (
            <div className="diag-ledger" role="list" aria-label="Requests">
              {visible.map((r) => (
                <CallRow key={r.id} r={r} open={() => open(r)} />
              ))}
            </div>
          ) : (
            <div className="diag-empty">
              <strong>
                {loaded.length
                  ? "No match on this page"
                  : "No requests in this selection"}
              </strong>
              <span>
                {loaded.length
                  ? "Search checks this page only. Try another term or page."
                  : "Widen the time window or remove a filter."}
              </span>
              {needle && (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setQuery("")}
                >
                  Clear search
                </Button>
              )}
            </div>
          )}
          <footer className="diag-pager">
            <span role="status">
              {visible.length} of {loaded.length} on this page
              {state.data.records.length <= size ? " · End of results" : ""}
            </span>
            <Group gap="xs">
              <Button
                variant="default"
                size="xs"
                disabled={!cursor}
                onClick={prev}
              >
                Newer
              </Button>
              <Button
                variant="default"
                size="xs"
                disabled={state.data.records.length <= size}
                onClick={() =>
                  next(loaded[loaded.length - 1].id, state.data?.since)
                }
              >
                Older
              </Button>
            </Group>
          </footer>
        </>
      )}
      {!state.data && cursor && (
        <Button variant="subtle" size="xs" onClick={prev}>
          Newer page
        </Button>
      )}
    </Panel>
  );
}

// A call the core is serving, in the columns of the log. There is nothing
// to open yet: tokens, cost and the outcome are known when the call ends.
function RunningCall({ call }: { call: RunningRequest }) {
  const now = useNow();
  const attempt = call.attempts.at(-1);
  return (
    <article className="diag-call" role="listitem">
      <div className="diag-call-time" title={dateTime(call.started_at_unix)}>
        <strong>{clock(call.started_at_unix)}</strong>
        <small>
          {new Date(call.started_at_unix * 1000).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </small>
      </div>
      <div className="diag-route">
        <strong title={call.metamodel}>{call.metamodel}</strong>
        <small>
          {attempt
            ? `${attempt.provider_id} / ${attempt.upstream_id}`
            : "Waiting for the first attempt"}
        </small>
      </div>
      <div className="diag-result">
        <Badge color="teal" variant="light" size="sm">
          running
        </Badge>
        <small>
          {call.attempts.length} {call.attempts.length === 1 ? "attempt" : "attempts"}
        </small>
      </div>
      <div className="diag-key">
        <small>Client key</small>
        <span title={call.key_alias}>{call.key_alias}</span>
      </div>
      <div className="diag-measure">
        <strong>{span(call.started_at_unix, now / 1000) ?? "—"}</strong>
        <small>elapsed</small>
      </div>
    </article>
  );
}

function CallRow({ r, open }: { r: RequestRecord; open: () => void }) {
  const a = r.attempts.find((a) => a.result === "ok") ?? r.attempts.at(-1);
  const sum = (field: "input_tokens" | "output_tokens" | "cost") => {
    const values = r.attempts.flatMap((a) =>
      a[field] == null ? [] : [a[field]],
    );
    if (!values.length) return "—";
    const total = values.reduce((s, n) => s + n, 0);
    return (
      (field === "cost" ? money(total) : compact(total)) +
      (values.length < r.attempts.length ? "*" : "")
    );
  };
  return (
    <article role="listitem" className="diag-call" onClick={open}>
      <div className="diag-call-time" title={dateTime(r.started_at_unix)}>
        <button
          type="button"
          className="request-open"
          aria-label={`Open call ${r.id}`}
          onClick={(e) => {
            e.stopPropagation();
            open();
          }}
        >
          {clock(r.started_at_unix)}
        </button>
        <small>
          {new Date(r.started_at_unix * 1000).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </small>
      </div>
      <div className="diag-route">
        <strong title={r.metamodel}>{r.metamodel}</strong>
        <small title={a ? `${a.provider_id} / ${a.upstream_id}` : undefined}>
          {a ? `${a.provider_id} / ${a.upstream_id}` : "No recorded attempt"}
        </small>
      </div>
      <div className="diag-result">
        <OutcomeBadge outcome={r.outcome} />
        <small>
          {r.attempts.length} {r.attempts.length === 1 ? "attempt" : "attempts"}
        </small>
      </div>
      <div className="diag-key">
        <small>Client key</small>
        <span title={r.key_alias}>{r.key_alias}</span>
      </div>
      <div className="diag-measure">
        <strong>{span(r.started_at_unix, r.finished_at_unix) ?? "—"}</strong>
        <small>
          {a && tpsFormat(a) !== "—" ? `${tpsFormat(a)} tok/s` : "Speed —"}
        </small>
      </div>
      <div
        className="diag-cost"
        title="Reported input → output tokens and cost across attempts. * means partial coverage."
      >
        <span>
          {sum("input_tokens")} → {sum("output_tokens")}
        </span>
        <small>Reported {sum("cost")}</small>
      </div>
      <IconChevronRight size={14} aria-hidden="true" />
    </article>
  );
}
