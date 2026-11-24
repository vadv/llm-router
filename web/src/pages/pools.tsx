import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowRight,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { ApiError, type Pool, api } from "../api";
import { ModelHoverCard } from "../components/model-card";
import { Copyable, PageHeader, Panel } from "../components/ui";
import { routeParam, usePoll } from "../hooks";

import { PoolBuilder, poolGoals, type PoolDraft } from "./pool-builder";

export function PoolsPage() {
  const pools = usePoll(api.pools, []);
  const providers = usePoll(api.providers, []);
  const [query, setQuery] = useState(() => routeParam("q") ?? "");
  const [draft, setDraft] = useState<PoolDraft | null>(null);
  const [victim, setVictim] = useState<Pool | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = pools.data ?? [];
    if (!needle) return list;
    return list.filter(
      (pool) =>
        pool.name.toLowerCase().includes(needle) ||
        pool.members.some((member) =>
          `${member.provider_id} ${member.upstream_id}`
            .toLowerCase()
            .includes(needle),
        ),
    );
  }, [pools.data, query]);

  const providerIds = (providers.data ?? []).map(
    (provider) => provider.provider_id,
  );

  const remove = async () => {
    if (!victim) return;
    setBusy(true);
    try {
      await api.deletePool(victim.name);
      notifications.show({
        color: "teal",
        message: `pool ${victim.name} deleted`,
      });
      setVictim(null);
      pools.reload();
    } catch (failure) {
      notifications.show({ color: "red", message: errorText(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Pools"
        description="One model name for clients, backed by an ordered list of models."
        actions={
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={() => setDraft({ name: "", members: [], existing: false })}
            disabled={providerIds.length === 0}
          >
            New pool
          </Button>
        }
      />

      {(pools.error || providers.error) && (
        <Alert color="red" variant="light" mb="md">
          {pools.error ?? providers.error}
        </Alert>
      )}

      <section className="pb-launch" aria-label="Start a pool">
        <div>
          <h2>New pool for</h2>
          <p
            className="pb-chooser-help"
            title="A model that builds a web page is not necessarily one that reads a screenshot."
          >
            Start from the task. The builder then checks each model for it.
          </p>
        </div>
        <div className="pb-launch-goals">
          {poolGoals
            .filter((g) => g.value !== "fit")
            .map((g) => (
              <Button
                key={g.value}
                variant="default"
                className="pb-launch-choice"
                size="sm"
                aria-label={g.label}
                leftSection={<g.icon size={15} />}
                disabled={!providerIds.length}
                onClick={() =>
                  setDraft({
                    name: "",
                    members: [],
                    existing: false,
                    goal: g.value,
                  })
                }
              >
                <span><strong>{g.label}</strong><small>{g.example}</small></span>
                <IconArrowRight className="pb-launch-go" size={13} />
              </Button>
            ))}
        </div>
      </section>
      <Group mb="sm" gap="sm" align="center">
        <TextInput
          size="xs"
          aria-label="Search pools and members"
          placeholder="Search pools and members"
          leftSection={<IconSearch size={14} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          style={{ flex: 1, maxWidth: 340 }}
        />
        <Text size="xs" c="dimmed">
          {pools.data && `${visible.length} of ${pools.data.length} pools`}
        </Text>
      </Group>

      {pools.data === undefined ? (
        <Text size="sm" c="dimmed">
          loading…
        </Text>
      ) : pools.data.length === 0 ? (
        <Panel>
          <Stack gap="xs" py="sm" align="flex-start">
            <Text size="sm" fw={500}>
              No pools yet
            </Text>
            <Text size="sm" c="dimmed">
              Add members from the configured providers. The first member is
              tried first; the rest are fallbacks.
            </Text>
            <Button
              disabled={providerIds.length === 0}
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() =>
                setDraft({ name: "", members: [], existing: false })
              }
            >
              Create the first pool
            </Button>
          </Stack>
        </Panel>
      ) : visible.length === 0 ? (
        <Panel
          title="No matching pools"
          description="Try a pool name, provider or model."
        >
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setQuery("")}
          >
            Clear search
          </Button>
        </Panel>
      ) : (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="xs">
          {visible.map((pool) => (
            <Panel
              key={pool.name}
              // A pool name is an identifier: it wraps before it would be cut.
              title={<Copyable value={pool.name} size="sm" block />}
              description={
                pool.members.length > 1
                  ? `${pool.members.length - 1} fallback${pool.members.length === 2 ? "" : "s"} available`
                  : pool.members.length === 1
                    ? "Single member · no fallback"
                    : "No route configured"
              }
              actions={
                <Group gap={2}>
                  <Tooltip label="Edit members" withArrow>
                    <ActionIcon
                      variant="subtle"
                      size="lg"
                      aria-label="edit pool"
                      onClick={() =>
                        setDraft({
                          name: pool.name,
                          members: [...pool.members],
                          existing: true,
                        })
                      }
                    >
                      <IconPencil size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Delete pool" withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="lg"
                      aria-label="delete pool"
                      onClick={() => setVictim(pool)}
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              }
            >
              <Stack gap={6}>
                {pool.members.length === 0 && (
                  <Text size="xs" c="dimmed">
                    No members. This pool cannot serve a request.
                  </Text>
                )}
                {pool.members.map((member, index) => (
                  <Group
                    key={`${member.provider_id}/${member.upstream_id}`}
                    gap={8}
                    wrap="nowrap"
                  >
                    <Badge
                      variant={index ? "default" : "light"}
                      color="teal"
                      size="xs"
                      tt="none"
                      style={{ flexShrink: 0 }}
                    >
                      {index ? `#${index + 1}` : "First"}
                    </Badge>
                    <Badge
                      size="xs"
                      variant="default"
                      tt="lowercase"
                      style={{ flexShrink: 0 }}
                    >
                      {member.provider_id}
                    </Badge>
                    <ModelHoverCard
                      upstreamId={member.upstream_id}
                      providerId={member.provider_id}
                      block
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <Text size="xs" ff="monospace" truncate>
                        {member.upstream_id}
                      </Text>
                    </ModelHoverCard>
                  </Group>
                ))}
              </Stack>
              <Button
                mt="xs"
                px={0}
                size="compact-xs"
                variant="subtle"
                rightSection={<IconArrowRight size={12} />}
                disabled={!providerIds.length}
                aria-label={`Build a similar pool to ${pool.name}`}
                onClick={() =>
                  setDraft({
                    name: "",
                    members: [],
                    existing: false,
                    reference: pool.name,
                  })
                }
              >
                Build a similar pool
              </Button>
            </Panel>
          ))}
        </SimpleGrid>
      )}

      {draft && (
        <PoolBuilder
          pools={pools.data ?? []}
          draft={draft}
          providerIds={providerIds}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            pools.reload();
          }}
        />
      )}

      <Modal
        opened={victim !== null}
        onClose={() => setVictim(null)}
        title="Delete pool"
        centered
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            Delete <Code>{victim?.name}</Code>? Clients that still send this
            name get a 404 from the core.
          </Text>
          <Group justify="flex-end" gap="xs">
            <Button
              variant="default"
              size="xs"
              onClick={() => setVictim(null)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button color="red" size="xs" onClick={remove} loading={busy}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

function errorText(failure: unknown): string {
  if (failure instanceof ApiError || failure instanceof Error)
    return failure.message;
  return String(failure);
}
