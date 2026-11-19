import { Badge, Button, Group, NativeSelect, Stack, Text } from "@mantine/core";
import {
  IconActivity,
  IconArrowRight,
  IconShieldPause,
} from "@tabler/icons-react";
import { useState } from "react";
import { api, type EventRecord } from "../api";
import { eventStory } from "../components/event-story";
import { ModelHoverCard } from "../components/model-card";
import { PageHeader, Panel, RelTime } from "../components/ui";
import { clock, dateTime, EVENT_KIND_COLOR } from "../format";
import { routeParam, useCadence, usePoll } from "../hooks";
import { Drill, drillUrl, SourceNote } from "./overview-links";
import "./diagnostics.css";

const FEED_SIZE = 100;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });

export function ActivityPage() {
  const cadence = useCadence();
  const bans = usePoll(api.bans, []);
  const pools = usePoll(api.pools, []);
  const events = usePoll(() => api.events(FEED_SIZE), []);
  const [kind, setKind] = useState(() => routeParam("kind") ?? "");
  const [provider, setProvider] = useState(() => routeParam("provider") ?? "");
  const feed = events.data ?? [];
  const rows = feed.filter(
    (e) =>
      (!kind || e.kind === kind) && (!provider || e.provider_id === provider),
  );
  const kinds = [
    ...new Set([kind, ...feed.map((e) => e.kind)].filter(Boolean)),
  ].sort();
  const providers = [
    ...new Set(
      [provider, ...feed.map((e) => e.provider_id ?? "")].filter(Boolean),
    ),
  ].sort();
  const clear = () => {
    setKind("");
    setProvider("");
  };
  return (
    <div className="diag-page">
      <div className="ov-eyebrow">Diagnostics / Changes</div>
      <PageHeader
        title="Router events"
        description="What changed on the router, why it happened, and where to look next."
        actions={<Drill href="#/history">Trace a request</Drill>}
      />
      <div className="diag-layout">
        <Panel
          p={0}
          title={
            <h2>
              <IconActivity size={17} /> Event timeline
            </h2>
          }
          description={`Newest first · filters apply to the latest ${FEED_SIZE} recorded events.`}
          actions={
            <Group gap="xs">
              <small>
                {cadence
                  ? `Refresh every ${cadence / 1000}s`
                  : "Manual refresh"}
                {events.updatedAt != null &&
                  ` · checked ${clock(events.updatedAt / 1000)}`}
              </small>
              <Button
                size="compact-xs"
                variant="default"
                onClick={events.reload}
              >
                Refresh feed
              </Button>
            </Group>
          }
        >
          <div className="diag-controls diag-event-controls">
            <NativeSelect
              label="Event kind"
              size="xs"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value)}
              data={[
                { value: "", label: "All kinds" },
                ...kinds.map((k) => ({
                  value: k,
                  label: k.replaceAll("_", " "),
                })),
              ]}
            />
            <NativeSelect
              label="Event source"
              size="xs"
              value={provider}
              onChange={(e) => setProvider(e.currentTarget.value)}
              data={[{ value: "", label: "All sources" }, ...providers]}
            />
            {(kind || provider) && (
              <Button size="compact-xs" variant="subtle" onClick={clear}>
                Clear filters
              </Button>
            )}
            {events.data && (
              <span className="diag-count" role="status">
                {rows.length} of {feed.length} events
              </span>
            )}
          </div>
          <SourceNote name="Event feed" source={events} />
          {events.data && !rows.length && (
            <div className="diag-empty">
              <strong>
                {feed.length
                  ? "No matching events in this feed"
                  : "No router events yet"}
              </strong>
              <span>
                {feed.length
                  ? "Clear a filter to see other recent changes."
                  : "Recorded changes will appear here when the router emits an event."}
              </span>
            </div>
          )}
          {rows.map((event, i) => (
            <div key={event.id}>
              {(i === 0 || day(event.ts_unix) !== day(rows[i - 1].ts_unix)) && (
                <div className="diag-day">{day(event.ts_unix)}</div>
              )}
              <EventRow event={event} />
            </div>
          ))}
        </Panel>
        <aside>
          <Panel
            title={
              <h2>
                <IconShieldPause size={17} /> Active bans
              </h2>
            }
            description="Current routing exclusions, independent of the event filters."
          >
            <SourceNote source={bans} name="Active bans" />
            {bans.data?.length === 0 && (
              <div className="diag-empty">
                <strong>No active bans</strong>
                <span>No model is excluded by a ban right now.</span>
              </div>
            )}
            {!!bans.data?.length && (
              <>
                <SourceNote source={pools} name="Pool membership" />
                {bans.data.map((ban) => (
                  <div
                    className="diag-ban"
                    key={JSON.stringify([ban.provider_id, ban.upstream_id])}
                  >
                    <Group gap="xs" justify="space-between">
                      <Badge color="orange" variant="light">
                        Out of rotation
                      </Badge>
                      <Text
                        size="xs"
                        c="dimmed"
                        title={dateTime(ban.expires_at_unix)}
                      >
                        Expires <RelTime unix={ban.expires_at_unix} />
                      </Text>
                    </Group>
                    <Stack gap={2} mt="xs">
                      <small>{ban.provider_id}</small>
                      <ModelHoverCard
                        providerId={ban.provider_id}
                        upstreamId={ban.upstream_id}
                      >
                        <strong>{ban.upstream_id}</strong>
                      </ModelHoverCard>
                      <Text size="xs">{ban.reason}</Text>
                    </Stack>
                    <Group gap="sm" mt="xs">
                      <Drill
                        href={drillUrl("history", {
                          provider: ban.provider_id,
                          model: ban.upstream_id,
                          period: "all",
                        })}
                      >
                        Related requests
                      </Drill>
                      {pools.data
                        ?.filter((p) =>
                          p.members.some(
                            (m) =>
                              m.provider_id === ban.provider_id &&
                              m.upstream_id === ban.upstream_id,
                          ),
                        )
                        .map((p) => (
                          <a
                            className="diag-pool"
                            href={drillUrl("pools", { q: p.name })}
                            key={p.name}
                          >
                            Pool: {p.name}
                          </a>
                        ))}
                    </Group>
                  </div>
                ))}
              </>
            )}
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: EventRecord }) {
  const story = eventStory(event);
  const provider = event.provider_id;
  const link =
    event.kind === "balance_error" && provider
      ? { url: drillUrl("balances", { provider }), label: "Inspect balance" }
      : story.pool || (provider && story.model)
        ? {
            url: drillUrl("history", {
              period: "all",
              ...(story.pool ? { pool: story.pool } : {}),
              ...(provider ? { provider } : {}),
              ...(story.model ? { model: story.model } : {}),
            }),
            label: "Related requests",
          }
        : event.kind.startsWith("knowledge_")
          ? { url: "#/wiki", label: "Model Wiki" }
          : null;
  return (
    <article className="diag-event">
      <time title={dateTime(event.ts_unix)}>{clock(event.ts_unix)}</time>
      <div className="diag-story">
        <Group gap={6}>
          <Badge
            size="xs"
            tt="none"
            variant="light"
            color={EVENT_KIND_COLOR[event.kind] ?? "gray"}
          >
            {event.kind.replaceAll("_", " ")}
          </Badge>
          <small>{provider || "Router"}</small>
        </Group>
        <h3>{story.title}</h3>
        <p>{story.note}</p>
        {link && (
          <a className="diag-action" href={link.url}>
            {link.label} <IconArrowRight size={12} />
          </a>
        )}
        {event.detail != null && (
          <details className="event-detail">
            <summary>Technical details</summary>
            <pre>{JSON.stringify(event.detail, null, 2)}</pre>
          </details>
        )}
      </div>
    </article>
  );
}
