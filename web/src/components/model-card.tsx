// Researched model cards: the hover surface used at every model id in the
// dashboard, plus the structured views shared with the Wiki drawer.
// Everything comes from the core's /v1/management/models/knowledge GET;
// no provider is ever contacted from the browser.

import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  HoverCard,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconBolt,
  IconBook,
  IconCalendar,
  IconCheck,
  IconClock,
  IconCoin,
  IconCpu,
  IconExternalLink,
  IconSparkles,
} from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";
import type { KnowledgeCard, ModelKnowledge } from "../api";
import { contextWindow } from "../format";
import {
  useKnowledge,
  ensureKnowledge,
  type KnowledgeState,
} from "../model-knowledge";
import { safeHttpUrl, vendorColor } from "../model-key";
import { ProviderLogo } from "./provider-logo";
import { RelTime } from "./ui";

/// Wraps an inline model id with a research card. Only the text is the
/// target, never a table row: a full-row target would swallow clicks and
/// break the clickable history rows.
export function ModelHoverCard({
  upstreamId,
  providerId,
  children,
  block = false,
  style,
  position = "bottom-start",
}: {
  upstreamId: string | null | undefined;
  providerId?: string;
  children: ReactNode;
  /// Fill the parent width. Use inside table cells and flex rows so a
  /// truncated model id keeps its ellipsis.
  block?: boolean;
  /// Extra layout rules for the target, e.g. flex: 1 in a dense row.
  style?: CSSProperties;
  position?: "bottom-start" | "bottom" | "top-start" | "right-start";
}) {
  if (!upstreamId) return <>{children}</>;
  return (
    <HoverCard
      width="min(390px, calc(100vw - 24px))"
      events={{ hover: true, focus: true, touch: true }}
      position={position}
      openDelay={220}
      closeDelay={160}
      shadow="xl"
      radius="md"
      withArrow
      withinPortal
      interactive
      role="dialog"
      zIndex={400}
      onOpen={() => ensureKnowledge(upstreamId)}
    >
      <HoverCard.Target>
        <span
          className={
            block
              ? "model-hover-target model-hover-block"
              : "model-hover-target"
          }
          tabIndex={0}
          style={style}
          aria-label={`model ${upstreamId}, show details`}
        >
          {children}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown p={0} style={{ overflow: "hidden" }}>
        <HoverBody upstreamId={upstreamId} providerId={providerId} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function HoverBody({
  upstreamId,
  providerId,
}: {
  upstreamId: string;
  providerId?: string;
}) {
  const state = useKnowledge(upstreamId);
  const data = state.data,
    card = data?.card;
  const providers = [
    ...new Set(data?.catalog_entries.map((e) => e.provider_id) ?? []),
  ].sort();
  const rating = card?.ratings?.[0];
  return (
    <div className="wiki-preview">
      <div className="wiki-preview-scroll">
        <span className="wiki-kicker">
          <IconBook size={13} /> Model brief
        </span>
        <h3>{card?.canonical_name || upstreamId}</h3>
        {card?.canonical_name && <code>{upstreamId}</code>}
        <Group mt={6} gap={5}>
          <VendorBadge vendor={card?.vendor} />
          {data && <CardStatusBadge state={state} />}
        </Group>
        {state.loading && !data && (
          <Stack gap={5} mt="sm" aria-label="Reading research card">
            <Skeleton height={9} />
            <Skeleton height={9} width="75%" />
          </Stack>
        )}
        {state.error ? (
          <p>
            Research unavailable.{" "}
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => ensureKnowledge(upstreamId, true)}
            >
              Retry card
            </Button>
          </p>
        ) : (
          data && (
            <>
              <p className="wiki-preview-description">
                {card?.description ||
                  (card
                    ? "No description on file."
                    : "No research card yet. The catalog listings below are still useful.")}
              </p>
              {card && <MetaChips card={card} limit={2} />}
              {rating && (
                <div className="wiki-preview-score">
                  <div>
                    <small>Reported benchmark</small>
                    <strong>{rating.metric}</strong>
                    <span>
                      {rating.source}
                      {rating.as_of && " · " + rating.as_of}
                    </span>
                  </div>
                  <b>{rating.value}</b>
                </div>
              )}
            </>
          )
        )}
        {data ? (
          <div className="wiki-preview-routes">
            <small>Listed by · {providers.length}</small>
            {providers.length ? (
              <ProviderLabels providers={providers} limit={5} />
            ) : (
              <Text size="xs" c="dimmed">
                No current catalog listing
              </Text>
            )}
          </div>
        ) : (
          providerId && (
            <Text size="xs" c="dimmed">
              Viewed on {providerId}
            </Text>
          )
        )}
      </div>
      <footer>
        <Text size="xs" c="dimmed">
          {data?.collected_at_unix ? (
            <>
              <RelTime unix={data.collected_at_unix} /> · researched
            </>
          ) : (
            "Local reference"
          )}
        </Text>
        <WikiButton upstreamId={upstreamId} />
      </footer>
    </div>
  );
}

export function ProviderLabels({
  providers,
  limit,
}: {
  providers: string[];
  limit: number;
}) {
  return (
    <div className="wiki-labels">
      {providers.slice(0, limit).map((p) => (
        <span key={p}>
          <ProviderLogo providerId={p} size={13} />
          {p}
        </span>
      ))}
      {providers.length > limit && (
        <span>+{providers.length - limit} more</span>
      )}
    </div>
  );
}

export function WikiButton({ upstreamId }: { upstreamId: string }) {
  return (
    <Button
      component="a"
      href={`#/wiki?model=${encodeURIComponent(upstreamId)}`}
      variant="light"
      size="compact-xs"
      rightSection={<IconBook size={13} />}
      onClick={(e) => e.stopPropagation()}
    >
      Open in Wiki
    </Button>
  );
}

/// One card state for a Wiki tile: fresh, stale, missing, loading or failed.
export function CardStatusBadge({ state }: { state: KnowledgeState }) {
  if (state.loading || (!state.error && !state.data))
    return (
      <Badge size="xs" variant="light" color="blue">
        loading
      </Badge>
    );
  if (state.error)
    return (
      <Badge size="xs" variant="light" color="red">
        error
      </Badge>
    );
  if (!state.data?.card)
    return (
      <Badge size="xs" variant="default" color="gray">
        no card
      </Badge>
    );
  if (state.data.fresh) {
    return (
      <Badge
        size="xs"
        variant="light"
        color="teal"
        leftSection={<IconSparkles size={10} />}
      >
        fresh
      </Badge>
    );
  }
  return (
    <Badge
      size="xs"
      variant="light"
      color="orange"
      leftSection={<IconClock size={10} />}
    >
      stale
    </Badge>
  );
}

export function VendorBadge({ vendor }: { vendor: string | null | undefined }) {
  if (!vendor) return null;
  return (
    <Badge size="xs" variant="light" color={vendorColor(vendor)} tt="none">
      {vendor}
    </Badge>
  );
}

/// Compact metadata chips used on hover cards and Wiki tiles.
export function MetaChips({
  card,
  limit,
}: {
  card: KnowledgeCard;
  limit?: number;
}) {
  const chips: { icon: ReactNode; label: string; color: string }[] = [];
  if (card.context_window) {
    chips.push({
      icon: <IconCpu size={11} />,
      label: `${contextWindow(card.context_window)} ctx`,
      color: "blue",
    });
  }
  if (card.modality) {
    chips.push({
      icon: <IconBolt size={11} />,
      label: card.modality,
      color: "cyan",
    });
  }
  if (card.release_date) {
    chips.push({
      icon: <IconCalendar size={11} />,
      label: card.release_date,
      color: "grape",
    });
  }
  if (card.pricing_hint) {
    chips.push({
      icon: <IconCoin size={11} />,
      label:
        card.pricing_hint.length > 34
          ? `${card.pricing_hint.slice(0, 33)}…`
          : card.pricing_hint,
      color: "yellow",
    });
  }
  const shown = limit ? chips.slice(0, limit) : chips;
  if (shown.length === 0) return null;
  return (
    <Group gap={4} wrap="wrap">
      {shown.map((chip) => (
        <Badge
          key={chip.label}
          size="xs"
          variant="light"
          color={chip.color}
          tt="none"
          leftSection={chip.icon}
        >
          {chip.label}
        </Badge>
      ))}
    </Group>
  );
}

export function ModelCardBody({
  data,
  providerId,
}: {
  data: ModelKnowledge;
  providerId?: string;
}) {
  const card = data.card;
  if (!card) return null;
  const title = card.canonical_name ?? data.key;
  return (
    <Stack gap="sm">
      <Box>
        <Group gap={6} wrap="nowrap" align="center">
          {providerId && <ProviderLogo providerId={providerId} size={20} />}
          <Text fw={600} size="md" truncate style={{ minWidth: 0 }}>
            {title}
          </Text>
          <CardStatusBadge state={{ data, error: null, loading: false }} />
        </Group>
        <Group gap={4} mt={4} wrap="wrap">
          <VendorBadge vendor={card.vendor} />
          <Badge size="xs" variant="default" tt="lowercase" ff="monospace">
            {data.key}
          </Badge>
          {data.catalog_entries.length > 1 && (
            <Badge size="xs" variant="light" color="blue" tt="none">
              {data.catalog_entries.length} aliases
            </Badge>
          )}
        </Group>
      </Box>

      <Text size="xs" style={{ lineHeight: 1.45 }}>
        {card.description}
      </Text>

      <MetaChips card={card} />

      {card.family_line && (
        <Text size="xs" c="dimmed" style={{ lineHeight: 1.45 }}>
          <b>Family</b> · {card.family_line}
        </Text>
      )}

      <CardLists card={card} />

      {card.ratings.length > 0 && (
        <Box>
          <SectionLabel>ratings</SectionLabel>
          <Stack gap={6} mt={4}>
            {card.ratings.map((rating, index) => (
              <RatingRow
                key={`${rating.source}-${rating.metric}-${index}`}
                rating={rating}
              />
            ))}
          </Stack>
        </Box>
      )}

      {card.sources.length > 0 && (
        <Box>
          <SectionLabel>sources · {card.sources.length}</SectionLabel>
          <Stack gap={3} mt={4}>
            {card.sources.map((source) => {
              const url = safeHttpUrl(source);
              return url ? (
                <Anchor
                  key={source}
                  href={url}
                  target="_blank"
                  rel="noreferrer noopener"
                  size="11px"
                  c="dimmed"
                  className="wrap-anywhere"
                >
                  <Group gap={4} wrap="nowrap" align="flex-start">
                    <IconExternalLink
                      size={11}
                      style={{ flexShrink: 0, marginTop: 2 }}
                    />
                    <span>{source}</span>
                  </Group>
                </Anchor>
              ) : (
                <Text
                  key={source}
                  size="11px"
                  c="dimmed"
                  className="wrap-anywhere"
                >
                  {source}
                </Text>
              );
            })}
          </Stack>
        </Box>
      )}

      {card.pricing_hint && (
        <Box>
          <SectionLabel>pricing</SectionLabel>
          <Text size="xs" mt={4} style={{ lineHeight: 1.45 }}>
            {card.pricing_hint}
          </Text>
        </Box>
      )}
    </Stack>
  );
}

function RatingRow({ rating }: { rating: KnowledgeCard["ratings"][number] }) {
  return (
    <div className="wiki-preview-score">
      <div>
        <strong>{rating.metric}</strong>
        <span>
          {rating.source}
          {rating.as_of && " · " + rating.as_of}
        </span>
        {rating.note && <span>{rating.note}</span>}
      </div>
      <b>{rating.value}</b>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      size="11px"
      c="dimmed"
      tt="uppercase"
      fw={600}
      style={{ letterSpacing: 0.5 }}
    >
      {children}
    </Text>
  );
}

function CardLists({ card, limit }: { card: KnowledgeCard; limit?: number }) {
  const lists: {
    label: string;
    items: string[];
    color: string;
    icon: ReactNode;
  }[] = [
    {
      label: "strengths",
      items: card.strengths,
      color: "teal",
      icon: <IconCheck size={11} />,
    },
    {
      label: "weaknesses",
      items: card.weaknesses,
      color: "orange",
      icon: <IconAlertTriangle size={11} />,
    },
    {
      label: "use cases",
      items: card.use_cases,
      color: "blue",
      icon: <IconBolt size={11} />,
    },
  ];
  const shown = lists.filter((list) => list.items.length > 0);
  if (shown.length === 0) return null;
  return (
    <Group gap="md" align="flex-start" wrap="wrap">
      {shown.map((list) => (
        <Box key={list.label} style={{ flex: "1 1 160px", minWidth: 0 }}>
          <SectionLabel>{list.label}</SectionLabel>
          <Stack gap={3} mt={4}>
            {(limit ? list.items.slice(0, limit) : list.items).map(
              (item, index) => (
                <Group
                  key={`${list.label}-${index}`}
                  gap={5}
                  wrap="nowrap"
                  align="flex-start"
                >
                  <Box
                    c={`var(--mantine-color-${list.color}-5)`}
                    mt={2}
                    style={{ flexShrink: 0 }}
                  >
                    {list.icon}
                  </Box>
                  <Text size="11px" style={{ lineHeight: 1.4 }}>
                    {item}
                  </Text>
                </Group>
              ),
            )}
          </Stack>
        </Box>
      ))}
    </Group>
  );
}
