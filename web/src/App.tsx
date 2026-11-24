import { AppShell, Box, Container, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconActivity,
  IconArrowsExchange,
  IconBook,
  IconChartArea,
  IconGauge,
  IconHistory,
  IconLayoutDashboard,
  IconMessages,
  IconPlugConnected,
  IconStack2,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MOCK, api, keyStore, setUnauthorizedHandler, type Health } from "./api";
import { KeyGate } from "./components/ui";
import { sections } from "./components/workspace-commands";
import { WorkspaceChrome } from "./components/workspace-chrome";
import { usePoll, useRoute, useTitle, type Resource, type Route } from "./hooks";
import { ActivityPage } from "./pages/activity";
import { BalancesPage } from "./pages/balances";
import { HistoryPage } from "./pages/history";
import { OverviewPage } from "./pages/overview";
import { PoolsPage } from "./pages/pools";
import { ProvidersPage } from "./pages/providers";
import { UsagePage } from "./pages/usage";
import { WikiPage } from "./pages/wiki";

// The chat brings its own runtime (markdown, tools, a sandbox). It loads
// when it is opened, not on every page.
const ChatPage = lazy(() =>
  import("./pages/chat").then((page) => ({ default: page.ChatPage })),
);

const NAV: { route: Route; label: string; icon: typeof IconLayoutDashboard }[] =
  [
    { route: "overview", label: "Overview", icon: IconLayoutDashboard },
    { route: "usage", label: "Usage", icon: IconChartArea },
    { route: "balances", label: "Balances", icon: IconGauge },
    { route: "providers", label: "Providers", icon: IconPlugConnected },
    { route: "pools", label: "Pools", icon: IconStack2 },
    { route: "history", label: "Requests", icon: IconHistory },
    { route: "activity", label: "Router events", icon: IconActivity },
    { route: "wiki", label: "Model Wiki", icon: IconBook },
    { route: "chat", label: "Chat", icon: IconMessages },
  ];

// The label the browser tab and the command menu use. The sidebar says the
// same, so a page is never named two ways.
const TITLES: Record<Route, string> = {
  overview: "Overview",
  usage: "Usage",
  balances: "Balances",
  providers: "Providers",
  pools: "Pools",
  history: "Requests",
  activity: "Router events",
  wiki: "Model Wiki",
  chat: "Chat",
};

export function App() {
  const [unlocked, setUnlocked] = useState(
    () => MOCK || keyStore.get() !== null,
  );

  useEffect(() => {
    // A rejected key anywhere drops back to the gate instead of a half-empty page.
    setUnauthorizedHandler(() => {
      keyStore.clear();
      setUnlocked(false);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const lock = useCallback(() => {
    keyStore.clear();
    setUnlocked(false);
    window.location.hash = "";
  }, []);

  if (!unlocked) {
    return <KeyGate onUnlock={() => setUnlocked(true)} />;
  }

  return <Dashboard lock={lock} />;
}

function ChatLoading() {
  return (
    <div className="chat-loading" role="status">
      Loading chat…
    </div>
  );
}

/// One broken page must not take the shell down with it: the navigation
/// stays, the page says what happened, and a retry is one click away.
/// A page that loads on demand was not on the server any more: the router
/// was redeployed while this tab stayed open on the previous build.
const PAGE_GONE = /dynamically imported module|module script failed|Load failed/i;

class PageBoundary extends Component<{ children: ReactNode; onRetry: () => void }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (PAGE_GONE.test(this.state.error.message))
      return (
        <div className="page-crash" role="alert">
          <h2>The router was updated</h2>
          <p>This page still runs the previous build, and part of it is no longer served.</p>
          <div className="page-crash-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    return (
      <div className="page-crash" role="alert">
        <h2>This page failed to render</h2>
        <p>The rest of the router still works. The error was:</p>
        <pre>{this.state.error.message}</pre>
        <div className="page-crash-actions">
          <button type="button" onClick={this.props.onRetry}>
            Try again
          </button>
          <a href="#/overview">Go to Overview</a>
        </div>
      </div>
    );
  }
}

const BUNDLE = /assets\/index-[\w-]+\.js/;

/// A deploy restarts the core. A page opened before then keeps running the
/// old build, and a part of it that loads late is no longer served. So a
/// restart is followed by a look at what the router serves now: if that is
/// another build, the page reloads itself while nobody is looking, and asks
/// first otherwise.
function useFreshBuild(health: Resource<Health>) {
  const uptime = useRef<number | null>(null);
  useEffect(() => {
    const data = health.data;
    if (MOCK || !data || !Number.isFinite(data.uptime_unix)) return;
    const previous = uptime.current;
    uptime.current = data.uptime_unix;
    // The core counts its age on its own clock, and readings are seconds
    // apart, so from one reading to the next the age grows. Anything else
    // means the core restarted in between.
    if (previous === null || data.uptime_unix > previous) return;
    const reload = () => window.location.reload();
    void (async () => {
      try {
        const served = BUNDLE.exec(await (await fetch("/", { cache: "no-store" })).text())?.[0];
        const running = [...document.scripts].map((script) => BUNDLE.exec(script.src)?.[0]).find(Boolean);
        // The same build, or no build this can read (the dev server).
        if (!served || !running || served === running) return;
        if (document.hidden) return reload();
        notifications.show({
          id: "stale-build",
          title: "The router was updated",
          message: (
            <>
              This page still runs the previous build.{" "}
              <button type="button" className="link-button" onClick={reload}>
                Reload
              </button>
            </>
          ),
          autoClose: false,
        });
        const whenHidden = () => {
          if (!document.hidden) return;
          document.removeEventListener("visibilitychange", whenHidden);
          reload();
        };
        document.addEventListener("visibilitychange", whenHidden);
      } catch {
        // Which build is served cannot be read; the page goes on as it is.
      }
    })();
  }, [health.data]);
}

function Dashboard({ lock }: { lock: () => void }) {
  const { route, hash } = useRoute();
  // A page that threw tries again when it is left and reopened.
  const [critical, retry] = useState(0);
  const [navOpened, { toggle: toggleNav, close: closeNav }] =
    useDisclosure(false);
  const health = usePoll(api.health, []);
  useFreshBuild(health);
  useTitle(TITLES[route]);
  return (
    <AppShell
      header={{ height: 50 }}
      navbar={{
        width: 216,
        breakpoint: "sm",
        collapsed: { mobile: !navOpened },
      }}
      padding={0}
    >
      <WorkspaceChrome
        nav={NAV}
        navOpened={navOpened}
        toggleNav={toggleNav}
        closeNav={closeNav}
        health={health}
        lock={lock}
      />

      <AppShell.Navbar p="xs">
        <AppShell.Section grow style={{ overflowY: "auto" }}>
          <Box
            component="a"
            className="nav-brand"
            href="#/overview"
            onClick={closeNav}
            aria-label="Router overview"
          >
            <span className="brand-mark">
              <IconArrowsExchange size={17} stroke={2} />
            </span>
            <strong>llm-router</strong>
          </Box>
          {NAV.map(({ route: item, label, icon: Icon }, index) => {
            const active = item === route;
            return (
              <div key={item}>
                {(index === 0 ||
                  sections[NAV[index - 1].route] !== sections[item]) && (
                  <div className="nav-section">{sections[item]}</div>
                )}
                <Box
                  component="a"
                  href={`#/${item}`}
                  className="nav-destination"
                  onClick={closeNav}
                  aria-current={active ? "page" : undefined}
                >
                  <Icon size={16} stroke={active ? 1.9 : 1.6} />
                  <Text component="span" size="sm" inherit>
                    {label}
                  </Text>
                </Box>
              </div>
            );
          })}
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Container
          key={route === "overview" || route === "wiki" || route === "providers" ? route : hash}
          fluid
          px={route === "chat" ? 0 : { base: "sm", sm: "md" }}
          py={route === "chat" ? 0 : "sm"}
          style={{ maxWidth: route === "chat" ? "none" : 1480, margin: "0 auto" }}
        >
          <PageBoundary key={`${route}/${critical}`} onRetry={() => retry((n) => n + 1)}>
            {route === "overview" && <OverviewPage health={health} />}
            {route === "usage" && <UsagePage />}
            {route === "providers" && <ProvidersPage />}
            {route === "pools" && <PoolsPage />}
            {route === "history" && <HistoryPage />}
            {route === "balances" && <BalancesPage />}
            {route === "activity" && <ActivityPage />}
            {route === "wiki" && <WikiPage />}
            {route === "chat" && (
              <Suspense fallback={<ChatLoading />}>
                <ChatPage />
              </Suspense>
            )}
          </PageBoundary>
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
