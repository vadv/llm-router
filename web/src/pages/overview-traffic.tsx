import { Table, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";
import { api, type RequestRecord } from "../api";
import { Chart } from "../components/chart";
import { PERIODS, recentOutcomes, trafficHours, type Period } from "../components/overview-math";
import { ProviderLogo } from "../components/provider-logo";
import { OutcomeBadge, Panel } from "../components/ui";
import { knownTokens, rankGroups } from "../components/usage-math";
import { clock, compact, dateTime, money, span, tps } from "../format";
import { usePoll } from "../hooks";
import { RequestDrawer } from "../components/request-drawer";
import { Drill, SourceNote, drillUrl } from "./overview-links";

export function OverviewTraffic({ period }: { period: Period }) {
  const seconds = PERIODS[period];
  const usage = usePoll(async () => {
    const end = Math.floor(Date.now() / 1000) + 1;
    const start = end - seconds;
    return {
      page: await api.usage({ sinceUnix: start, toUnix: end, groupBy: "provider", bucket: "hour" }),
      start,
      end,
    };
  }, [seconds]);
  const calls = usePoll(
    () => api.requests({ sinceUnix: Math.floor(Date.now() / 1000) + 1 - seconds, limit: 100 }),
    [seconds],
  );
  const [selected, select] = useState<RequestRecord | null>(null);
  const report = usage.data;
  const t = report?.page.totals;
  const complete = report && !report.page.truncated;
  const hours = complete && t?.attempts ? trafficHours(report.page.buckets, report.start, report.end) : [];
  const leaders = complete ? rankGroups(report.page.buckets, "attempts").slice(0, 4) : [];
  const latest = calls.data ?? [];
  const outcomes = recentOutcomes(latest);
  const speeds = latest
    .flatMap((r) =>
      r.attempts.flatMap((a) => {
        const value = a.result === "ok" ? tps(a) : null;
        return value !== null && a.finished_at_unix !== null ? [{ unix: a.finished_at_unix, value }] : [];
      }),
    )
    .sort((a, b) => a.unix - b.unix);
  const usageUrl = drillUrl("usage", { period });
  const historyUrl = drillUrl("history", { period });
  return (
    <>
      <SourceNote name="usage" source={usage} />
      <div className="ov-metrics">
        <Metric
          label="Requests"
          value={compact(t?.requests)}
          hint={t ? `${compact(t.attempts)} upstream attempts` : "Distinct requests with attempts"}
          href={usageUrl}
        />
        <Metric
          label="Reported tokens"
          value={t ? compact(knownTokens(t.input_tokens, t.output_tokens)) : "—"}
          hint={
            t
              ? `${compact(t.input_tokens)} in · ${compact(t.output_tokens)} out`
              : "Input + output reported"
          }
          href={usageUrl}
        />
        <Metric
          label="Reported cost"
          value={money(t?.cost)}
          hint={t ? `${t.cost_reports} of ${t.attempts} attempts reported cost` : "Upstream reports only"}
          href={usageUrl}
        />
        <Metric
          label="Output speed"
          value={compact(t?.output_tps)}
          hint={t ? `tok/s · ${t.speed_reports} timed successes` : "End-to-end tokens per second"}
          href={usageUrl}
        />
      </div>
      {t && (
        <details className="ov-coverage">
          <summary>Token reports & timing</summary>
          <small>
            Of {t.attempts} attempts, {t.input_reports} reported input tokens and {t.output_reports}{" "}
            reported output tokens. Unknown values are not counted as zero. Mean duration:{" "}
            {t.mean_duration_ms == null ? "—" : `${compact(t.mean_duration_ms / 1000)} s`} across{" "}
            {t.duration_reports} timed attempts. Cost is reported, not estimated.
          </small>
        </details>
      )}
      <div className="ov-grid ov-chart-grid">
        <Panel
          title={<h3>Traffic by hour</h3>}
          description="Upstream attempts and errors. A retried request can contribute more than once."
          actions={<Drill href={usageUrl}>Usage report</Drill>}
        >
          {!report ? (
            <Text size="xs" c="dimmed">
              {usage.error ? "Traffic unavailable." : "Waiting for traffic data…"}
            </Text>
          ) : report.page.truncated ? (
            <Text size="xs" c="orange">
              Only part of the hourly data was returned. Totals above cover the full period; the trend and
              ranking are hidden.
            </Text>
          ) : hours.length ? (
            <Chart
              height={124}
              format={compact}
              series={[
                {
                  label: "Attempts",
                  color: "var(--mantine-color-teal-5)",
                  points: hours.map((h) => ({ unix: h.unix, value: h.attempts })),
                },
                {
                  label: "Errors",
                  color: "var(--mantine-color-orange-5)",
                  points: hours.map((h) => ({ unix: h.unix, value: h.errors })),
                },
              ]}
            />
          ) : (
            <Text size="sm" c="dimmed">
              No attempts recorded in the last {period}.
            </Text>
          )}
          {t && (
            <div className="ov-footer">
              <small>
                {t.errors} attempt errors · {t.cancels} client cancellations
              </small>
              {report && (
                <small>
                  {dateTime(report.start)} – {dateTime(report.end - 1)}
                </small>
              )}
            </div>
          )}
        </Panel>
        <Panel
          title={<h3>Busiest connections</h3>}
          description="Ranked by attempts. Select a connection to see its models and clients."
        >
          {leaders.map((l) => (
            <a
              className="ov-line ov-leader"
              href={drillUrl("usage", { period, provider: l.group })}
              key={l.group}
            >
              <ProviderLogo providerId={l.group} size={22} />
              <span>
                <strong>{l.group}</strong>
                <span className="ov-meter" aria-hidden="true">
                  <i style={{ width: `${(100 * l.totals.attempts) / leaders[0].totals.attempts}%` }} />
                </span>
              </span>
              <small>{compact(l.totals.attempts)} attempts</small>
              <IconChevronRight size={14} />
            </a>
          ))}
          {!leaders.length && (
            <Text size="xs" c="dimmed">
              {!report
                ? usage.error
                  ? "Ranking unavailable."
                  : "Loading ranking…"
                : report.page.truncated
                  ? "Incomplete hourly data."
                  : "No connections handled traffic in this period."}
            </Text>
          )}
          <div className="ov-footer">
            <Drill href="#/providers">Connection catalogs</Drill>
          </div>
        </Panel>
      </div>
      <Panel
        title={<h3>Recent calls</h3>}
        description={`Up to 100 stored requests started in the last ${period}. Select a timestamp for the exact call.`}
        actions={<Drill href={historyUrl}>Request history</Drill>}
      >
        <SourceNote source={calls} name="recent calls" />
        {!!latest.length && (
          <div className="ov-outcomes">
            <div>
              <b>{outcomes.rate === null ? "—" : `${Number(outcomes.rate.toFixed(1))}%`}</b>
              <strong> successful</strong>
              <small>
                {outcomes.ok} of {outcomes.count} calls with a known outcome · {outcomes.errors} failed ·{" "}
                {outcomes.cancels} cancelled
              </small>
            </div>
            <div className="ov-strip-group">
              <div className="ov-strip" aria-hidden="true">
                {latest
                  .slice(0, 32)
                  .reverse()
                  .map((r) => (
                    <i
                      key={r.id}
                      data-result={r.outcome}
                      title={`${clock(r.started_at_unix)} · ${r.outcome ?? "unknown"}`}
                    />
                  ))}
              </div>
              <small>Last {Math.min(latest.length, 32)} calls · oldest → newest</small>
            </div>
          </div>
        )}
        {speeds.length > 0 && (
          <details className="ov-speed">
            <summary>
              Recent output speed · peak {compact(Math.max(...speeds.map((s) => s.value)))} tok/s
            </summary>
            <small>
              {speeds.length} successful attempts with output and duration in the recent sample. Values use
              elapsed attempt time, not time to first token.
            </small>
            <Chart
              series={[{ label: "Output tok/s", color: "var(--mantine-color-cyan-5)", points: speeds }]}
              height={100}
              format={compact}
            />
          </details>
        )}
        {calls.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No stored calls in this period. Try a longer window or open Requests.
          </Text>
        )}
        {!!latest.length && (
          <Table className="ov-calls" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Pool</Table.Th>
                <Table.Th visibleFrom="sm">Upstream model</Table.Th>
                <Table.Th>Outcome</Table.Th>
                <Table.Th visibleFrom="md" ta="right">
                  Attempts
                </Table.Th>
                <Table.Th visibleFrom="xs" ta="right">
                  Duration
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {latest.slice(0, 8).map((r) => {
                const a = r.attempts.find((a) => a.result === "ok") ?? r.attempts.at(-1);
                return (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <button
                        type="button"
                        className="ov-time"
                        title={dateTime(r.started_at_unix)}
                        aria-label={`Inspect call ${r.id}`}
                        onClick={() => select(r)}
                      >
                        {clock(r.started_at_unix)}
                      </button>
                    </Table.Td>
                    <Table.Td>
                      <a
                        className="ov-cell-link"
                        href={drillUrl("history", { period, pool: r.metamodel })}
                        title={`History for ${r.metamodel}`}
                      >
                        {r.metamodel}
                      </a>
                    </Table.Td>
                    <Table.Td visibleFrom="sm">
                      {a ? (
                        <a
                          className="ov-cell-link"
                          href={drillUrl("wiki", { model: a.upstream_id })}
                          title={`Look up ${a.upstream_id}`}
                        >
                          {a.upstream_id}
                          <small>{a.provider_id}</small>
                        </a>
                      ) : (
                        "—"
                      )}
                    </Table.Td>
                    <Table.Td>
                      <OutcomeBadge outcome={r.outcome} />
                    </Table.Td>
                    <Table.Td visibleFrom="md" ta="right">
                      {r.attempts.length}
                    </Table.Td>
                    <Table.Td visibleFrom="xs" ta="right">
                      {span(r.started_at_unix, r.finished_at_unix) ?? "—"}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
        {latest.length > 8 && (
          <div className="ov-footer">
            <small>Showing 8 of {latest.length} recent calls</small>
            <Drill href={historyUrl}>Browse requests</Drill>
          </div>
        )}
      </Panel>
      <RequestDrawer request={selected} onClose={() => select(null)} />
    </>
  );
}

function Metric({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint: string;
  href: string;
}) {
  return (
    <a href={href} className="ov-metric">
      <span>
        {label} <span aria-hidden="true">↗</span>
      </span>
      <b>{value}</b>
      <small>{hint}</small>
    </a>
  );
}
