import { useMemo, useState } from "react";
import { Alert, Button, Group, Loader, Select, TextInput } from "@mantine/core";
import {
  IconArrowRight,
  IconArrowsExchange,
  IconCalendar,
  IconChartBar,
  IconDownload,
} from "@tabler/icons-react";
import {
  api,
  type ProviderInfo,
  type SpendPage,
  type UsageFilters,
  type UsageGroupBy,
  type UsageQuery,
} from "../api";
import {
  amount,
  calendarDay,
  cash,
  localInput,
  makePivot,
  missing,
  number,
  perMillion,
  prepareCosts,
  type Cell,
  type Measure,
  type Window,
} from "../components/usage-pivot";
import { PageHeader } from "../components/ui";
import { knownTokens } from "../components/usage-math";
import { compact } from "../format";
import { routeParam, usePoll, type Resource } from "../hooks";
import { splitModelGroup } from "../model-key";
import { drillUrl } from "./overview-links";
import { stamp, UsageActivity } from "./usage-activity";
import "./usage.css";

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ROLLING = [
  { label: "1h", hours: 1 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "30d", hours: 720 },
];

/// Token counts read short in the summary; the exact count is one hover away.
function big(value: number | null) {
  return value !== null && value >= 100_000 ? compact(value) : number(value);
}

/// Offer a file to download. Used for the CSV export.
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const dimensions: Record<UsageGroupBy, string> = {
  provider: "Provider",
  family: "Model across providers",
  model: "Exact model listing",
  metamodel: "Pool",
  key: "Client key",
};
const metrics: Record<Measure, string> = {
  tokens: "Tokens",
  spend: "Cost",
  estimate: "Estimated spend",
  reported: "Reported cost",
};
const options = (values: (string | undefined)[]) =>
  [...new Set(values.filter((v): v is string => !!v))].sort();
function initialRange(): Window {
  const from = Number(routeParam("from")),
    end = Number(routeParam("to"));
  if (
    routeParam("from") &&
    Number.isSafeInteger(from) &&
    Number.isSafeInteger(end) &&
    from >= 0 &&
    end > from &&
    end <= 253402300799
  )
    return { from, to: end };
  const period = routeParam("period"),
    hours = { "1h": 1, "24h": 24, "7d": 168, "30d": 720 }[period ?? ""];
  if (!hours && period !== "all") return calendarDay(false);
  const to = Math.ceil(Date.now() / 60000) * 60;
  return { from: hours ? to - hours * 3600 : 0, to };
}
function RangePicker({
  range,
  apply,
}: {
  range: Window;
  apply: (r: Window) => void;
}) {
  const [from, setFrom] = useState(localInput(range.from)),
    [to, setTo] = useState(localInput(range.to)),
    [error, setError] = useState("");
  const show = (r: Window) => {
    setFrom(localInput(r.from));
    setTo(localInput(r.to));
    setError("");
    apply(r);
  };
  const preset = (yesterday: boolean) => show(calendarDay(yesterday));
  // A rolling window ends on the current minute.
  const rolling = (hours: number) => {
    const to = Math.ceil(Date.now() / 60000) * 60;
    show({ from: to - hours * 3600, to });
  };
  const active = ROLLING.find(
    ({ hours }) => range.to - range.from === hours * 3600 && range.to === Math.ceil(Date.now() / 60000) * 60,
  )?.label;
  return (
    <form
      className="ux-range"
      onSubmit={(e) => {
        e.preventDefault();
        const start = Date.parse(from) / 1000,
          end = Date.parse(to) / 1000;
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end <= start ||
          localInput(start) !== from ||
          localInput(end) !== to
        ) {
          setError("Enter a valid local date range. End must be after start.");
          return;
        }
        setError("");
        apply({ from: start, to: end });
      }}
    >
      <TextInput
        size="xs"
        label="From"
        type="datetime-local"
        required
        withAsterisk={false}
        value={from}
        onChange={(e) => setFrom(e.currentTarget.value)}
      />
      <TextInput
        size="xs"
        label="Until"
        type="datetime-local"
        required
        withAsterisk={false}
        value={to}
        onChange={(e) => setTo(e.currentTarget.value)}
      />
      <Button type="submit" size="xs" variant="light">
        Apply range
      </Button>
      <div className="ux-shortcuts" role="group" aria-label="Quick ranges">
        {ROLLING.map(({ label, hours }) => (
          <button
            type="button"
            key={label}
            data-active={active === label || undefined}
            onClick={() => rolling(hours)}
          >
            {label}
          </button>
        ))}
        <i className="ux-shortcuts-sep" aria-hidden />
        <button type="button" onClick={() => preset(true)}>
          Yesterday
        </button>
        <button type="button" onClick={() => preset(false)}>
          Today
        </button>
      </div>
      <small>
        <IconCalendar size={14} /> {zone}
      </small>
      {error && <div role="alert">{error}</div>}
    </form>
  );
}
export function UsagePage() {
  const [range, setRange] = useState(initialRange),
    [filters, setFilters] = useState<UsageFilters>(() =>
      Object.fromEntries(
        ["provider", "family", "model", "key", "pool"].flatMap((k) =>
          routeParam(k) ? [[k, routeParam(k)!]] : [],
        ),
      ),
    );
  const [group, setGroup] = useState<UsageGroupBy>(() =>
      Object.hasOwn(dimensions, routeParam("group") ?? "")
        ? (routeParam("group") as UsageGroupBy)
        : filters.provider
          ? "family"
          : "provider",
    ),
    [metric, setMetric] = useState<Measure>(() =>
      Object.hasOwn(metrics, routeParam("metric") ?? "")
        ? (routeParam("metric") as Measure)
        : "tokens",
    );
  const [unitChoice, setUnit] = useState("");
  const [grain, setGrain] = useState("auto"),
    [selected, select] = useState<Window | null>(null);
  const providers = usePoll(api.providers, [], false),
    catalog = usePoll(api.catalog, [], false),
    pools = usePoll(api.pools, [], false);
  const listing = (catalog.data ?? []).filter(
    (c) => !filters.provider || c.provider_id === filters.provider,
  );
  const size = range.to - range.from,
    bucket = (
      grain === "auto"
        ? size <= 3 * 3600
          ? "minute"
          : size <= 7 * 86400
            ? "hour"
            : "day"
        : grain
    ) as UsageQuery["bucket"];
  const rateKey =
    metric === "tokens" ? null : JSON.stringify([range, filters.provider]);
  const rates = usePoll(
    async () =>
      rateKey === null
        ? undefined
        : {
            key: rateKey,
            page: await api.usageSpend(filters.provider, {
              sinceUnix: range.from,
              toUnix: range.to,
            }),
          },
    [rateKey],
    false,
  );
  function patch(next: UsageFilters) {
    setFilters(
      Object.fromEntries(
        Object.entries({ ...filters, ...next }).filter(([, v]) => v),
      ),
    );
  }
  function drill(d: UsageGroupBy, id: string) {
    if (d === "model") {
      const m = splitModelGroup(id);
      if (m) patch({ provider: m.providerId, model: m.upstreamId });
      setGroup("key");
    } else if (d === "family") {
      patch({ family: id, model: undefined });
      setGroup(filters.provider ? "model" : "provider");
    } else if (d === "provider") {
      patch({ provider: id });
      setGroup(filters.family ? "model" : "family");
    } else {
      patch({ [d === "metamodel" ? "pool" : "key"]: id });
      setGroup("provider");
    }
  }
  return (
    <div className="ux-report">
      <PageHeader
        title="Usage"
        description="See which models, providers, pools and keys used your tokens. Switch to cost to compare spend."
      />
      <section className="ux-controls" aria-label="Report filters">
        <RangePicker
          key={`${range.from}/${range.to}`}
          range={range}
          apply={(r) => {
            select(null);
            setRange(r);
          }}
        />
        <div className="ux-filters">
          <Select
            size="xs"
            label="Connection"
            placeholder="All providers"
            searchable
            clearable
            value={filters.provider ?? null}
            data={options([
              ...(providers.data ?? []).map((p) => p.provider_id),
              ...listing.map((c) => c.provider_id),
              filters.provider,
            ])}
            onChange={(v) => {
              patch({ provider: v ?? undefined, model: undefined });
              setGroup(v ? (filters.family ? "model" : "family") : "provider");
            }}
          />
          <Select
            size="xs"
            label="Model"
            placeholder="All models"
            searchable
            clearable
            value={filters.family ?? null}
            data={options([
              ...listing.map((c) => c.knowledge_key),
              filters.family,
            ])}
            onChange={(v) => {
              patch({ family: v ?? undefined, model: undefined });
              setGroup(
                filters.provider ? (v ? "model" : "family") : "provider",
              );
            }}
          />
          {filters.provider && (
            <Select
              size="xs"
              label="Exact listing"
              placeholder="All aliases"
              searchable
              clearable
              value={filters.model ?? null}
              data={options([
                ...listing
                  .filter(
                    (c) =>
                      !filters.family || c.knowledge_key === filters.family,
                  )
                  .map((c) => c.upstream_id),
                filters.model,
              ])}
              onChange={(v) =>
                patch({
                  model: v ?? undefined,
                  family: v
                    ? listing.find((c) => c.upstream_id === v)?.knowledge_key
                    : filters.family,
                })
              }
            />
          )}
          <Select
            size="xs"
            label="Pool"
            placeholder="All pools"
            searchable
            clearable
            data={options([
              ...(pools.data ?? []).map((p) => p.name),
              filters.pool,
            ])}
            value={filters.pool ?? null}
            onChange={(v) => patch({ pool: v ?? undefined })}
          />
          <form
            key={filters.key ?? ""}
            onSubmit={(e) => {
              e.preventDefault();
              patch({
                key:
                  String(
                    new FormData(e.currentTarget).get("key") ?? "",
                  ).trim() || undefined,
              });
            }}
          >
            <TextInput
              label="Client key alias"
              name="key"
              size="xs"
              placeholder="All keys"
              defaultValue={filters.key ?? ""}
              rightSection={
                <button
                  className="ux-go"
                  type="submit"
                  aria-label="Apply key alias"
                >
                  <IconArrowRight size={14} />
                </button>
              }
            />
          </form>
          {Object.keys(filters).length > 0 && (
            <button
              className="ux-link"
              onClick={() => {
                setFilters({});
                setGroup("provider");
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        {filters.family && filters.provider && (
          <button
            className="ux-link"
            onClick={() => {
              patch({ provider: undefined, model: undefined });
              setGroup("provider");
            }}
          >
            <IconArrowsExchange size={15} /> Compare this model across providers
          </button>
        )}
        {(catalog.error || providers.error || pools.error) && (
          <small role="status">
            Some filter choices could not be loaded. You can still select a row
            in the breakdown.
          </small>
        )}
      </section>
      <Report
        key={JSON.stringify([range, filters, group, bucket, grain])}
        {...{
          range,
          filters,
          unitChoice,
          setUnit,
          group,
          setGroup,
          metric,
          setMetric,
          bucket,
          grain,
          selected,
          select,
          drill,
        }}
        setGrain={(v) => {
          select(null);
          setGrain(v);
        }}
        providers={providers.data ?? []}
        rates={{
          ...rates,
          data: rates.data?.key === rateKey ? rates.data.page : undefined,
        }}
      />
    </div>
  );
}
type Props = {
  unitChoice: string;
  setUnit: (unit: string) => void;
  selected: Window | null;
  select: (s: Window | null) => void;
  range: Window;
  filters: UsageFilters;
  group: UsageGroupBy;
  setGroup: (g: UsageGroupBy) => void;
  metric: Measure;
  setMetric: (m: Measure) => void;
  bucket: UsageQuery["bucket"];
  grain: string;
  setGrain: (s: string) => void;
  drill: (g: UsageGroupBy, id: string) => void;
  providers: ProviderInfo[];
  rates: Resource<SpendPage>;
};
function Report({
  range,
  filters,
  group,
  setGroup,
  metric,
  setMetric,
  bucket,
  grain,
  setGrain,
  drill,
  providers,
  rates,
  unitChoice,
  setUnit,
  selected,
  select,
}: Props) {
  const usage = usePoll(
    () =>
      api.usage({
        ...filters,
        sinceUnix: range.from,
        toUnix: range.to,
        bucket,
        groupBy: group,
        splitProvider: true,
      }),
    [],
    false,
  );
  const prepared = useMemo(
    () =>
      prepareCosts(
        usage.data?.buckets ?? [],
        providers,
        rates.data?.series ?? [],
      ),
    [usage.data, providers, rates.data],
  );
  const unit = prepared.units.includes(unitChoice)
    ? unitChoice
    : (prepared.units[0] ?? "USD");
  const pivot = useMemo(
    () =>
      makePivot(
        prepared.prepared,
        unit,
        range,
        usage.data?.bucket_seconds ?? 3600,
        selected,
      ),
    [prepared, unit, range, usage.data, selected],
  );
  if (usage.error)
    return (
      <Alert title="Could not load usage" color="red">
        {usage.error}{" "}
        <Button size="compact-xs" onClick={usage.reload}>
          Retry
        </Button>
      </Alert>
    );
  if (!usage.data)
    return (
      <Group role="status">
        <Loader size="sm" />
        Reading usage…
      </Group>
    );
  const tokenView = metric === "tokens";
  const scope = selected ?? range;
  const history = drillUrl("history", {
    ...filters,
    from: String(scope.from),
    to: String(scope.to),
  });
  const granularity = (
    <Select
      aria-label="Interval width"
      size="xs"
      allowDeselect={false}
      value={grain}
      data={[
        { value: "auto", label: "Auto intervals" },
        { value: "minute", label: "1 minute" },
        { value: "hour", label: "1 hour" },
        { value: "day", label: "24 hours" },
      ]}
      onChange={(v) => v && setGrain(v)}
    />
  );
  const stats = usage.data.totals;
  const incompleteTokens =
    stats.input_reports !== stats.attempts ||
    stats.output_reports !== stats.attempts;
  const tokenSummary = (
    <>
      <div>
        <span className="ux-caption">
          {incompleteTokens ? "Known token volume" : "Token volume"}
        </span>
        <h2 title={stats.input_tokens === null ? undefined : number(knownTokens(stats.input_tokens, stats.output_tokens))}>
          {big(knownTokens(stats.input_tokens, stats.output_tokens))}
        </h2>
      </div>
      <div>
        <span className="ux-caption">Input tokens</span>
        <strong title={stats.input_tokens === null ? undefined : number(stats.input_tokens)}>{big(stats.input_tokens)}</strong>
      </div>
      <div>
        <span className="ux-caption">Output tokens</span>
        <strong title={stats.output_tokens === null ? undefined : number(stats.output_tokens)}>{big(stats.output_tokens)}</strong>
      </div>
    </>
  );
  if (usage.data.truncated)
    return (
      <>
        {tokenView && (
          <section className="ux-chart">
            <div className="ux-summary">{tokenSummary}</div>
          </section>
        )}
        <Alert title="Too many intervals for this breakdown" color="orange">
          {number(usage.data.totals.attempts)} attempts in the full range.
          Choose a coarser interval, shorter range or provider to see the full
          breakdown.{granularity}
        </Alert>
      </>
    );
  if (!usage.data.totals.attempts)
    return (
      <section className="ux-empty">
        <IconChartBar />
        <h2>No attempts in this selection</h2>
        <p>
          Change the dates or clear a filter. Only saved attempts appear here.
        </p>
      </section>
    );
  const total = pivot.total,
    price = amount(total, "spend");
  return (
    <>
      <section className="ux-chart" aria-label="Usage timeline">
        <div className="ux-summary">
          {tokenView ? (
            tokenSummary
          ) : (
            <>
              <div>
                <span className="ux-caption">
                  {missing(total) || total.outside
                    ? "Known cost"
                    : "Cost for this period"}
                </span>
                <h2>
                  {total.estimatedCount > 0 ? "≈ " : ""}
                  {cash(price, unit)}
                </h2>
                <p>
                  Reported: <b>{cash(amount(total, "reported"), unit)}</b>{" "}
                  <span>·</span> Estimated:{" "}
                  <b>{cash(amount(total, "estimate"), unit)}</b>
                </p>
              </div>
              <div>
                <span className="ux-caption">Reported tokens</span>
                <strong>{number(amount(total, "tokens"))}</strong>
                <p>
                  {compact(total.inputs ? total.input : null)} in ·{" "}
                  {compact(total.outputs ? total.output : null)} out
                </p>
              </div>
            </>
          )}
        </div>
        <div className="ux-toolbar">
          <label>
            Plot{" "}
            <select
              aria-label="Plot metric"
              value={metric}
              onChange={(e) => setMetric(e.currentTarget.value as Measure)}
            >
              {Object.entries(metrics).map(([v, s]) => (
                <option key={v} value={v}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div>
            {!tokenView && prepared.units.length > 1 && (
              <Select
                label="Cost unit"
                size="xs"
                allowDeselect={false}
                value={unit}
                data={prepared.units}
                onChange={(v) => v && setUnit(v)}
              />
            )}
            {granularity}
          </div>
        </div>
        <UsageActivity
          key={`${metric}/${unit}`}
          step={pivot.step}
          bins={pivot.bins}
          {...{ metric, unit, selected }}
          onSelect={select}
        />
        <div className="ux-coverage" role="status">
          {!tokenView &&
            (rates.error ? (
              <span>
                Balance estimates unavailable.{" "}
                <button className="ux-link" onClick={rates.reload}>
                  Retry
                </button>
              </span>
            ) : !rates.data ? (
              <span>Reading balance rates…</span>
            ) : missing(total) > 0 ? (
              <span>
                No price for {number(missing(total))} of{" "}
                {number(total.attempts)} attempts.
              </span>
            ) : null)}
          {!tokenView && total.outside > 0 && (
            <span>
              {number(total.outside)} attempts use another unit. Change Cost
              unit to see them; currencies are not converted.
            </span>
          )}
          {incompleteTokens && (
            <span>
              Some token counts are missing. Totals include only reported
              tokens.
            </span>
          )}
          {!tokenView && rates.data?.truncated && (
            <span>Balance reference is partial.</span>
          )}
        </div>
      </section>
      <section className="ux-breakdown">
        <div className="ux-table-head">
          <div>
            <h2>Breakdown</h2>
            <p>
              {selected
                ? `${stamp(selected.from)} – ${stamp(selected.to)}`
                : "Entire selected period"}{" "}
              {selected && (
                <button className="ux-link" onClick={() => select(null)}>
                  Clear interval
                </button>
              )}
            </p>
          </div>
          <a
            href={history}
            onClick={() =>
              window.history.replaceState(
                null,
                "",
                drillUrl("usage", {
                  ...filters,
                  group,
                  metric,
                  from: String(range.from),
                  to: String(range.to),
                }),
              )
            }
          >
            View requests <IconArrowRight size={14} />
          </a>
        </div>
        <Breakdown
          key={`${group}/${tokenView ? "tokens" : unit}`}
          rows={pivot.groups}
          {...{ group, setGroup, drill, unit, tokenView }}
          compare={!!filters.family && group === "provider"}
        />
      </section>
    </>
  );
}
type Column =
  | "tokens"
  | "name"
  | "input"
  | "output"
  | "reported"
  | "estimate"
  | "spend"
  | "perMillion";
function Breakdown({
  rows,
  group,
  setGroup,
  drill,
  unit,
  compare,
  tokenView,
}: {
  rows: Map<string, Cell>;
  group: UsageGroupBy;
  setGroup: Props["setGroup"];
  drill: Props["drill"];
  unit: string;
  compare: boolean;
  tokenView: boolean;
}) {
  const [sort, setSort] = useState<Column>(
      tokenView ? "tokens" : compare ? "perMillion" : "spend",
    ),
    [asc, setAsc] = useState(!tokenView && compare),
    [limit, setLimit] = useState(40),
    [search, setSearch] = useState("");
  const numeric = (c: Cell, k: Column) =>
    k === "perMillion"
      ? perMillion(c)
      : k === "input"
        ? c.inputs
          ? c.input
          : null
        : k === "output"
          ? c.outputs
            ? c.output
            : null
          : k === "name"
            ? null
            : amount(c, k);
  const filtered = [...rows]
    .filter(([s]) => s.toLowerCase().includes(search.trim().toLowerCase()))
    .sort(([a, x], [b, y]) => {
      if (sort === "name") return (asc ? 1 : -1) * a.localeCompare(b);
      const l = numeric(x, sort),
        r = numeric(y, sort);
      return l === r
        ? a.localeCompare(b)
        : l == null
          ? 1
          : r == null
            ? -1
            : (asc ? 1 : -1) * (l - r);
    });
  const rates = [...rows.values()]
    .map(perMillion)
    .filter((n): n is number => n !== null);
  const lowest = compare && rates.length >= 2 ? Math.min(...rates) : null;
  // The table as it stands, with exact numbers instead of rounded text.
  const exportCsv = () => {
    const raw = (value: number | null) => (value === null ? "" : String(value));
    const head = [
      dimensions[group],
      ...(tokenView
        ? ["Total tokens"]
        : ["Cost", "Cost per 1M", "Reported", "Estimated"]),
      "Input",
      "Output",
    ];
    const lines = filtered.map(([id, cell]) => [
      id,
      ...(tokenView
        ? [raw(amount(cell, "tokens"))]
        : [raw(amount(cell, "spend")), raw(perMillion(cell)), raw(amount(cell, "reported")), raw(amount(cell, "estimate"))]),
      raw(cell.inputs ? cell.input : null),
      raw(cell.outputs ? cell.output : null),
    ]);
    const csv = [head, ...lines]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const stamp = new Date().toISOString().slice(0, 16);
    download(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }), `usage-by-${group}-${stamp}.csv`);
  };
  const col = (key: Column, label: string) => (
    <th
      key={key}
      aria-sort={sort === key ? (asc ? "ascending" : "descending") : undefined}
    >
      <button
        onClick={() => {
          setAsc(sort === key ? !asc : key === "name" || key === "perMillion");
          setSort(key);
        }}
      >
        {label} {sort === key ? (asc ? "↑" : "↓") : ""}
      </button>
    </th>
  );
  return (
    <>
      <div className="ux-table-controls">
        <label>
          Group by{" "}
          <select
            aria-label="Group by"
            value={group}
            onChange={(e) => setGroup(e.currentTarget.value as UsageGroupBy)}
          >
            {Object.entries(dimensions).map(([v, s]) => (
              <option value={v} key={v}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <TextInput
          size="xs"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setLimit(40);
          }}
          aria-label="Find a row"
          placeholder="Find a row"
        />
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          className="ux-export"
          leftSection={<IconDownload size={13} />}
          disabled={!filtered.length}
          onClick={exportCsv}
          title="Download this table as CSV, exact numbers"
        >
          CSV
        </Button>
      </div>
      <div
        className="ux-scroll"
        role="region"
        aria-label="Usage breakdown table"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              {col("name", dimensions[group])}
              {tokenView ? (
                col("tokens", "Total tokens")
              ) : (
                <>
                  {col("spend", "Cost")}
                  {col("perMillion", "Cost / 1M")}
                  {col("reported", "Reported")}
                  {col("estimate", "Estimated")}
                </>
              )}
              {col("input", "Input")}
              {col("output", "Output")}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map(([id, c]) => (
              <tr key={id}>
                <th scope="row">
                  <button onClick={() => drill(group, id)}>
                    {id} <IconArrowRight size={13} />
                  </button>
                </th>
                {tokenView ? (
                  <td>
                    {number(amount(c, "tokens"))}
                    {(c.inputs !== c.attempts || c.outputs !== c.attempts) && (
                      <small>Incomplete</small>
                    )}
                  </td>
                ) : (
                  <>
                    <td>
                      {c.estimatedCount ? "≈ " : ""}
                      {cash(amount(c, "spend"), unit)}
                      {missing(c) + c.outside > 0 && (
                        <small>Partial coverage</small>
                      )}
                    </td>
                    <td>
                      {perMillion(c) !== null && c.estimatedCount ? "≈ " : ""}
                      {cash(perMillion(c), unit)}
                      {lowest !== null && perMillion(c) !== null && (
                        <small>
                          {perMillion(c) === lowest
                            ? "Lowest observed"
                            : lowest > 0
                              ? `${number((perMillion(c)! / lowest - 1) * 100)}% above lowest`
                              : null}
                        </small>
                      )}
                    </td>
                    <td>{cash(amount(c, "reported"), unit)}</td>
                    <td>{cash(amount(c, "estimate"), unit)}</td>
                  </>
                )}
                <td>{number(numeric(c, "input"))}</td>
                <td>{number(numeric(c, "output"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length && <p>No matching rows.</p>}
      {filtered.length > limit && (
        <Button
          size="compact-xs"
          variant="light"
          onClick={() => setLimit(limit + 40)}
        >
          Show more ({filtered.length - limit})
        </Button>
      )}
      {!tokenView && (
        <p className="ux-footnote">
          {compare &&
            "Connections are matched by the catalog model key. Choose Exact model listing to inspect individual aliases. "}
          Cost / 1M uses the actual input and output mix, not a list price. It
          is shown only when all selected attempts have a cost in the same unit
          and both token counts. Estimates use the connection’s balance changes
          during the report period. Activity outside this router can affect the
          rate.
        </p>
      )}
    </>
  );
}
