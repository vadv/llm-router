import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Button,
  Modal,
  NativeSelect,
  TextInput,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconActivityHeartbeat,
  IconArrowRight,
  IconArrowsExchange,
  IconBook,
  IconBolt,
  IconChevronRight,
  IconCommand,
  IconKey,
  IconMoon,
  IconPlugConnected,
  IconRefresh,
  IconSearch,
  IconSun,
  IconTerminal2,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MOCK, api, keyStore, type Health, type LiveCatalogModel } from "../api";
import {
  CADENCES,
  setCadence,
  useCadence,
  type Resource,
  type Route,
} from "../hooks";
import { uptime } from "../format";
import { COMPONENTS } from "../pages/overview";
import { findCommands, isAction, shortcuts, type CommandAction } from "./workspace-commands";
import "./workspace-chrome.css";

export type Destination = {
  route: Route;
  label: string;
  icon: typeof IconSearch;
};
type Tool = "jump" | "system" | "connection";

// The catalog is read for model search and kept for a few minutes, so the
// command menu opens without a request each time.
const CATALOG_TTL = 5 * 60_000;
let catalogCache: { at: number; rows: LiveCatalogModel[] } | null = null;
function loadCatalog(): Promise<LiveCatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL)
    return Promise.resolve(catalogCache.rows);
  return api
    .catalog()
    .then((rows) => {
      catalogCache = { at: Date.now(), rows };
      return rows;
    })
    .catch(() => catalogCache?.rows ?? []);
}

/// The models of the catalog that answer to a query, one row per model.
function findModels(rows: LiveCatalogModel[], query: string): LiveCatalogModel[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const seen = new Set<string>();
  const rank = (row: LiveCatalogModel) =>
    row.knowledge_key.toLowerCase().startsWith(needle) ||
    row.upstream_id.toLowerCase().split("/").pop()!.startsWith(needle)
      ? 0
      : 1;
  return rows
    .filter((row) => {
      const hit =
        !seen.has(row.knowledge_key) &&
        (row.knowledge_key.toLowerCase().includes(needle) ||
          row.upstream_id.toLowerCase().includes(needle));
      if (hit) seen.add(row.knowledge_key);
      return hit;
    })
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.knowledge_key.localeCompare(b.knowledge_key) ||
        a.provider_id.localeCompare(b.provider_id),
    )
    .slice(0, 6);
}

export function WorkspaceChrome({
  nav,
  navOpened,
  toggleNav,
  closeNav,
  health,
  lock,
}: {
  nav: Destination[];
  navOpened: boolean;
  toggleNav: () => void;
  closeNav: () => void;
  health: Resource<Health>;
  lock: () => void;
}) {
  const [tool, setTool] = useState<Tool | null>(null),
    [query, setQuery] = useState(""),
    [models, setModels] = useState<LiveCatalogModel[]>([]),
    [active, setActive] = useState(0),
    [checking, setChecking] = useState(false),
    [confirm, setConfirm] = useState(false);
  const cadence = useCadence();
  const { setColorScheme } = useMantineColorScheme(),
    dark =
      useComputedColorScheme("dark", { getInitialValueInEffect: true }) ===
      "dark";
  const endpointField = useRef<HTMLInputElement>(null),
    [copyState, setCopyState] = useState("");
  const endpoint = `${window.location.origin}/v1`;
  const close = () => {
    setTool(null);
    setConfirm(false);
  };
  const open = (next: Tool) => {
    setCopyState("");
    closeNav();
    setQuery("");
    setActive(0);
    setModels([]);
    setConfirm(false);
    setTool(next);
  };
  const run = (action: CommandAction) => {
    switch (action) {
      case "system":
      case "connection":
        open(action);
        return;
      case "theme":
        setColorScheme(dark ? "light" : "dark");
        return;
      case "copy-api":
        void copyEndpoint(true);
        return;
      case "refresh-balances":
      case "refresh-catalog": {
        const what = action === "refresh-balances" ? "balances" : "catalog";
        const label = what === "balances" ? "Balances" : "Model catalogs";
        api
          .refresh(what)
          .then(() =>
            notifications.show({
              message: `${label} refresh requested. The core runs it in the background.`,
            }),
          )
          .catch((failure: unknown) =>
            notifications.show({
              color: "red",
              message: failure instanceof Error ? failure.message : String(failure),
            }),
          );
        return;
      }
    }
  };
  async function copyEndpoint(fromMenu = false) {
    try {
      await navigator.clipboard.writeText(endpoint);
      if (fromMenu)
        notifications.show({ message: "API base URL copied." });
      else setCopyState("Copied API base URL.");
    } catch {
      endpointField.current?.focus();
      endpointField.current?.select();
      if (fromMenu) open("connection");
      setCopyState("Clipboard unavailable. Copy the selected URL manually.");
    }
  }
  const choose = (target: string) => {
    if (isAction(target)) {
      run(target);
      if (target === "copy-api") close();
      return;
    }
    close();
    window.location.hash = target;
  };
  useEffect(() => {
    function shortcut(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        e.repeat ||
        e.isComposing ||
        !(e.metaKey || e.ctrlKey) ||
        e.altKey ||
        e.shiftKey ||
        e.key.toLowerCase() !== "k"
      )
        return;
      if (tool === "jump") {
        e.preventDefault();
        setTool(null);
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      closeNav();
      setQuery("");
      setActive(0);
      setModels([]);
      setTool("jump");
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [tool, closeNav]);
  // Model results follow the query; a late answer for an older query is dropped.
  useEffect(() => {
    if (tool !== "jump") return;
    let current = true;
    if (query.trim().length < 2) setModels([]);
    else
      void loadCatalog().then((rows) => {
        if (current) setModels(findModels(rows, query));
      });
    return () => {
      current = false;
    };
  }, [tool, query]);

  const data = health.data,
    failed = !!health.error,
    state = failed
      ? "unknown"
      : data?.status === "ok"
        ? "ok"
        : data?.status === "degraded"
          ? "warn"
          : "unknown";
  const status = failed
    ? "Unavailable"
    : state === "ok"
      ? "Healthy"
      : state === "warn"
        ? "Degraded"
        : "Checking";
  const checked = health.updatedAt
    ? new Date(health.updatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Not checked";
  const keys = MOCK ? "demo" : keyStore.scope();
  const options = findCommands(nav, query);
  const entries: { key: string; kind: "command" | "model"; label: string; detail: string; icon: ReactNode; choose: () => void }[] =
    [
      ...options.map((o) => ({
        key: o.target,
        kind: "command" as const,
        label: o.label,
        detail: o.detail,
        icon: isAction(o.target) && o.target !== "system" && o.target !== "connection" ? <IconBolt size={15} /> : shortcuts.includes(o) ? <IconTerminal2 size={15} /> : <IconArrowRight size={15} />,
        choose: () => choose(o.target),
      })),
      ...models.map((row) => ({
        key: `model:${row.provider_id}/${row.upstream_id}`,
        kind: "model" as const,
        label: row.knowledge_key,
        detail: `Model · ${row.provider_id} / ${row.upstream_id}`,
        icon: <IconBook size={15} />,
        choose: () => {
          close();
          window.location.hash = `#/wiki?model=${encodeURIComponent(row.upstream_id)}`;
        },
      })),
    ];
  async function check() {
    setChecking(true);
    try {
      await health.reload();
    } finally {
      setChecking(false);
    }
  }
  const shortcutKey = /Mac|iPhone|iPad/.test(navigator.platform)
    ? "⌘ K"
    : "Ctrl K";
  return (
    <>
      <AppShell.Header className="ws-header">
        <div className="ws-toolbar">
          <Burger
            aria-label={navOpened ? "Close navigation" : "Open navigation"}
            aria-expanded={navOpened}
            opened={navOpened}
            onClick={toggleNav}
            hiddenFrom="sm"
            size="sm"
          />
          <Box
            component="a"
            className="ws-brand"
            href="#/overview"
            onClick={closeNav}
            hiddenFrom="sm"
            aria-label="Router overview"
          >
            <span className="ws-mark">
              <IconArrowsExchange size={17} stroke={2} />
            </span>
            <strong>llm-router</strong>
          </Box>
          <button
            className="ws-jump"
            aria-label="Open command menu"
            title={`Search, jump or run a task (${shortcutKey})`}
            onClick={() => open("jump")}
          >
            <IconSearch size={15} />
            <span>Search models, pages and tasks</span>
            <kbd>{shortcutKey}</kbd>
          </button>
          <button
            className="ws-health"
            data-state={state}
            aria-label={`System health: ${status}. Open details`}
            title={failed ? "The last health check failed" : `Last health read ${checked}`}
            onClick={() => open("system")}
          >
            <i />
            <span>{status}</span>
          </button>
          <button
            className="ws-instance"
            onClick={() => open("connection")}
            aria-label="Connection and session"
            title="API endpoint and browser session"
          >
            <IconTerminal2 size={15} />
            <span>{MOCK ? "Demo" : window.location.host}</span>
            <IconChevronRight size={12} className="ws-instance-chevron" />
          </button>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="toggle color scheme"
            title={dark ? "Light theme" : "Dark theme"}
            onClick={() => setColorScheme(dark ? "light" : "dark")}
          >
            {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
          </ActionIcon>
        </div>
      </AppShell.Header>

      <Modal
        opened={tool !== null}
        onClose={close}
        centered
        size="32rem"
        withCloseButton={tool !== "jump"}
        classNames={{
          content: tool === "jump" ? "ws-modal ws-modal-command" : "ws-modal",
          header: "ws-modal-header",
          title: "ws-modal-title",
        }}
        title={
          tool === "system" ? (
            <span className="ws-modal-title">
              <IconActivityHeartbeat /> System health
            </span>
          ) : tool === "connection" ? (
            <span className="ws-modal-title">
              <IconPlugConnected /> Connection
            </span>
          ) : undefined
        }
      >
        {tool === "jump" && (
          <>
            <TextInput
              data-autofocus
              aria-label="Search, jump or run a task"
              placeholder="Search models, pages and tasks"
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              leftSection={<IconSearch size={15} />}
              rightSection={<IconCommand size={14} className="ws-dim" />}
              size="md"
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              aria-controls="ws-results"
              aria-activedescendant={entries[active] ? `ws-command-${active}` : undefined}
              onKeyDown={(e) => {
                if (!entries.length || e.nativeEvent.isComposing) return;
                let i = active;
                if (e.key === "ArrowDown") i = (active + 1) % entries.length;
                else if (e.key === "ArrowUp") i = (active + entries.length - 1) % entries.length;
                else if (e.key === "Enter") {
                  e.preventDefault();
                  entries[active].choose();
                  return;
                } else return;
                e.preventDefault();
                setActive(i);
                document
                  .getElementById(`ws-command-${i}`)
                  ?.scrollIntoView({ block: "nearest" });
              }}
            />
            <div role="listbox" aria-label="Pages, tasks and models" id="ws-results" className="ws-results">
              {entries.map((entry, i) => (
                <div
                  key={entry.key}
                  role="option"
                  id={`ws-command-${i}`}
                  aria-selected={i === active}
                  data-kind={entry.kind}
                  onMouseEnter={() => setActive(i)}
                  onClick={entry.choose}
                >
                  <span className="ws-command-icon">{entry.icon}</span>
                  <span className="ws-command-text">
                    <strong>{entry.label}</strong>
                    <small>{entry.detail}</small>
                  </span>
                  <span className="ws-enter" aria-hidden>
                    ↵
                  </span>
                </div>
              ))}
              {!entries.length && (
                <p className="ws-note" role="status">
                  No matching page, task or model. Try a name or “health”.
                </p>
              )}
            </div>
            <div className="ws-help">
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close
              </span>
              {query.trim().length >= 2 && models.length > 0 && (
                <span>{models.length} model{models.length === 1 ? "" : "s"}</span>
              )}
            </div>
          </>
        )}
        {tool === "system" && (
          <>
            <div className="ws-readout" data-state={state}>
              <div>
                <small>Core</small>
                <strong>{status}</strong>
              </div>
              <div>
                <small>{failed ? "Last successful read" : "Health read at"}</small>
                <b>{checked}</b>
              </div>
              <div>
                <small>Uptime{failed ? " (last read)" : ""}</small>
                <b>
                  {data && Number.isFinite(data.uptime_unix)
                    ? uptime(data.uptime_unix)
                    : "—"}
                </b>
              </div>
            </div>
            {failed && (
              <p className="ws-note" role="status">
                The latest health check failed. The last successful check is not current status.
              </p>
            )}
            <div className="ws-section-title">Components</div>
            <div className="ws-components">
              {data &&
                !failed &&
                Object.entries(data.components).map(([k, v]) => (
                  <div key={k}>
                    {COMPONENTS[k] ? (
                      <a href={`#/${COMPONENTS[k][1]}`} onClick={close}>
                        {COMPONENTS[k][0]}
                      </a>
                    ) : (
                      <span>{k}</span>
                    )}
                    <small
                      data-state={
                        v?.ok === true ? "ok" : v?.ok === false ? "warn" : "unknown"
                      }
                    >
                      {v?.ok === true ? "OK" : v?.ok === false ? "Degraded" : "Unknown"}
                      {v?.count != null ? ` · ${v.count}` : ""}
                    </small>
                  </div>
                ))}
            </div>
            {(!data || failed || !Object.keys(data.components).length) && (
              <p className="ws-note">No current component readings.</p>
            )}
            <div className="ws-settings">
              <NativeSelect
                size="xs"
                label="Auto-refresh"
                value={String(cadence)}
                data={CADENCES.map((n) => ({
                  value: String(n),
                  label: n ? `Every ${n / 1000} seconds` : "Off",
                }))}
                onChange={(e) => setCadence(Number(e.currentTarget.value))}
              />
              <Button
                size="xs"
                variant="default"
                leftSection={<IconRefresh size={14} />}
                loading={checking}
                onClick={check}
              >
                Check now
              </Button>
            </div>
            <p className="ws-note">
              Auto-refresh reloads the open page. It does not poll providers; the core does that on its own schedule.
            </p>
          </>
        )}
        {tool === "connection" && (
          <>
            <div className="ws-section-title">
              {MOCK ? "Preview environment" : "Client API base URL"}
            </div>
            {MOCK ? (
              <p className="ws-note">Demo mode uses fixtures, not a live router connection.</p>
            ) : (
              <>
                <div className="ws-endpoint">
                  <TextInput
                    ref={endpointField}
                    aria-label="Client API base URL"
                    size="xs"
                    value={endpoint}
                    readOnly
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button size="xs" variant="default" onClick={() => copyEndpoint()}>
                    Copy
                  </Button>
                </div>
                {copyState && (
                  <p role="status" className="ws-note">
                    {copyState}
                  </p>
                )}
              </>
            )}
            <div className="ws-section-title">Browser session</div>
            <p className="ws-note">
              {keys === "browser"
                ? "The client key is saved in this browser and survives a restart."
                : keys === "tab"
                  ? "The client key is stored for this tab only."
                  : keys === "demo"
                    ? "No client key is required for this preview."
                    : "No saved client key was found."}
            </p>
            {!MOCK &&
              (!confirm ? (
                <Button variant="default" size="xs" onClick={() => setConfirm(true)}>
                  Forget local key…
                </Button>
              ) : (
                <div className="ws-confirm">
                  <p>
                    This signs this browser out. It does not revoke the key on the router.
                  </p>
                  <Button size="xs" variant="default" onClick={() => setConfirm(false)}>
                    Keep session
                  </Button>
                  <Button size="xs" color="red" leftSection={<IconKey size={13} />} onClick={lock}>
                    Forget key and sign out
                  </Button>
                </div>
              ))}
          </>
        )}
      </Modal>
    </>
  );
}
