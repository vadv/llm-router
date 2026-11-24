import { useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Drawer,
  Group,
  Select,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { IconArrowUpRight, IconChartLine, IconRefresh } from "@tabler/icons-react";
import { api, type Observation } from "../api";
import {
  balanceReading,
  balanceRisk,
  burnPerDay,
  daysLeft,
  readingGroups,
} from "../components/balance-math";
import { Chart } from "../components/chart";
import { ModelHoverCard } from "../components/model-card";
import { ProviderLogo } from "../components/provider-logo";
import { PageHeader, RelTime } from "../components/ui";
import { compact, dateTime, money } from "../format";
import { routeParam, usePoll } from "../hooks";
import { looksLikeModelId } from "../model-key";
import "./balances.css";

const FILTERS = ["All providers", "Low", "Exhausted"] as const;
type Filter = (typeof FILTERS)[number];
const WINDOWS = ["5h", "daily", "week", "weekly", "monthly"];
const windowRank = (name: string) =>
  WINDOWS.includes(name) ? WINDOWS.indexOf(name) : WINDOWS.length;
const id = (row: Observation) =>
  JSON.stringify([row.provider_id, row.resource, row.metric, row.unit, row.window]);
const severity = (row: Observation) => ({ exhausted: 0, low: 1, ok: 2 })[balanceRisk(row)];
function unitOf(row: Observation) {
  if (row.metric === "ratio") return "%";
  if (row.unit === "token" || row.unit === "request") return `${row.unit}s`;
  return row.unit ?? (row.metric === "money" ? "" : row.metric);
}
const numberOf = (row: Observation, n: number) =>
  row.metric === "money" || ["CNY", "USD"].includes(row.unit ?? "") ? money(n) : compact(n);

export function BalancesPage() {
  const state = usePoll(api.observations, []);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("All providers");
  const [selected, setSelected] = useState<string | null>(null);
  const providers = useMemo(() => {
    const map = new Map<string, Observation[]>();
    for (const row of state.data ?? []) {
      const list = map.get(row.provider_id);
      if (list) list.push(row);
      else map.set(row.provider_id, [row]);
    }
    return [...map]
      .map(([provider, rows]) => ({
        provider,
        rows,
        low: rows.some((r) => balanceRisk(r) === "low"),
        exhausted: rows.some((r) => balanceRisk(r) === "exhausted"),
      }))
      .sort(
        (a, b) =>
          Number(b.exhausted) - Number(a.exhausted) ||
          Number(b.low) - Number(a.low) ||
          a.provider.localeCompare(b.provider),
      );
  }, [state.data]);
  const matches = (p: (typeof providers)[number], f: Filter) =>
    f === "All providers" || (f === "Low" ? p.low : p.exhausted);
  const scoped = routeParam("provider");
  const scope = scoped ? providers.filter(p => p.provider === scoped) : providers;
  const visible = scope.filter((p) => matches(p, filter));
  const current = state.data?.find((r) => id(r) === selected);
  const [siblings, setSiblings] = useState<{ value: string; label: string }[]>([]);
  const show = (rows: Observation[]) => {
    setSelected(id(rows[0]));
    setSiblings(rows.map((row) => ({ value: id(row), label: row.resource })));
  };
  // Ask the core to poll every connection now; the page then reads the result.
  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.refresh("balances");
      await state.reload();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Balances"
        description="Funds and quotas as each connection last reported them."
        actions={
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconRefresh size={14} />}
            loading={refreshing}
            onClick={refresh}
          >
            Refresh
          </Button>
        }
      />
      <div
        className="balance-filters"
        role="group"
        aria-label="Filter providers by reported balance"
      >
        {scoped && <Button component="a" href="#/balances" size="compact-xs" variant="light" aria-label="Show all connections">{scoped} ×</Button>}
        {FILTERS.map((f) => (
          <UnstyledButton
            key={f}
            className="balance-filter"
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {f !== "All providers" && <i data-risk={f.toLowerCase()} />}
            {f}
            <b>{state.data ? scope.filter((p) => matches(p, f)).length : "—"}</b>
          </UnstyledButton>
        ))}
      </div>
      {state.error && (
        <Alert
          color="red"
          mb="sm"
          title={
            state.data
              ? "Could not refresh balances · showing last readings"
              : "Could not load balances"
          }
        >
          {state.error}
        </Alert>
      )}
      {!state.data ? (
        !state.error && (
          <Text role="status" c="dimmed" size="sm">
            Loading balances…
          </Text>
        )
      ) : visible.length === 0 ? (
        <div className="balance-empty">
          <IconChartLine size={18} />
          <h3>
            {scoped && !scope.length ? `No balance readings for ${scoped}` : providers.length
              ? `No providers marked ${filter.toLowerCase()}`
              : "No balance readings yet"}
          </h3>
          <Text size="sm" c="dimmed">
            {providers.length
              ? "This filter checks the latest reported amounts, not forecasts."
              : "Balances appear when a connection reports funds or a quota. No reading is not a zero balance."}
          </Text>
          {scope.length > 0 && (
            <Button mt="sm" size="xs" variant="light" onClick={() => setFilter("All providers")}>
              Show all providers
            </Button>
          )}
        </div>
      ) : (
        <div className="balance-grid">
          {visible.map((p) => (
            <ProviderCard key={p.provider} {...p} show={show} />
          ))}
        </div>
      )}
      <Drawer
        opened={!!current}
        onClose={() => setSelected(null)}
        title="Balance history"
        position="right"
        size="md"
      >
        {current && (
          <>
            <Group mb="md">
              <ProviderLogo providerId={current.provider_id} size={24} />
              <Text fw={600}>{current.provider_id}</Text>
              <Badge variant="default">{current.window ?? "Account"}</Badge>
            </Group>
            {siblings.length > 1 && (
              <Select
                mb="md"
                label="Resource history"
                value={selected}
                onChange={setSelected}
                allowDeselect={false}
                searchable
                data={siblings}
              />
            )}
            <History key={id(current)} row={current} />
          </>
        )}
      </Drawer>
    </>
  );
}

type CardProps = {
  provider: string;
  rows: Observation[];
  low: boolean;
  exhausted: boolean;
  show: (rows: Observation[]) => void;
};
function ProviderCard({ provider, rows, low, exhausted, show }: CardProps) {
  const windows = new Map<string, Observation[]>();
  const accounts = rows.filter((r) => r.window === null);
  for (const row of rows)
    if (row.window !== null) {
      const bucket = windows.get(row.window);
      if (bucket) bucket.push(row);
      else windows.set(row.window, [row]);
    }
  return (
    <article className="balance-card" aria-label={`${provider} balances`}>
      <header>
        <div className="balance-brand">
          <ProviderLogo providerId={provider} size={24} />
          <h2>{provider}</h2>
        </div>
        <Group gap={4}>
          {exhausted && (
            <Badge color="red" variant="light" size="xs">
              Exhausted
            </Badge>
          )}
          {low && (
            <Badge color="orange" variant="light" size="xs">
              Low
            </Badge>
          )}
        </Group>
      </header>
      {accounts.length > 0 && (
        <section className="balance-account">
          <h3>Account</h3>
          {accounts.map((row) => (
            <Reading key={id(row)} rows={[row]} show={show} section="account" sole={rows.length === 1} />
          ))}
        </section>
      )}
      {[...windows]
        .sort(([a], [b]) => windowRank(a) - windowRank(b) || a.localeCompare(b))
        .map(([name, group]) => (
          <WindowGroup key={name} name={name} rows={group} show={show} sole={rows.length === 1} />
        ))}
      <footer>
        Last reading <RelTime unix={rows.reduce((t, r) => Math.max(t, r.observed_at_unix), 0)} />
      </footer>
    </article>
  );
}

function WindowGroup({
  name,
  rows,
  show,
  sole,
}: {
  name: string;
  rows: Observation[];
  show: CardProps["show"];
  sole: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const groups = readingGroups(rows).sort(
    ([a], [b]) =>
      severity(a) - severity(b) ||
      a.metric.localeCompare(b.metric) ||
      a.resource.localeCompare(b.resource),
  );
  return (
    <section className="balance-window">
      <h3>{name} quota</h3>
      {(expanded ? groups : groups.slice(0, 3)).map((group) => (
        <Reading key={id(group[0])} rows={group} show={show} section={name} sole={sole} />
      ))}
      {groups.length > 3 && (
        <Button
          variant="subtle"
          size="compact-xs"
          mt="xs"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show fewer readings" : `Show ${groups.length - 3} more readings`}
        </Button>
      )}
    </section>
  );
}

function Reading({
  rows,
  show,
  section,
  sole,
}: {
  rows: Observation[];
  show: CardProps["show"];
  /// The heading the reading sits under. A resource that only repeats it
  /// ("Account", then "account") is left out.
  section?: string;
  /// The connection's only reading: the card header already says how it
  /// stands, so the reading does not repeat it.
  sole?: boolean;
}) {
  const row = rows[0];
  const { left, used, limit, percentLeft } = balanceReading(row);
  const risk = balanceRisk(row);
  const unit = unitOf(row);
  const percent = unit === "%";
  const suffix = percent ? "%" : unit ? ` ${unit}` : "";
  const echo = !!section && row.resource.trim().toLowerCase() === section.trim().toLowerCase();
  return (
    <div className="balance-reading" data-risk={risk}>
      <div className="balance-reading-head">
        <div>
          {!echo && (
            <span className="balance-resource">
              {rows.length > 1 ? (
                `${row.metric} · ${rows.length} matching readings`
              ) : (
                <ModelHoverCard
                  upstreamId={looksLikeModelId(row.resource) ? row.resource : null}
                  providerId={row.provider_id}
                >
                  {row.resource}
                </ModelHoverCard>
              )}
            </span>
          )}
          <div className="balance-amount">
            {left !== null ? (
              <>
                <strong>
                  {numberOf(row, left)}
                  {percent && "%"}
                </strong>
                <span>{unit && !percent ? `${unit} left` : "left"}</span>
              </>
            ) : used !== null ? (
              <>
                <strong>
                  {numberOf(row, used)}
                  {percent && "%"}
                </strong>
                <span>{unit && !percent ? `${unit} used` : "used"}</span>
              </>
            ) : (
              <span>Amount not reported</span>
            )}
          </div>
        </div>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          rightSection={<IconArrowUpRight size={12} />}
          aria-label={`History for ${row.provider_id} ${row.resource} ${row.metric} ${row.window ?? "account"}`}
          onClick={() => show(rows)}
        >
          History
        </Button>
      </div>
      {percentLeft !== null && (
        <div
          className="balance-meter"
          role="meter"
          aria-label="Quota remaining"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentLeft}
        >
          <i style={{ width: `${percentLeft}%` }} />
        </div>
      )}
      <div className="balance-meta">
        {risk !== "ok" && !sole && (
          <Badge size="xs" color={risk === "low" ? "orange" : "red"} variant="light">
            {risk}
          </Badge>
        )}
        {used !== null && left !== null && (
          <span>
            {numberOf(row, used)}
            {limit !== null && row.metric !== "ratio" ? ` of ${numberOf(row, limit)}` : ""}
            {suffix} used
          </span>
        )}
        {used === null && limit !== null && (
          <span>
            Limit {numberOf(row, limit)}
            {suffix}
          </span>
        )}
        {row.resets_at_unix !== null && <span>Resets {dateTime(row.resets_at_unix)}</span>}
      </div>
    </div>
  );
}

function History({ row }: { row: Observation }) {
  const history = usePoll(
    () =>
      api.observationHistory({
        providerId: row.provider_id,
        resource: row.resource,
        metric: row.metric,
        unit: row.unit ?? "",
        window: row.window ?? "",
        limit: 500,
      }),
    [row.provider_id, row.resource, row.metric, row.unit, row.window],
  );
  const readings = history.data ?? [];
  const reading = balanceReading(row);
  const mode = reading.left !== null ? "left" : "used";
  const exact = (reported: string | null, value: number | null) =>
    value === null
      ? "Not reported"
      : `${row.metric !== "ratio" && reported !== null && reported.trim() && Number.isFinite(Number(reported)) ? reported : Number(value.toPrecision(12))} ${unitOf(row)}`.trim();
  const points = readings.map((r) => ({
    unix: r.observed_at_unix,
    value: balanceReading(r)[mode],
  }));
  const burn = burnPerDay(row, readings);
  const days = daysLeft(row, readings);
  return (
    <Stack gap="sm">
      <div>
        <Text className="wrap-anywhere" fw={600}>
          {row.resource}
        </Text>
        <Text size="xs" c="dimmed">
          {row.metric} · {unitOf(row)} {mode} · last seen {dateTime(row.observed_at_unix)}
        </Text>
      </div>
      <dl className="balance-facts" aria-label="Latest reading">
        <dt>Remaining</dt>
        <dd>{exact(row.remaining, reading.left)}</dd>
        <dt>Used</dt>
        <dd>{exact(row.usage, reading.used)}</dd>
        <dt>Limit</dt>
        <dd>{exact(row.limit, reading.limit)}</dd>
        {row.resets_at_unix !== null && (
          <>
            <dt>Resets</dt>
            <dd>{dateTime(row.resets_at_unix)}</dd>
          </>
        )}
      </dl>
      {history.error && (
        <Alert color="red" title="Could not refresh history">
          {history.error}
        </Alert>
      )}
      {!history.data ? (
        !history.error && (
          <Text size="sm" role="status">
            Loading readings…
          </Text>
        )
      ) : points.filter((p) => p.value !== null).length < 2 ? (
        <Text size="sm" c="dimmed">
          Two measured readings are needed to draw a trend.
        </Text>
      ) : (
        <Chart
          height={160}
          legend={false}
          zeroBased={row.metric === "ratio"}
          format={(v) => numberOf(row, v)}
          series={[
            { label: `${unitOf(row)} ${mode}`, points, color: "var(--mantine-color-teal-5)" },
          ]}
          markers={row.resets_at_unix ? [{ unix: row.resets_at_unix, label: "reset" }] : []}
        />
      )}
      {burn !== null && burn > 0 && (
        <Alert
          icon={<IconChartLine size={18} />}
          color={days !== null && days < 7 ? "orange" : "teal"}
          title="Estimated burn rate"
        >
          {numberOf(row, burn)} {unitOf(row)} per day
          {days !== null && ` · about ${compact(days)} days left at this rate`}.
        </Alert>
      )}
    </Stack>
  );
}
