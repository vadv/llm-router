import { useEffect, useMemo, useState } from "react";
import { Text } from "@mantine/core";
import { IconChevronDown } from "@tabler/icons-react";
import { api, type Observation } from "../api";
import {
  TIGHT_SPARE,
  balanceReading,
  limitOutlook,
  outlookRank,
  readingGroups,
  type Outlook,
} from "../components/balance-math";
import { numberOf, unitOf } from "../components/balance-text";
import { Chart } from "../components/chart";
import { ModelHoverCard } from "../components/model-card";
import { ProviderLogo } from "../components/provider-logo";
import { PageHeader } from "../components/ui";
import { compact, dateTime, dayTime } from "../format";
import { routeParam, useNow, usePoll } from "../hooks";
import { looksLikeModelId } from "../model-key";
import { Drill, SourceNote } from "./overview-links";
import "./limits.css";

const HOUR = 3600;
const DAY = 86_400;
/// The pace is the pace of the last day, in a row and in its detail alike.
const MEASURED = 26 * HOUR;
const RECENT_POINTS = 150;
/// The windows a provider names by length: the resets before the next one
/// can be placed from it.
const WINDOW_SECONDS: Record<string, number> = {
  "5h": 5 * HOUR,
  daily: DAY,
  week: 7 * DAY,
  weekly: 7 * DAY,
};

/// One reading as the balances page shows it.
const id = (row: Observation) =>
  JSON.stringify([row.provider_id, row.resource, row.metric, row.unit, row.window]);
const historyQuery = (row: Observation) => ({
  providerId: row.provider_id,
  resource: row.resource,
  metric: row.metric,
  unit: row.unit ?? "",
  window: row.window ?? "",
});

type Tone = "off" | "short" | "tight" | "drain" | "ok" | "none";
const toneOf = (outlook: Outlook): Tone => {
  switch (outlook.kind) {
    case "exhausted":
      return "off";
    case "short":
      return "short";
    case "lasts":
      if (outlook.resetsAt === null) return "drain";
      return outlook.spareShare !== null && outlook.spareShare < TIGHT_SPARE ? "tight" : "ok";
    case "quiet":
      return "ok";
    case "unknown":
      return "none";
  }
};
const hasPace = (outlook: Outlook): outlook is Extract<Outlook, { pace: unknown }> =>
  outlook.kind === "short" || outlook.kind === "lasts";

/// A number for a sentence: two digits that matter and no more.
function rough(n: number): string {
  return String(Number(n.toFixed(Math.abs(n) >= 10 ? 0 : 1)));
}

/// How long until a moment: "5.5 hours", "21 days".
function until(unix: number, now: number): string {
  const hours = (unix - now) / HOUR;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `${rough(hours)} hours`;
  return `${rough(hours / 24)} days`;
}

/// An amount of a reading as a sentence writes it: money with its
/// decimals, the rest to three digits that matter.
function amountOf(row: Observation, n: number): string {
  const unit = unitOf(row);
  const moneyish = row.metric === "money" || ["CNY", "USD"].includes(row.unit ?? "");
  return `${moneyish ? numberOf(row, n) : compact(Number(rough(n)))}${unit ? ` ${unit}` : ""}`;
}

/// A rate as a sentence writes it: per hour for a window that lasts hours,
/// per day for the rest.
function rateText(row: Observation, perDay: number): string {
  return row.window === "5h"
    ? `${amountOf(row, perDay / 24)} an hour`
    : `${amountOf(row, perDay)} a day`;
}

/// The answer for one reading in a sentence: the verdict, then why.
function verdict(
  row: Observation,
  outlook: Outlook,
  now: number,
): { lead: string; detail: string } {
  const amount = (n: number) => amountOf(row, n);
  const reset =
    outlook.resetsAt !== null
      ? `resets ${dayTime(outlook.resetsAt, now)} (in ${until(outlook.resetsAt, now)})`
      : "";
  const pace = hasPace(outlook) ? rateText(row, outlook.pace.perDay) : "";
  switch (outlook.kind) {
    case "exhausted":
      return { lead: "Nothing left", detail: reset || "No reset is reported" };
    case "unknown":
      return outlook.why === "amount"
        ? { lead: "No amount reported", detail: "The connection does not say how much is left." }
        : {
            lead: "Too early to tell",
            detail: "An hour of readings since the last refill is needed for a pace.",
          };
    case "quiet":
      return {
        lead: "Nothing spent",
        detail: `No use in the last ${Math.round(outlook.hours)} hours${reset ? ` · ${reset}` : ""}`,
      };
    case "short":
      return {
        lead: "Won't last until the reset",
        detail: `Empty in ${until(outlook.runsOutAt, now)} at ${pace} · about ${amount(outlook.shortfall)} short · ${reset}`,
      };
    case "lasts":
      if (outlook.resetsAt === null) {
        return {
          lead: `Lasts about ${until(outlook.runsOutAt, now)}`,
          detail: `Empty around ${dayTime(outlook.runsOutAt, now)} at ${pace}`,
        };
      }
      const share =
        outlook.spareShare !== null
          ? ` (${Math.round(outlook.spareShare * 100)}% of the limit)`
          : "";
      return {
        lead: toneOf(outlook) === "tight" ? "Lasts, barely" : "Lasts until the reset",
        detail: `About ${amount(outlook.spare ?? 0)} left at the reset${share} · ${pace} · ${reset}`,
      };
  }
}

/// The last day of every series: one small request each, read again every
/// five minutes. A pace changes slowly; the latest amounts arrive with the
/// page's own poll.
function useHistories(groups: Observation[][]) {
  const key = groups.map((group) => id(group[0])).join("\n");
  const [state, setState] = useState<{
    data: Record<string, Observation[]>;
    loaded: boolean;
    error: string | null;
  }>({ data: {}, loaded: false, error: null });
  useEffect(() => {
    if (!key) return;
    let current = true;
    const load = async () => {
      try {
        const lists = await Promise.all(
          groups.map((group) =>
            api.observationHistory({
              ...historyQuery(group[0]),
              sinceUnix: Math.floor(Date.now() / 1000) - MEASURED,
              limit: RECENT_POINTS,
            }),
          ),
        );
        if (!current) return;
        setState({
          data: Object.fromEntries(
            groups.map((group, index) => [id(group[0]), lists[index]]),
          ),
          loaded: true,
          error: null,
        });
      } catch (failure) {
        if (current) {
          setState((before) => ({
            ...before,
            loaded: true,
            error: failure instanceof Error ? failure.message : String(failure),
          }));
        }
      }
    };
    void load();
    const timer = window.setInterval(
      () => !document.hidden && void load(),
      5 * 60_000,
    );
    return () => {
      current = false;
      window.clearInterval(timer);
    };
    // The series are read when the set of them changes, not on every poll of
    // their latest amounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export function LimitsPage() {
  const state = usePoll(api.observations, []);
  const now = useNow(30_000) / 1000;
  const groups = useMemo(() => readingGroups(state.data ?? []), [state.data]);
  const histories = useHistories(groups);
  const [opened, setOpened] = useState<string | null>(() => routeParam("r"));
  const [showQuiet, setShowQuiet] = useState(false);
  const items = groups
    .map((group) => {
      const row = group[0];
      const outlook = limitOutlook(row, histories.data[id(row)] ?? [], now);
      return { row, count: group.length, outlook, rank: outlookRank(outlook) };
    })
    .sort((a, b) => a.rank - b.rank || id(a.row).localeCompare(id(b.row)));
  const empty = items.filter((item) => item.outlook.kind === "exhausted").length;
  const short = items.filter((item) => item.outlook.kind === "short").length;
  const tight = items.filter((item) => toneOf(item.outlook) === "tight").length;
  const quiet = items.filter((item) => item.outlook.kind === "quiet");
  const shown = items.filter((item) => item.outlook.kind !== "quiet");
  const summary = [
    empty && `${empty} empty`,
    short && `${short} won't last until ${short === 1 ? "its" : "their"} reset`,
    tight && `${tight} nearly empty at ${tight === 1 ? "its" : "their"} reset`,
  ].filter(Boolean);
  const description = !state.data
    ? "Whether each balance and quota will last, at the pace of the recent readings."
    : summary.length
      ? `${summary.join(" · ")} · ${items.length} readings in all`
      : `Nothing is running out · ${items.length} readings in all`;
  return (
    <>
      <PageHeader
        title="Limits"
        description={description}
        actions={<Drill href="#/balances">Balances</Drill>}
      />
      <SourceNote source={state} name="balances" />
      {histories.error && (
        <p className="limit-note" role="status">
          Paces could not be read: {histories.error}
        </p>
      )}
      {state.data && items.length === 0 ? (
        <div className="balance-empty">
          <Text size="sm" c="dimmed">
            Balances appear when a connection reports funds or a quota. No
            reading is not a zero balance.
          </Text>
        </div>
      ) : (
        <ul className="limit-list" aria-label="Balances and quotas, worst first">
          {shown.map((item) => (
            <LimitRow
              key={id(item.row)}
              {...item}
              now={now}
              ready={histories.loaded}
              recent={histories.data[id(item.row)]}
              open={opened === id(item.row)}
              toggle={() => setOpened(opened === id(item.row) ? null : id(item.row))}
            />
          ))}
          {quiet.length > 0 && (
            <li className="limit-fold-row">
              <button
                type="button"
                className="limit-fold"
                aria-expanded={showQuiet}
                onClick={() => setShowQuiet(!showQuiet)}
              >
                {quiet.length} readings with nothing spent
                <IconChevronDown className="limit-chevron" size={16} aria-hidden />
              </button>
            </li>
          )}
          {showQuiet &&
            quiet.map((item) => (
              <LimitRow
                key={id(item.row)}
                {...item}
                now={now}
                ready={histories.loaded}
                recent={histories.data[id(item.row)]}
                open={opened === id(item.row)}
                toggle={() => setOpened(opened === id(item.row) ? null : id(item.row))}
              />
            ))}
        </ul>
      )}
    </>
  );
}

function LimitRow({
  row,
  count,
  outlook,
  now,
  ready,
  recent,
  open,
  toggle,
}: {
  row: Observation;
  /// Readings that show the same amounts: one account counter a provider
  /// reports once per model.
  count: number;
  outlook: Outlook;
  now: number;
  /// The series have been read; until then no verdict is final.
  ready: boolean;
  /// The last day of the series the verdict was read from, for the detail.
  recent: Observation[] | undefined;
  open: boolean;
  toggle: () => void;
}) {
  const { left, percentLeft } = balanceReading(row);
  const unit = unitOf(row);
  const percent = unit === "%";
  const { lead, detail } = verdict(row, outlook, now);
  const pace = hasPace(outlook) ? rateText(row, outlook.pace.perDay) : "—";
  const measured = "pace" in outlook ? `over ${Math.round(outlook.pace.hours)} hours` : "";
  const resource = count > 1 ? `${row.metric} · ${count} readings` : row.resource;
  return (
    <li
      className="limit-row"
      data-tone={ready ? toneOf(outlook) : "none"}
      aria-busy={!ready}
    >
      <button
        type="button"
        className="limit-row-toggle"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="limit-who">
          <ProviderLogo providerId={row.provider_id} size={20} />
          <span className="limit-names">
            <b>{row.provider_id}</b>
            <span className="limit-resource">
              {count === 1 && looksLikeModelId(row.resource) ? (
                <ModelHoverCard upstreamId={row.resource} providerId={row.provider_id}>
                  {row.resource}
                </ModelHoverCard>
              ) : (
                resource
              )}
            </span>
          </span>
          <span className="limit-window">{row.window ?? "Account"}</span>
        </span>
        <span className="limit-left">
          {left !== null ? (
            <>
              <strong>
                {numberOf(row, left)}
                {percent && "%"}
              </strong>
              <small>{unit && !percent ? `${unit} left` : "left"}</small>
            </>
          ) : (
            <small>Amount not reported</small>
          )}
          {percentLeft !== null && (
            <i className="limit-meter" aria-hidden="true">
              <i style={{ width: `${percentLeft}%` }} />
            </i>
          )}
        </span>
        <span className="limit-pace">
          {pace}
          {measured && <small>{measured}</small>}
        </span>
        <span className="limit-verdict">
          <b>{ready ? lead : "Reading the series…"}</b>
          <span>{ready ? detail : ""}</span>
        </span>
        <IconChevronDown className="limit-chevron" size={16} aria-hidden />
      </button>
      {open && <LimitDetail row={row} recent={recent} />}
    </li>
  );
}

/// Everything known about one reading: the verdict, the facts of the latest
/// reading and the series behind it. The balances drawer shows it for the
/// reading it was opened for, the Limits page for the row that is open, with
/// `recent` being the day that row's verdict was read from, so both say
/// the same.
export function LimitDetail({
  row,
  recent: given,
}: {
  row: Observation;
  recent?: Observation[];
}) {
  const now = useNow(30_000) / 1000;
  const history = usePoll(
    () => api.observationHistory({ ...historyQuery(row), limit: 500 }),
    [row.provider_id, row.resource, row.metric, row.unit, row.window],
    false,
  );
  // The chart shows all it can; the verdict is read from the last day.
  const readings = history.data ?? [];
  const recent = given ?? readings.filter((r) => r.observed_at_unix >= now - MEASURED);
  const outlook = limitOutlook(row, recent, now);
  const { left, used, limit } = balanceReading(row);
  const { lead, detail } = verdict(row, outlook, now);
  const unit = unitOf(row);
  const exact = (reported: string | null, value: number | null) =>
    value === null
      ? "Not reported"
      : `${row.metric !== "ratio" && reported !== null && reported.trim() && Number.isFinite(Number(reported)) ? reported : Number(value.toPrecision(12))} ${unit}`.trim();
  // A reading that reports only what was used has no "left" to draw.
  const mode = readings.some((r) => balanceReading(r).left !== null) ? "left" : "used";
  const points = readings
    .map((r) => ({ unix: r.observed_at_unix, value: balanceReading(r)[mode] }))
    .filter((point) => point.value !== null);
  const first = points[0]?.unix ?? now;
  const last = points.at(-1)?.unix ?? now;
  const forecast = left !== null ? forecastOf(outlook, left, now) : null;
  return (
    <div className="limit-detail" data-tone={toneOf(outlook)}>
      <p className="limit-verdict-line">
        <b>{history.data ? lead : "Reading the series…"}</b>{" "}
        <span>{history.data ? detail : ""}</span>
      </p>
      <dl className="balance-facts" aria-label="Latest reading">
        <dt>Remaining</dt>
        <dd>{exact(row.remaining, left)}</dd>
        <dt>Used</dt>
        <dd>{exact(row.usage, used)}</dd>
        <dt>Limit</dt>
        <dd>{exact(row.limit, limit)}</dd>
        {row.resets_at_unix !== null && (
          <>
            <dt>Resets</dt>
            <dd>{dateTime(row.resets_at_unix)}</dd>
          </>
        )}
        <dt>Last seen</dt>
        <dd>{dateTime(row.observed_at_unix)}</dd>
      </dl>
      {history.error && (
        <p className="limit-note" role="status">
          Could not read the history: {history.error}
        </p>
      )}
      {!history.data ? (
        !history.error && (
          <Text size="sm" role="status">
            Loading readings…
          </Text>
        )
      ) : points.length < 2 ? (
        <Text size="sm" c="dimmed">
          Two measured readings are needed to draw a trend.
        </Text>
      ) : (
        <Chart
          height={200}
          legend={false}
          zeroBased={row.metric === "ratio" || forecast !== null}
          format={(value) => numberOf(row, value)}
          series={[
            {
              label: `${mode === "left" ? "Left" : "Used"}${unit ? ` ${unit}` : ""}`,
              points,
              color: "var(--mantine-color-teal-5)",
            },
            ...(forecast
              ? [{ label: "at this pace", color: "var(--tone)", points: forecast, dashed: true }]
              : []),
          ]}
          markers={[
            ...pastResets(row, first),
            ...(outlook.resetsAt !== null &&
            outlook.resetsAt <= (forecast?.at(-1)?.unix ?? last)
              ? [{ unix: outlook.resetsAt, label: "reset" }]
              : []),
            ...(outlook.kind === "short" ? [{ unix: outlook.runsOutAt, label: "empty" }] : []),
          ]}
        />
      )}
      {history.data && forecast && (
        <Text size="xs" c="dimmed">
          Dashed line: at the pace of the last day, to the reset or to empty, whichever comes first.
        </Text>
      )}
    </div>
  );
}

/// The forecast drawn on from today, to the reset or to the moment the
/// amount runs out, whichever comes first and never further than two
/// months out.
function forecastOf(
  outlook: Outlook,
  left: number,
  now: number,
): { unix: number; value: number }[] | null {
  if (!hasPace(outlook)) return null;
  const end = Math.min(outlook.runsOutAt, outlook.resetsAt ?? Infinity, now + 60 * DAY);
  return [
    { unix: now, value: left },
    { unix: end, value: Math.max(0, left - ((end - now) / DAY) * outlook.pace.perDay) },
  ];
}

/// The resets inside the drawn range, for a window of a known length.
function pastResets(row: Observation, first: number) {
  const length = row.window ? WINDOW_SECONDS[row.window] : undefined;
  if (row.resets_at_unix === null || length === undefined) return [];
  const markers: { unix: number; label: string }[] = [];
  for (let unix = row.resets_at_unix - length; unix >= first; unix -= length) {
    markers.push({ unix, label: "reset" });
  }
  return markers;
}
