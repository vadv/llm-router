import { AppShell, Box, Container, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconActivity,
  IconBook,
  IconChartArea,
  IconGauge,
  IconHistory,
  IconLayoutDashboard,
  IconMessages,
  IconPlugConnected,
  IconStack2,
} from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import { MOCK, api, keyStore, setUnauthorizedHandler } from "./api";
import { KeyGate } from "./components/ui";
import { sections } from "./components/workspace-commands";
import { WorkspaceChrome } from "./components/workspace-chrome";
import { usePoll, useRoute, useTitle, type Route } from "./hooks";
import { ActivityPage } from "./pages/activity";
import { BalancesPage } from "./pages/balances";
import { ChatPage } from "./pages/chat";
import { HistoryPage } from "./pages/history";
import { OverviewPage } from "./pages/overview";
import { PoolsPage } from "./pages/pools";
import { ProvidersPage } from "./pages/providers";
import { UsagePage } from "./pages/usage";
import { WikiPage } from "./pages/wiki";

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

const TITLES: Record<Route, string> = {
  overview: "Overview",
  usage: "Usage",
  balances: "Balances",
  providers: "Providers",
  pools: "Pools",
  history: "Request history",
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

function Dashboard({ lock }: { lock: () => void }) {
  const { route, hash } = useRoute();
  const [navOpened, { toggle: toggleNav, close: closeNav }] =
    useDisclosure(false);
  const health = usePoll(api.health, []);
  useTitle(TITLES[route]);
  return (
    <AppShell
      header={{ height: 54 }}
      footer={{ height: 36 }}
      navbar={{
        width: 200,
        breakpoint: "sm",
        collapsed: { mobile: !navOpened },
      }}
      padding={0}
    >
      <WorkspaceChrome
        nav={NAV}
        route={route}
        navOpened={navOpened}
        toggleNav={toggleNav}
        closeNav={closeNav}
        health={health}
        lock={lock}
      />

      <AppShell.Navbar p="xs">
        <AppShell.Section grow style={{ overflowY: "auto" }}>
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
                  px="sm"
                  py={7}
                  mb={2}
                  aria-current={active ? "page" : undefined}
                  style={{
                    borderRadius: "var(--mantine-radius-sm)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: active
                      ? "var(--mantine-color-teal-light)"
                      : undefined,
                    color: active
                      ? "var(--mantine-color-teal-light-color)"
                      : "var(--mantine-color-text)",
                  }}
                >
                  <Icon size={16} stroke={active ? 2 : 1.7} />
                  <Text size="sm" fw={active ? 600 : 400}>
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
          style={{ maxWidth: route === "chat" ? "none" : 1600, margin: "0 auto" }}
        >
          {route === "overview" && <OverviewPage health={health} />}
          {route === "usage" && <UsagePage />}
          {route === "providers" && <ProvidersPage />}
          {route === "pools" && <PoolsPage />}
          {route === "history" && <HistoryPage />}
          {route === "balances" && <BalancesPage />}
          {route === "activity" && <ActivityPage />}
          {route === "wiki" && <WikiPage />}
          {route === "chat" && <ChatPage />}
        </Container>
      </AppShell.Main>
    </AppShell>
  );
}
