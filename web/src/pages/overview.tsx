import { Badge, Text } from "@mantine/core";
import {
  IconActivity,
  IconArrowUpRight,
  IconCheck,
  IconChevronRight,
  IconLayersSubtract,
  IconPlugConnected,
} from "@tabler/icons-react";
import { api, type Health } from "../api";
import { balanceReading, balanceRisk, readingGroups } from "../components/balance-math";
import { overviewPeriod, PERIODS, poolCoverage } from "../components/overview-math";
import { Dot, PageHeader, Panel } from "../components/ui";
import { clock, dateTime, uptime } from "../format";
import { routeParam, usePoll, type Resource, type Route } from "../hooks";
import { eventStory, foldCards } from "../components/event-story";
import { OverviewTraffic } from "./overview-traffic";
import { Drill, SourceNote, drillUrl } from "./overview-links";
import "./overview.css";

export function healthTone(health: Health) {
  return health.status === "ok" ? "ok" : "warn";
}

export function brokenComponents(health: Health) {
  return Object.entries(health.components)
    .filter(([, c]) => c && !c.ok)
    .map(([name, c]) => ({ name, detail: c.detail ?? "not healthy" }));
}

export const COMPONENTS: Record<string, [string, Route]> = {
  catalog: ["Model catalog", "providers"],
  providers: ["Connections", "providers"],
  balances: ["Balance store", "balances"],
  events: ["Event log", "activity"],
  requests: ["Request history", "history"],
  schedule: ["Refresh schedule", "providers"],
  knowledge: ["Model Wiki", "wiki"],
};

export function OverviewPage({ health }: { health: Resource<Health> }) {
  const pools = usePoll(api.pools, []);
  const bans = usePoll(api.bans, []);
  const balances = usePoll(api.observations, []);
  // More than five are read, because a run of card updates is one line.
  const events = usePoll(() => api.events(30), []);
  const period = overviewPeriod(routeParam("period"));
  const core = health.data;
  const broken = core ? brokenComponents(core) : [];
  const entries = Object.entries(core?.components ?? {}).sort(
    ([, a], [, b]) => Number(a.ok) - Number(b.ok),
  );
  const coverage = pools.data && bans.data ? poolCoverage(pools.data, bans.data) : undefined;
  const hot = readingGroups(balances.data ?? [])
    .map((rows) => {
      const row = rows[0];
      return { row, count: rows.length, left: balanceReading(row).percentLeft, risk: balanceRisk(row) };
    })
    .filter((h) => h.risk !== "ok" || (h.left !== null && h.left <= 20))
    .sort(
      (a, b) =>
        Number(b.risk === "exhausted") - Number(a.risk === "exhausted") ||
        (a.left ?? 100) - (b.left ?? 100),
    );
  const signals = [
    ...broken.map((c) => ({
      badge: "Degraded",
      tone: "orange",
      title: COMPONENTS[c.name]?.[0] ?? c.name,
      hint: c.detail,
      href: drillUrl(COMPONENTS[c.name]?.[1] ?? "activity"),
    })),
    ...(bans.data ?? []).map((b) => ({
      badge: "Banned",
      tone: "red",
      title: b.upstream_id,
      hint: `${b.provider_id} · ${b.reason} · expires ${dateTime(b.expires_at_unix)}`,
      href: "#/activity",
    })),
    ...hot.map(({ row, count, left, risk }) => ({
      badge: risk === "exhausted" ? "Exhausted" : risk === "low" ? "Low" : "Watch",
      tone: risk === "exhausted" ? "red" : "yellow",
      title: `${row.provider_id} · ${row.window ?? row.resource}`,
      hint: [
        left !== null ? `${Number(left.toFixed(1))}% left` : "No balance left",
        count > 1 ? `${count} matching readings` : row.resource,
        `observed ${dateTime(row.observed_at_unix)}`,
      ].join(" · "),
      href: drillUrl("balances", { provider: row.provider_id }),
    })),
  ];
  const readings = balances.data ?? [];
  const latestReading = readings.reduce((latest, row) => Math.max(latest, row.observed_at_unix), 0);
  const complete = core && bans.data && balances.data && !health.error && !bans.error && !balances.error;
  const status = health.error
    ? "Health check unavailable"
    : !core
      ? "Checking router…"
      : core.status === "ok"
        ? "Core is healthy"
        : "Core is degraded";
  const tone = health.error ? "unknown" : core ? healthTone(core) : "unknown";
  const signalRow = (s: (typeof signals)[number], i: number) => (
    <a className="ov-line" href={s.href} key={`${s.href}:${s.title}:${i}`}>
      <Badge size="xs" variant="light" color={s.tone}>
        {s.badge}
      </Badge>
      <span>
        <strong>{s.title}</strong>
        <small>{s.hint}</small>
      </span>
      <IconChevronRight size={14} />
    </a>
  );

  return (
    <div className="ov-page">
      <PageHeader
        title="Overview"
        description="Router health, recent traffic, and reported alerts."
      />
      <section className="ov-hero" data-tone={tone} aria-labelledby="ov-status">
        <div className="ov-status">
          <h2 id="ov-status">
            <Dot tone={tone} />
            {status}
          </h2>
          <p>
            {health.error
              ? "Current component health could not be verified."
              : broken.length
                ? `Check ${broken.map((c) => COMPONENTS[c.name]?.[0] ?? c.name).join(", ")}.`
                : core
                  ? "All reported core checks passed."
                  : "Waiting for the first health report."}
          </p>
          {health.updatedAt && (
            <small>
              Checked {clock(health.updatedAt / 1000)} · up {core ? uptime(core.uptime_unix) : "—"}
            </small>
          )}
        </div>
        <div className="ov-inventory">
          <Inventory
            route="providers"
            icon={<IconPlugConnected />}
            value={core?.components.providers?.count}
            label="Connections"
          />
          <Inventory route="pools" icon={<IconLayersSubtract />} value={pools.data?.length} label="Pools" />
          <Inventory
            route="activity"
            icon={<IconActivity />}
            value={bans.data?.length}
            label="Active bans"
          />
        </div>
      </section>

      <div className="ov-grid">
        <Panel
          title={<h2>Needs attention</h2>}
          description="Failures, bans and balances at 20% or less."
        >
          <SourceNote source={health} name="health" />
          <SourceNote source={bans} name="bans" />
          <SourceNote source={balances} name="balance readings" />
          {signals.slice(0, 3).map(signalRow)}
          {signals.length > 3 && (
            <details>
              <summary>Show {signals.length - 3} more alerts</summary>
              {signals.slice(3).map(signalRow)}
            </details>
          )}
          {!signals.length && complete && (
            <div className="ov-clear">
              <IconCheck size={18} />
              <div>
                <strong>No alerts in reported data</strong>
                <small>
                  {balances.data?.length
                    ? "No active bans or balance warnings."
                    : "No active bans. No balance readings have been reported."}
                </small>
              </div>
            </div>
          )}
          {latestReading > 0 && (
            <small className="ov-snapshot">Latest balance reading · {dateTime(latestReading)}</small>
          )}
          <div className="ov-footer">
            <Drill href="#/balances">All balances</Drill>
            <Drill href="#/activity">Ban activity</Drill>
          </div>
        </Panel>
        <Panel
          title={<h2>Pool members</h2>}
          description="Not on the ban list. Not an availability check."
          actions={<Drill href="#/pools">Pools</Drill>}
        >
          <SourceNote source={pools} name="pools" />
          {!bans.data && (
            <Text size="xs" c="dimmed">
              Pool member counts need the active ban list.
            </Text>
          )}
          {coverage &&
            (coverage.length ? (
              <>
                {coverage.slice(0, 4).map((p) => (
                  <a className="ov-line" key={p.name} href={drillUrl("pools", { q: p.name })}>
                    <Dot tone={!p.free ? "bad" : p.free < p.total ? "warn" : "ok"} />
                    <span>
                      <strong>{p.name}</strong>
                    </span>
                    <small>{!p.total ? "Empty pool" : `${p.free} / ${p.total} unbanned`}</small>
                    <IconChevronRight size={14} />
                  </a>
                ))}
                {coverage.length > 4 && <Drill href="#/pools">View all {coverage.length} pools</Drill>}
              </>
            ) : (
              <Text size="sm" c="dimmed">
                No routing pools configured.
              </Text>
            ))}
        </Panel>
      </div>

      <section aria-labelledby="ov-traffic-title" className="ov-traffic">
        <header className="ov-section-head">
          <h2 id="ov-traffic-title">Traffic</h2>
          <nav aria-label="Traffic period" className="ov-period">
            {Object.keys(PERIODS).map((p) => (
              <a
                key={p}
                href={drillUrl("overview", { period: p })}
                aria-current={p === period ? "true" : undefined}
              >
                {p}
              </a>
            ))}
          </nav>
        </header>
        <OverviewTraffic key={period} period={period} />
      </section>

      <div className="ov-grid">
        <Panel title={<h2>Components</h2>}>
          <SourceNote source={health} name="component checks" />
          <div className="ov-checks">
            {entries.map(([name, c]) => {
              const [label, route] = COMPONENTS[name] ?? [name, "activity"];
              return (
                <a className="ov-check" href={drillUrl(route)} key={name}>
                  <Dot tone={c.ok ? "ok" : "warn"} />
                  <span>{label}</span>
                  <small>
                    {c.ok ? "OK" : "Degraded"}
                    {c.count != null ? ` · ${c.count}` : ""}
                  </small>
                  <IconArrowUpRight size={13} />
                </a>
              );
            })}
          </div>
          {core && !entries.length && (
            <Text size="sm" c="dimmed">
              No component details reported.
            </Text>
          )}
          <div className="ov-footer">
            <Drill href="#/wiki">Browse Model Wiki</Drill>
          </div>
        </Panel>
        <Panel
          title={<h2>Latest events</h2>}
          description="The last five, whatever the period."
          actions={<Drill href="#/activity">Router events</Drill>}
        >
          <SourceNote source={events} name="events" />
          {events.data?.length === 0 && (
            <Text size="sm" c="dimmed">
              No events logged yet.
            </Text>
          )}
          {events.data &&
            foldCards(events.data, 2)
              .slice(0, 5)
              .map((item) =>
                "cards" in item ? (
                  <a
                    key={`cards-${item.cards[0].id}`}
                    className="ov-line ov-event"
                    href="#/wiki"
                  >
                    <time title={dateTime(item.cards[0].ts_unix)}>{clock(item.cards[0].ts_unix)}</time>
                    <span>
                      <strong>
                        Model Wiki: {item.cards.length} cards updated
                      </strong>
                      <small>
                        {clock(item.cards.at(-1)!.ts_unix)} – {clock(item.cards[0].ts_unix)}
                        {item.cards.length > 1 ? ` · latest ${eventStory(item.cards[0]).model ?? ""}` : ""}
                      </small>
                    </span>
                    <IconChevronRight size={14} />
                  </a>
                ) : (
                  <a
                    key={item.event.id}
                    className="ov-line ov-event"
                    href={drillUrl("activity", { kind: item.event.kind })}
                  >
                    <time title={dateTime(item.event.ts_unix)}>{clock(item.event.ts_unix)}</time>
                    <span>
                      <strong>{eventStory(item.event).title}</strong>
                      <small>{eventStory(item.event).note}</small>
                    </span>
                    <IconChevronRight size={14} />
                  </a>
                ),
              )}
        </Panel>
      </div>
    </div>
  );
}

function Inventory({
  route,
  icon,
  label,
  value,
}: {
  route: Route;
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
}) {
  return (
    <a href={drillUrl(route)} className="ov-counter">
      {icon}
      <b>{value ?? "—"}</b>
      <span>{label} ↗</span>
    </a>
  );
}
