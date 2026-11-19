import { Alert, Button, Menu, NativeSelect, TextInput } from "@mantine/core";
import {
  IconAdjustmentsHorizontal,
  IconBook,
  IconChevronRight,
  IconDatabase,
  IconRefresh,
  IconSearch,
  IconServer2,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import {
  api,
  type LiveCatalogModel,
  type ProviderInfo,
  type RefreshWhat,
} from "../api";
import { ProviderLogo } from "../components/provider-logo";
import { ModelHoverCard } from "../components/model-card";
import { Copyable, PageHeader, RelTime } from "../components/ui";
import { contextWindow, dateTime } from "../format";
import { routeParam, usePoll } from "../hooks";
import { freeLabel, idleSlots, inventoryRows } from "../provider-inventory";
import { useModelSummaries } from "../use-model-summaries";
import { drillUrl } from "./overview-links";
import "./providers.css";

const providerLink = (id: string, free: boolean) =>
  drillUrl("providers", {
    ...(id ? { provider: id } : {}),
    ...(free ? { free: "1" } : {}),
  });
const EMPTY: LiveCatalogModel[] = [];

export function ProvidersPage() {
  const connections = usePoll(api.providers, []),
    catalog = usePoll(api.catalog, []);
  const [asking, setAsking] = useState<RefreshWhat | null>(null),
    [asked, setAsked] = useState<number | null>(null),
    [askError, setAskError] = useState("");
  async function refresh(what: RefreshWhat) {
    setAsking(what);
    setAskError("");
    try {
      await api.refresh(what);
      setAsked(Math.floor(Date.now() / 1000));
      connections.reload();
      catalog.reload();
    } catch (e) {
      setAskError(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking(null);
    }
  }
  const free = routeParam("free") === "1",
    id = routeParam("provider");
  const groups = useMemo(() => {
    const map = new Map<string, LiveCatalogModel[]>();
    for (const r of catalog.data ?? []) {
      const group = map.get(r.provider_id);
      if (group) group.push(r);
      else map.set(r.provider_id, [r]);
    }
    return (connections.data ?? [])
      .map((p) => {
        const rows = map.get(p.provider_id) ?? EMPTY;
        return {
          p,
          rows,
          free: rows.filter((r) => freeLabel(r.upstream_id)).length,
        };
      })
      .sort((a, b) => a.p.provider_id.localeCompare(b.p.provider_id));
  }, [connections.data, catalog.data]);
  const visible = groups.filter((g) => !free || g.free > 0),
    active = id ? visible.find((g) => g.p.provider_id === id) : visible[0];
  const known = catalog.data !== undefined,
    totals = groups.reduce(
      (s, g) => ({
        models: s.models + g.rows.length,
        free: s.free + g.free,
        connections: s.connections + Number(g.free > 0),
      }),
      { models: 0, free: 0, connections: 0 },
    );
  return (
    <div className="pv-page">
      <div className="ov-eyebrow">Routing / Connections</div>
      <PageHeader
        title="Providers"
        description="Configured connections, provider catalogs, and models marked free."
        actions={
          <Menu position="bottom-end" withArrow>
            <Menu.Target>
              <Button
                size="xs"
                variant="default"
                loading={asking !== null}
                leftSection={<IconRefresh size={14} />}
              >
                Request refresh
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Refresh provider data</Menu.Label>
              <Menu.Item onClick={() => refresh("all")}>
                Catalog and balances
              </Menu.Item>
              <Menu.Item onClick={() => refresh("catalog")}>
                Catalog only
              </Menu.Item>
              <Menu.Item onClick={() => refresh("balances")}>
                Balances only
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        }
      />
      {asked !== null && !askError && (
        <p role="status">
          Refresh requested <RelTime unix={asked} />. The core runs it in the
          background.
        </p>
      )}
      {askError && (
        <Alert color="red" title="Refresh request failed">
          {askError}
        </Alert>
      )}
      {connections.error && (
        <Alert
          color="red"
          title={
            connections.data
              ? "Connection refresh failed · showing the last read"
              : "Connection list unavailable"
          }
        >
          {connections.error}{" "}
          <button onClick={connections.reload}>Retry connections</button>
        </Alert>
      )}
      {catalog.error && (
        <Alert
          color="orange"
          title={
            known
              ? "Catalog refresh failed · showing the last read"
              : "Catalog unavailable"
          }
        >
          {catalog.error}{" "}
          <button onClick={catalog.reload}>Retry catalog</button>
        </Alert>
      )}
      <div className="pv-totals" aria-label="Connection summary">
        <div>
          <small>Connections</small>
          <strong>{connections.data ? groups.length : "—"}</strong>
          <span>configured on this router</span>
        </div>
        <div>
          <small>Model listings</small>
          <strong>{known && connections.data ? totals.models : "—"}</strong>
          <span>one upstream ID per connection</span>
        </div>
        <div>
          <small>Listings marked free</small>
          <strong className="pv-free-text">
            {known && connections.data ? totals.free : "—"}
          </strong>
          <span>
            {known && connections.data
              ? `across ${totals.connections} ${totals.connections === 1 ? "connection" : "connections"}`
              : "catalog not yet known"}
          </span>
        </div>
      </div>
      <div className="pv-layout">
        <section className="pv-directory" aria-label="Connection directory">
          <div className="pv-directory-head">
            <h2>Connections</h2>
            <div className="pv-switch" aria-label="Listing filter">
              <a
                href={providerLink(active?.p.provider_id ?? "", false)}
                aria-current={!free ? "true" : undefined}
              >
                All
              </a>
              <a
                href={providerLink(
                  active?.free ? active.p.provider_id : "",
                  true,
                )}
                aria-current={free ? "true" : undefined}
              >
                Marked free
              </a>
            </div>
          </div>
          {!!visible.length && (
            <NativeSelect
              className="pv-picker"
              label="Connection"
              value={active?.p.provider_id ?? ""}
              data={[
                ...(!active ? [{ value: "", label: "Select connection" }] : []),
                ...visible.map((g) => ({
                  value: g.p.provider_id,
                  label: `${g.p.provider_id} · ${known ? `${g.rows.length} listings · ${g.free} marked free` : "catalog unknown"}`,
                })),
              ]}
              onChange={(e) => {
                window.location.hash = providerLink(
                  e.currentTarget.value,
                  free,
                );
              }}
            />
          )}
          <nav className="pv-directory-list" aria-label="Select a connection">
            {visible.map((g) => (
              <a
                key={g.p.provider_id}
                href={providerLink(g.p.provider_id, free)}
                aria-current={g === active ? "page" : undefined}
              >
                <ProviderLogo providerId={g.p.provider_id} size={24} />
                <span className="pv-connection-label">
                  <strong>{g.p.provider_id}</strong>
                  <small>
                    {known
                      ? `${g.rows.length} ${g.rows.length === 1 ? "listing" : "listings"}`
                      : "Catalog unknown"}
                    {g.free > 0 && <em> · {g.free} marked free</em>}
                    {g.p.local_state && " · Local engine"}
                  </small>
                </span>
                <IconChevronRight size={14} />
              </a>
            ))}
          </nav>
          <p className="pv-directory-note">
            Free labels come from model IDs. Unlabeled listings may still be
            included in your plan.
          </p>
        </section>
        {active ? (
          <ProviderInventory
            key={JSON.stringify([active.p.provider_id, free])}
            p={active.p}
            rows={active.rows}
            countFree={active.free}
            known={known}
            catalogError={!!catalog.error}
            free={free}
          />
        ) : (
          <section className="pv-empty">
            <IconServer2 />
            <h2>
              {connections.data === undefined
                ? connections.error
                  ? "Connections unavailable"
                  : "Loading connections…"
                : !groups.length
                  ? "No configured connections"
                  : free && !known
                    ? catalog.error
                      ? "Free labels unavailable"
                      : "Reading the catalog…"
                    : id
                      ? "Connection not in this view"
                      : "No listings marked free"}
            </h2>
            <p>
              {free
                ? "A missing free label does not establish a price. Switch to all connections to inspect the full catalog."
                : id
                  ? "Select a connection from the directory."
                  : "Connections are defined in the router configuration."}
            </p>
            {(free || id) && (
              <a href={providerLink("", false)}>Show all connections →</a>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function ProviderInventory({
  p,
  rows,
  countFree,
  known,
  catalogError,
  free,
}: {
  p: ProviderInfo;
  rows: LiveCatalogModel[];
  countFree: number;
  known: boolean;
  catalogError: boolean;
  free: boolean;
}) {
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState("free"),
    [limit, setLimit] = useState(24);
  const keys = useMemo(
    () =>
      known
        ? JSON.stringify(
            [
              ...new Set(
                rows
                  .filter((r) => !free || freeLabel(r.upstream_id))
                  .map((r) => r.knowledge_key),
              ),
            ].sort(),
          )
        : null,
    [known, rows, free],
  );
  const index = useModelSummaries(keys),
    cards = useMemo(
      () => new Map(index.state?.cards?.map((c) => [c.key, c])),
      [index.state?.cards],
    );
  const shown = useMemo(
    () => inventoryRows(rows, cards, query, free, sort),
    [rows, cards, query, free, sort],
  );
  const local = p.local_state,
    idle = local ? idleSlots(local) : null;
  return (
    <section
      className="pv-inventory"
      aria-label={`${p.provider_id} model inventory`}
    >
      <header className="pv-inventory-head">
        <div className="pv-identity">
          <ProviderLogo providerId={p.provider_id} size={36} />
          <div>
            <span className="pv-kicker">Provider catalog</span>
            <h2>{p.provider_id}</h2>
          </div>
        </div>
        <span className="pv-tag">
          <IconDatabase size={12} />
          {p.catalog === "dynamic" ? "Synced catalog" : "From configuration"}
        </span>
      </header>
      <div className="pv-context">
        <span>
          <b>{known ? rows.length : "—"}</b> listings
        </span>
        <span>
          <b>{known ? countFree : "—"}</b> marked free
        </span>
        <span>
          Last refresh:{" "}
          <RelTime
            unix={p.last_refresh?.last_success_unix}
            fallback="not reported"
          />
        </span>
        <Copyable value={p.provider_id} size="xs">
          Connection ID
        </Copyable>
      </div>
      {p.last_refresh?.last_error && (
        <Alert color="orange" title="Last connection refresh failed">
          {p.last_refresh.last_error}
        </Alert>
      )}
      {local && (
        <div className="pv-engine">
          <IconServer2 size={18} />
          <div>
            <strong>
              Local engine ·{" "}
              {local.loaded === null
                ? "load state unknown"
                : local.loaded
                  ? "loaded"
                  : "not loaded"}
            </strong>
            <small>
              {local.model} ·{" "}
              {idle === null
                ? "slot availability not reported"
                : `${idle} of ${local.slots} slots idle at last read`}
            </small>
          </div>
        </div>
      )}
      <div className="pv-list-head">
        <div>
          <h3>{free ? "Models marked free" : "Model catalog"}</h3>
          <p>
            {free
              ? "These IDs carry a free label. Check quotas and plan terms separately."
              : "Use cases are shown inline. A free label is not a check of current quota or availability."}
          </p>
        </div>
        <div className="pv-related">
          <a href={drillUrl("balances", { provider: p.provider_id })}>
            Balances ↗
          </a>
          <a href={drillUrl("usage", { provider: p.provider_id })}>Usage ↗</a>
        </div>
      </div>
      <div className="pv-controls">
        <TextInput
          aria-label="Search model catalog"
          placeholder="Find a model or use case…"
          size="xs"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setLimit(24);
          }}
        />
        <NativeSelect
          aria-label="Sort listings"
          size="xs"
          leftSection={<IconAdjustmentsHorizontal size={14} />}
          value={sort}
          onChange={(e) => {
            setSort(e.currentTarget.value);
            setLimit(24);
          }}
          data={[
            { value: "free", label: "Marked free first" },
            { value: "name", label: "Name: A–Z" },
            { value: "context", label: "Largest context" },
          ]}
        />
      </div>
      {index.state?.error && (
        <div className="pv-index-note" role="status">
          Wiki summaries unavailable. Model IDs and context are still shown.{" "}
          <button onClick={index.reload}>Retry Wiki</button>
        </div>
      )}
      {known && rows.length > 0 && !index.state && (
        <div className="pv-index-note" role="status">
          Reading saved use cases…
        </div>
      )}
      {!known || !shown.length ? (
        <div className="pv-list-empty">
          <strong>
            {!known
              ? catalogError
                ? "Model list unavailable"
                : "Loading model listings…"
              : !rows.length
                ? "No models listed"
                : "No matching listings"}
          </strong>
          <p>
            {!known
              ? "A missing catalog is not an empty catalog."
              : !rows.length
                ? "This connection has no entries in the provider catalog."
                : `No match for “${query}” in this connection.`}
          </p>
          {query && <button onClick={() => setQuery("")}>Clear search</button>}
        </div>
      ) : (
        <>
          <div className="pv-count">
            Showing {Math.min(limit, shown.length)} of {shown.length} listings
          </div>
          <ul className="pv-models">
            {shown.slice(0, limit).map(({ row, name, brief, labeled }) => (
              <li key={row.upstream_id}>
                <div className="pv-model-main">
                  <div className="pv-model-title">
                    <h4>
                      <ModelHoverCard
                        upstreamId={row.upstream_id}
                        providerId={p.provider_id}
                      >
                        {name}
                      </ModelHoverCard>
                    </h4>
                    <span className={"pv-tag" + (labeled ? " is-free" : "")}>
                      {labeled ? "Marked free by provider" : "Price not reported"}
                    </span>
                  </div>
                  <div className="pv-brief">
                    <span>{brief.source || "Use case"}</span>
                    <p>
                      {brief.source || index.state?.cards
                        ? brief.text
                        : index.state?.error
                          ? "Wiki unavailable"
                          : "Reading use case…"}
                    </p>
                  </div>
                  <Copyable value={row.upstream_id} block size="xs" />
                </div>
                <div className="pv-model-spec">
                  <small>Context window</small>
                  <strong>
                    {row.context_tokens != null && row.context_tokens > 0
                      ? `${contextWindow(row.context_tokens)} tokens`
                      : "Not reported"}
                  </strong>
                  <a
                    href={drillUrl("wiki", { model: row.knowledge_key })}
                    aria-label={`Open Model Wiki for ${row.upstream_id}`}
                  >
                    <IconBook size={13} /> Model Wiki
                  </a>
                  {row.observed_at_unix != null && (
                    <small className="pv-seen">
                      Seen {dateTime(row.observed_at_unix)}
                    </small>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {limit < shown.length && (
            <Button
              size="xs"
              variant="default"
              mt="sm"
              onClick={() => setLimit((v) => v + 24)}
            >
              Show {Math.min(24, shown.length - limit)} more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
