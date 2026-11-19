import {
  ActionIcon,
  AppShell,
  Burger,
  Button,
  Modal,
  NativeSelect,
  TextInput,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconActivityHeartbeat,
  IconArrowRight,
  IconArrowsExchange,
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
import { useEffect, useRef, useState } from "react";
import { MOCK, keyStore, type Health } from "../api";
import {
  CADENCES,
  setCadence,
  useCadence,
  type Resource,
  type Route,
} from "../hooks";
import { uptime } from "../format";
import { COMPONENTS } from "../pages/overview";
import { findCommands, sections, shortcuts } from "./workspace-commands";
import "./workspace-chrome.css";

export type Destination = {
  route: Route;
  label: string;
  icon: typeof IconSearch;
};
type Tool = "jump" | "system" | "connection";

export function WorkspaceChrome({
  nav,
  route,
  navOpened,
  toggleNav,
  closeNav,
  health,
  lock,
}: {
  nav: Destination[];
  route: Route;
  navOpened: boolean;
  toggleNav: () => void;
  closeNav: () => void;
  health: Resource<Health>;
  lock: () => void;
}) {
  const [tool, setTool] = useState<Tool | null>(null),
    [query, setQuery] = useState(""),
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
  async function copyEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopyState("Copied API base URL.");
    } catch {
      endpointField.current?.focus();
      endpointField.current?.select();
      setCopyState("Clipboard unavailable. Copy the selected URL manually.");
    }
  }
  const close = () => {
    setTool(null);
    setConfirm(false);
  };
  const open = (next: Tool) => {
    setCopyState("");
    closeNav();
    setQuery("");
    setActive(0);
    setConfirm(false);
    setTool(next);
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
      setTool("jump");
    }
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [tool, closeNav]);
  const destination = nav.find((n) => n.route === route)!;
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
  const endpoint = `${window.location.origin}/v1`;
  const options = findCommands(nav, query);
  function choose(target: string) {
    if (target === "system" || target === "connection") {
      open(target);
      return;
    }
    close();
    window.location.hash = target;
  }
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
          <a
            className="ws-brand"
            href="#/overview"
            onClick={closeNav}
            aria-label="Router overview"
          >
            <span className="ws-mark">
              <IconArrowsExchange size={21} stroke={1.9} />
            </span>
            <strong>llm-router</strong>
          </a>
          <div className="ws-trail">
            <span>{sections[route]}</span>
            <IconChevronRight size={12} />
            <b>{destination.label}</b>
          </div>
          <button
            className="ws-jump"
            aria-label="Open command menu"
            title={`Jump to a page or task (${shortcutKey})`}
            onClick={() => open("jump")}
          >
            <IconSearch size={16} />
            <span>Jump to a page or task</span>
            <kbd>{shortcutKey}</kbd>
          </button>
          <button
            className="ws-health"
            data-state={state}
            aria-label={`Inspect system health: ${status}`}
            title={`Last successful health read: ${checked}`}
            onClick={() => open("system")}
          >
            <i />
            <span>{status}</span>
            <IconChevronRight size={12} />
          </button>
        </div>
      </AppShell.Header>
      <AppShell.Footer className="ws-footer">
        <button
          className="ws-instance"
          onClick={() => open("connection")}
          aria-label="Open connection tools"
        >
          <IconTerminal2 size={16} />
          <strong>{MOCK ? "Demo workspace" : window.location.host}</strong>
          <IconChevronRight size={12} />
        </button>
        <span className="ws-footer-space" />
        <span className="ws-checked">
          Health read{" "}
          <time
            title={
              health.updatedAt
                ? new Date(health.updatedAt).toLocaleString()
                : undefined
            }
          >
            {checked}
          </time>
        </span>
        <button
          className="ws-poll"
          onClick={() => open("system")}
          aria-label="Polling settings"
        >
          <IconRefresh size={13} />
          {cadence ? `Poll ${cadence / 1000}s` : "Polling off"}
        </button>
        <button
          className="ws-session"
          onClick={() => open("connection")}
          aria-label="Session details"
        >
          <IconKey size={14} />
          <span>
            {keys === "browser"
              ? "Browser key"
              : keys === "tab"
                ? "Tab key"
                : keys === "demo"
                  ? "Demo"
                  : "No key"}
          </span>
        </button>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="toggle color scheme"
          title={dark ? "Light theme" : "Dark theme"}
          onClick={() => setColorScheme(dark ? "light" : "dark")}
        >
          {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
        </ActionIcon>
      </AppShell.Footer>
      <Modal
        opened={tool !== null}
        onClose={close}
        centered
        size="33rem"
        classNames={{ content: "ws-modal" }}
        title={
          <span className="ws-modal-title">
            {tool === "jump" ? (
              <IconCommand />
            ) : tool === "system" ? (
              <IconActivityHeartbeat />
            ) : (
              <IconPlugConnected />
            )}
            {tool === "jump"
              ? "Command menu"
              : tool === "system"
                ? "System inspector"
                : "Connection tools"}
          </span>
        }
      >
        {tool === "jump" && (
          <>
            <TextInput
              data-autofocus
              aria-label="Find a page or task"
              placeholder="Try “failed requests”, “API URL”, “wiki”…"
              value={query}
              onChange={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
              }}
              leftSection={<IconSearch size={15} />}
              role="combobox"
              aria-expanded
              aria-autocomplete="list"
              aria-controls="ws-results"
              aria-activedescendant={
                options[active] ? `ws-command-${active}` : undefined
              }
              onKeyDown={(e) => {
                if (!options.length || e.nativeEvent.isComposing) return;
                let i = active;
                if (e.key === "ArrowDown") i = (active + 1) % options.length;
                else if (e.key === "ArrowUp")
                  i = (active + options.length - 1) % options.length;
                else if (e.key === "Enter") {
                  e.preventDefault();
                  choose(options[active].target);
                  return;
                } else return;
                e.preventDefault();
                setActive(i);
                document
                  .getElementById(`ws-command-${i}`)
                  ?.scrollIntoView({ block: "nearest" });
              }}
            />
            <div
              role="listbox"
              aria-label="Pages and tasks"
              id="ws-results"
              className="ws-results"
            >
              {options.map((o, i) => (
                <div
                  key={o.target}
                  role="option"
                  id={`ws-command-${i}`}
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o.target)}
                >
                  <span className="ws-command-icon">
                    {shortcuts.includes(o) ? (
                      <IconTerminal2 size={15} />
                    ) : (
                      <IconArrowRight size={15} />
                    )}
                  </span>
                  <span>
                    <strong>{o.label}</strong>
                    <small>{o.detail}</small>
                  </span>
                  <span className="ws-enter" aria-hidden>
                    ↵
                  </span>
                </div>
              ))}
            </div>
            {!options.length && (
              <p className="ws-note" role="status">
                No matching page or task. Try a page name or “health”.
              </p>
            )}
            <div className="ws-help">
              ↑ ↓ to navigate <span>Enter to open · Esc to close</span>
            </div>
          </>
        )}
        {tool === "system" && (
          <>
            <div className="ws-readout" data-state={state}>
              <div>
                <small>Core health</small>
                <strong>{status}</strong>
              </div>
              <div>
                <small>
                  {failed ? "Last successful read" : "Health read at"}
                </small>
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
                The latest health check failed. The last successful check is not
                current status.
              </p>
            )}
            <div className="ws-section-title">Reported components</div>
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
                        v?.ok === true
                          ? "ok"
                          : v?.ok === false
                            ? "warn"
                            : "unknown"
                      }
                    >
                      {v?.ok === true
                        ? "OK"
                        : v?.ok === false
                          ? "Degraded"
                          : "Unknown"}
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
                label="Auto-refresh interval"
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
                Check health now
              </Button>
            </div>
            <p className="ws-note">
              Checks read the core. They do not refresh provider balances or
              send a model request.
            </p>
          </>
        )}
        {tool === "connection" && (
          <>
            <div className="ws-section-title">
              {MOCK ? "Preview environment" : "Client API base URL"}
            </div>
            {MOCK ? (
              <p className="ws-note">
                Demo mode uses fixtures, not a live router connection.
              </p>
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
                  <Button size="xs" variant="default" onClick={copyEndpoint}>
                    Copy URL
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
                <Button
                  variant="default"
                  size="xs"
                  onClick={() => setConfirm(true)}
                >
                  Forget local key…
                </Button>
              ) : (
                <div className="ws-confirm">
                  <p>
                    This signs this browser out. It does not revoke the key on
                    the router.
                  </p>
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => setConfirm(false)}
                  >
                    Keep session
                  </Button>
                  <Button size="xs" color="red" onClick={lock}>
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
