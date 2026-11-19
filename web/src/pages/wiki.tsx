import {
  Alert,
  Button,
  Drawer,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowRight,
  IconBooks,
  IconChartBar,
  IconPlugConnected,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useModelSummaries } from "../use-model-summaries";
import {
  ModelCardBody,
  CardStatusBadge,
  ProviderLabels,
  VendorBadge,
} from "../components/model-card";
import { ProviderLogo } from "../components/provider-logo";
import { Copyable, PageHeader, Panel } from "../components/ui";
import { contextWindow, dateTime } from "../format";
import { routeParam, usePoll } from "../hooks";
import { ensureKnowledge, useKnowledge } from "../model-knowledge";
import {
  benchmarks,
  wikiGroups,
  wikiResults,
  type WikiGroup,
  type WikiSort,
} from "../wiki-catalog";
import "./wiki.css";

const PAGE = 24;


export function WikiPage() {
  const catalog = usePoll(api.catalog, []);
  const keys = useMemo(
    () =>
      catalog.data
        ? JSON.stringify(
            [...new Set(catalog.data.map((r) => r.knowledge_key))].sort(),
          )
        : null,
    [catalog.data],
  );
  const index = useModelSummaries(keys);
  const cards = index.state?.cards;
  const groups = useMemo(
    () => wikiGroups(catalog.data ?? [], cards ?? []),
    [catalog.data, cards],
  );
  const [query, setQuery] = useState(""),
    [provider, setProvider] = useState<string | null>(null),
    [vendor, setVendor] = useState<string | null>(null);
  const [scope, setScope] = useState("all"),
    [order, setOrder] = useState<WikiSort>("high"),
    [metric, setMetric] = useState<string | null>(null),
    [shown, setShown] = useState(PAGE);
  const measures = useMemo(() => benchmarks(groups), [groups]);
  const selectedMetric =
    measures.find((m) => m.value === metric) ?? measures[0];
  const rank = (order === "high" || order === "low") && !!selectedMetric;
  const sort = (order === "high" || order === "low") && !rank ? "name" : order;
  const rows = useMemo(
    () =>
      wikiResults(
        groups,
        query,
        provider,
        cards ? vendor : null,
        cards ? scope : "all",
        sort,
        selectedMetric?.value ?? null,
      ),
    [groups, query, provider, cards, vendor, scope, sort, selectedMetric],
  );
  const providers = useMemo(
    () => [...new Set(groups.flatMap((g) => g.providers))].sort(),
    [groups],
  );
  const vendors = useMemo(
    () =>
      [
        ...new Set(
          groups.flatMap((g) => (g.card?.vendor ? [g.card.vendor] : [])),
        ),
      ].sort(),
    [groups],
  );
  const reset = () => {
    setQuery("");
    setProvider(null);
    setVendor(null);
    setScope("all");
    setShown(PAGE);
  };
  const target = routeParam("model");
  const selected =
    target &&
    (groups.find((g) => g.key === target) ??
      groups.find((g) => g.entries.some((e) => e.upstream_id === target)));
  const scored = rank
    ? rows.filter((g) => g.scores.has(selectedMetric.value)).length
    : 0;
  return (
    <div className="wiki-page">
      <PageHeader
        title="Model Wiki"
        description="Find a model, compare a benchmark and see the exact ID each connection lists."
      />
      <section className="wiki-banner" aria-label="Catalog summary">
        <div>
          <span className="wiki-kicker">
            <IconBooks size={15} /> Model directory
          </span>
          <h2>Model catalog</h2>
          <p>
            Listings come from your router. Research describes the model, not
            the health of a connection.
          </p>
        </div>
        <div className="wiki-counts">
          {[
            ["Models", catalog.data ? groups.length : "—"],
            ["Connections", catalog.data ? providers.length : "—"],
            ["Research cards", cards ? cards.length : "—"],
          ].map(([label, n]) => (
            <div key={label}>
              <b>{n}</b>
              <small>{label}</small>
            </div>
          ))}
        </div>
      </section>
      <section className="wiki-controls" aria-label="Model filters">
        <div className="wiki-filters">
          <TextInput
            size="xs"
            label="Find a model"
            placeholder="Name, upstream ID or keyword"
            leftSection={<IconSearch size={15} />}
            value={query}
            onChange={(e) => {
              setQuery(e.currentTarget.value);
              setShown(PAGE);
            }}
          />
          <Select
            size="xs"
            label="Listed by connection"
            placeholder="All connections"
            searchable
            clearable
            data={providers}
            value={provider}
            onChange={(v) => {
              setProvider(v);
              setShown(PAGE);
            }}
          />
          <Select
            size="xs"
            label="Model vendor"
            placeholder="All vendors"
            searchable
            clearable
            disabled={!cards}
            data={vendors}
            value={vendor}
            onChange={(v) => {
              setVendor(v);
              setShown(PAGE);
            }}
          />
          <Select
            size="xs"
            label="Research"
            data={[
              { value: "all", label: "All models" },
              { value: "cards", label: "Has a card" },
              { value: "missing", label: "No card yet" },
            ]}
            disabled={!cards}
            allowDeselect={false}
            value={scope}
            onChange={(v) => {
              setScope(v ?? "all");
              setShown(PAGE);
            }}
          />
        </div>
        <div className="wiki-sort">
          <IconChartBar size={19} />
          <Select
            size="xs"
            label="Order by"
            allowDeselect={false}
            value={order}
            onChange={(v) => {
              setOrder(v as WikiSort);
              setShown(PAGE);
            }}
            data={[
              { value: "high", label: "Score: high to low" },
              { value: "low", label: "Score: low to high" },
              { value: "name", label: "Model name" },
              { value: "context", label: "Largest listed context" },
              { value: "providers", label: "Most connections" },
              { value: "release", label: "Newest release" },
            ]}
          />
          {(order === "high" || order === "low") && (
            <Select
              size="xs"
              label="Benchmark and source"
              className="wiki-benchmark-select"
              title={selectedMetric?.label}
              placeholder={
                cards ? "No comparable scores" : "Model cards unavailable"
              }
              disabled={!measures.length}
              value={selectedMetric?.value ?? null}
              allowDeselect={false}
              searchable
              limit={80}
              data={measures.map((m) => ({
                value: m.value,
                label: `${m.label} (${m.count})`,
              }))}
              onChange={(v) => {
                setMetric(v);
                setShown(PAGE);
              }}
            />
          )}
          {(query || provider || vendor || scope !== "all") && (
            <Button size="compact-xs" variant="subtle" onClick={reset}>
              Clear filters
            </Button>
          )}
        </div>
      </section>
      {catalog.error && (
        <Alert color="red" title="Catalog unavailable">
          {catalog.error}{" "}
          <Button size="compact-xs" onClick={catalog.reload}>
            Retry catalog
          </Button>
        </Alert>
      )}
      {index.state?.error && (
        <Alert color="orange" title="Model cards unavailable">
          Provider listings still work. Model cards and their scores cannot be loaded.{" "}
          <Button size="compact-xs" onClick={index.reload}>
            Retry model cards
          </Button>
        </Alert>
      )}
      {target && catalog.data && !selected && (
        <Alert color="orange" title="Model not in this catalog">
          No current listing matches this link.{" "}
          <a href="#/wiki">Browse all models</a>
        </Alert>
      )}
      <div className="wiki-results-head">
        <div>
          <span className="wiki-kicker">
            {rank ? "Benchmark comparison" : "Directory"}
          </span>
          <h2>
            {catalog.data
              ? `${rows.length} ${rows.length === 1 ? "model" : "models"}`
              : "Reading catalog…"}
          </h2>
        </div>
        <p>
          {rank
            ? `${scored} with a score · Unscored models follow. Values are not combined across benchmarks.`
            : !cards && !index.state?.error
              ? "Reading local research summaries…"
              : order === "high" || order === "low"
                ? "No comparable scores. Showing models by name."
                : "Select a model for provider IDs and full research."}
        </p>
      </div>
      {!!catalog.data && !rows.length && (
        <Panel>
          <strong>
            {groups.length
              ? "No models match these filters"
              : "No models in the catalog"}
          </strong>
          <p>
            {groups.length
              ? "Try another name or clear the connection and vendor filters."
              : "Check the configured connections and their last catalog refresh."}
          </p>
          {groups.length ? (
            <Button variant="light" size="xs" onClick={reset}>
              Show all models
            </Button>
          ) : (
            <a href="#/providers">Inspect connections →</a>
          )}
        </Panel>
      )}
      <div className="wiki-list">
        {rows.slice(0, shown).map((g) => {
          const score = selectedMetric && g.scores.get(selectedMetric.value);
          return (
            <a
              className="wiki-entry"
              key={g.key}
              href={`#/wiki?model=${encodeURIComponent(g.key)}`}
              aria-label={`Open ${g.name}`}
            >
              <div className="wiki-id">
                <h3>{g.name}</h3>
                {g.card?.vendor && <VendorBadge vendor={g.card.vendor} />}
                <p>
                  {g.card?.description ||
                    (cards
                      ? "Catalog listing · No description on file"
                      : "Catalog listing")}
                </p>
              </div>
              <div className="wiki-routes">
                <small>Listed by</small>
                <ProviderLabels providers={g.providers} limit={4} />
              </div>
              <div className="wiki-measure">
                <small>
                  {rank
                    ? "Score"
                    : sort === "release"
                      ? "Released"
                      : sort === "providers"
                        ? "Connections"
                        : "Max context"}
                </small>
                <b>
                  {rank
                    ? (score?.value ?? "—")
                    : sort === "release"
                      ? (g.card?.release_date ?? "—")
                      : sort === "providers"
                        ? g.providers.length
                        : g.context === null
                          ? "—"
                          : contextWindow(g.context)}
                </b>
                {rank && (
                  <span>
                    {score?.as_of ?? (score ? "Date unknown" : "Not scored")}
                  </span>
                )}
              </div>
              <IconArrowRight className="wiki-arrow" size={16} />
            </a>
          );
        })}
      </div>
      {rows.length > shown && (
        <Button
          variant="default"
          mx="auto"
          size="xs"
          onClick={() => setShown((n) => n + PAGE)}
        >
          Show {Math.min(PAGE, rows.length - shown)} more · {shown} of{" "}
          {rows.length}
        </Button>
      )}
      <Drawer
        opened={!!selected}
        onClose={() => {
          window.location.hash = "#/wiki";
        }}
        position="right"
        size="lg"
        title="Model dossier"
      >
        {selected && (
          <WikiDetail
            key={selected.key}
            group={selected}
            target={target}
            onCollect={index.reload}
          />
        )}
      </Drawer>
    </div>
  );
}
function WikiDetail({
  group,
  target,
  onCollect,
}: {
  group: WikiGroup;
  target: string | null;
  onCollect: () => void;
}) {
  const primary =
    group.entries.find((e) => e.upstream_id === target) ?? group.entries[0];
  const state = useKnowledge(primary.upstream_id);
  useEffect(() => ensureKnowledge(primary.upstream_id), [primary.upstream_id]);
  const [busy, setBusy] = useState(false),
    [force, setForce] = useState(false);
  const collect = async () => {
    setBusy(true);
    try {
      const r = await api.collectKnowledge({
        providerId: primary.provider_id,
        upstreamId: primary.upstream_id,
        force,
      });
      notifications.show({
        message: r.collected
          ? "Research card updated"
          : "Card is still fresh. No new research needed.",
      });
      ensureKnowledge(primary.upstream_id, true);
      onCollect();
    } catch (e) {
      notifications.show({
        color: "red",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="md">
      <div className="wiki-detail-head">
        <span className="wiki-kicker">Model reference</span>
        <h2>{group.name}</h2>
        <code>{group.key}</code>
      </div>
      <section className="wiki-connections">
        <span className="wiki-kicker">
          <IconPlugConnected size={14} /> Where to find it
        </span>
        <h3>
          Listed by {group.providers.length}{" "}
          {group.providers.length === 1 ? "connection" : "connections"}
        </h3>
        <p>
          Copy the upstream ID for the connection you intend to use. Context is
          per listing.
        </p>
        {group.providers.map((p) => (
          <div className="wiki-provider" key={p}>
            <strong>
              <ProviderLogo providerId={p} size={16} />
              {p}
            </strong>
            {group.entries
              .filter((e) => e.provider_id === p)
              .map((e) => (
                <div key={e.upstream_id}>
                  <Copyable value={e.upstream_id} block size="xs" />
                  <span>
                    {e.context_tokens === null
                      ? "Context unknown"
                      : `${contextWindow(e.context_tokens)} ctx`}
                  </span>
                </div>
              ))}
          </div>
        ))}
      </section>
      {state.error ? (
        <Alert color="orange" title="Research card unavailable">
          {state.error}{" "}
          <Button
            size="compact-xs"
            onClick={() => ensureKnowledge(primary.upstream_id, true)}
          >
            Retry card
          </Button>
        </Alert>
      ) : state.data?.card ? (
        <ModelCardBody data={state.data} providerId={primary.provider_id} />
      ) : (
        <Text size="sm" c="dimmed">
          {state.data
            ? "No research card yet. Provider listings above do not depend on research."
            : "Reading research card…"}
        </Text>
      )}
      <Panel>
        <Group justify="space-between">
          <strong>Research controls</strong>
          <CardStatusBadge state={state} />
        </Group>
        <Text size="xs" my="xs" c="dimmed">
          {state.data?.collected_at_unix
            ? `Collected ${dateTime(state.data.collected_at_unix)}. `
            : ""}
          Manual collection calls the configured researcher and may incur cost.
          Browsing does not.
        </Text>
        <Group>
          <Button
            size="xs"
            variant="light"
            loading={busy}
            leftSection={<IconRefresh size={14} />}
            onClick={collect}
          >
            {state.data?.card ? "Refresh card" : "Collect card"}
          </Button>
          <Switch
            size="xs"
            label="Force new research"
            checked={force}
            onChange={(e) => setForce(e.currentTarget.checked)}
          />
        </Group>
      </Panel>
    </Stack>
  );
}
