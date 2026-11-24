// The model preview that opens wherever a model id appears, and the small
// pieces the Wiki and the preview share. Everything comes from the core's
// knowledge endpoints; no provider is ever contacted from the browser.

import { HoverCard, Skeleton, Text } from "@mantine/core";
import { IconArrowUpRight } from "@tabler/icons-react";
import { useRef, type CSSProperties, type ReactNode } from "react";
import { contextWindow } from "../format";
import { benchmarkOrder } from "../benchmarks";
import { useClipped } from "../hooks";
import { ensureKnowledge, useKnowledge } from "../model-knowledge";
import {
  canonicalVendor,
  parsePricing,
  priceText,
  scoresOf,
  splitDescription,
  tagsOf,
  TAG_LABELS,
  type CardLike,
  type Tag,
} from "../model-facts";
import { vendorColor } from "../model-key";
import { ProviderLogo } from "./provider-logo";
import { wikiLink } from "../wiki-catalog";
import "./model-card.css";

export function openWiki(upstreamId: string) {
  window.location.hash = wikiLink(upstreamId);
}

/// Wraps an inline model id with its research: hover shows a brief, click
/// opens the dossier in the Wiki. Only the text is the target, never a table
/// row: a full-row target would swallow the clicks of the row around it.
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
  /// Fill the parent width, so a truncated id keeps its ellipsis.
  block?: boolean;
  /// Extra layout rules for the target, e.g. flex: 1 in a dense row.
  style?: CSSProperties;
  position?: "bottom-start" | "bottom" | "top-start" | "right-start";
}) {
  if (!upstreamId) return <>{children}</>;
  const open = () => openWiki(upstreamId);
  return (
    <HoverCard
      width="min(340px, calc(100vw - 24px))"
      events={{ hover: true, focus: true, touch: true }}
      position={position}
      openDelay={260}
      closeDelay={180}
      shadow="lg"
      radius="lg"
      withArrow
      withinPortal
      role="dialog"
      zIndex={400}
      onOpen={() => ensureKnowledge(upstreamId)}
      classNames={{ dropdown: "mcp" }}
    >
      <HoverCard.Target>
        <span
          className={block ? "model-hover-target model-hover-block" : "model-hover-target"}
          tabIndex={0}
          role="link"
          style={style}
          aria-label={`${upstreamId}: open in Model Wiki`}
          onClick={(event) => {
            // The row around may open something of its own; this click is ours.
            event.stopPropagation();
            open();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              open();
            }
          }}
        >
          {children}
        </span>
      </HoverCard.Target>
      <HoverCard.Dropdown p={0}>
        <ModelBrief upstreamId={upstreamId} providerId={providerId} />
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function ModelBrief({ upstreamId, providerId }: { upstreamId: string; providerId?: string }) {
  const state = useKnowledge(upstreamId);
  const data = state.data;
  const card: CardLike | null = data?.card ?? null;
  const providers = [...new Set(data?.catalog_entries.map((entry) => entry.provider_id) ?? [])].sort();
  const tags = card ? tagsOf(card, card.use_cases?.[0]) : [];
  // The brief leads with the most familiar benchmark the card was scored on.
  const scores = scoresOf(card?.ratings, card?.vendor);
  const top = [...scores.values()].sort(
    (a, b) =>
      benchmarkOrder(a.benchmark.id) - benchmarkOrder(b.benchmark.id) ||
      Number(a.benchmark.variant !== null) - Number(b.benchmark.variant !== null),
  )[0];
  const pricing = card ? parsePricing(card) : null;
  return (
    <div className="mcp">
      <div className="mcp-body" onClick={() => openWiki(upstreamId)}>
        <div className="mcp-head">
          <Text component="strong" className="mcp-name">
            {card?.canonical_name || upstreamId}
          </Text>
          <VendorBadge vendor={card?.vendor} />
        </div>
        {card && <p className="mcp-tagline">{splitDescription(card).lead}</p>}
        {state.loading && !data && (
          <Stack gap={6}>
            <Skeleton height={10} width="86%" />
            <Skeleton height={10} width="62%" />
          </Stack>
        )}
        {state.error && <p className="mcp-note">Research unavailable. The Wiki has the listings.</p>}
        {data && !card && !state.error && (
          <p className="mcp-note">No research card yet. The Wiki has the listings and can research it.</p>
        )}
        {card && (
          <div className="mcp-facts">
            {pricing?.input != null && pricing.output != null && (
              <Fact label="Price / 1M">
                {priceText(pricing.input, pricing.currency)} → {priceText(pricing.output, pricing.currency)}
              </Fact>
            )}
            {!!card.context_window && (
              <Fact label="Context">{contextWindow(card.context_window)}</Fact>
            )}
            {card.license && <Fact label="License">{card.license}</Fact>}
            {top && (
              <Fact label={top.benchmark.label}>
                <b>{top.rating.value}</b>
              </Fact>
            )}
          </div>
        )}
        {tags.length > 0 && (
          <div className="mcp-tags">
            {tags.slice(0, 5).map((tag) => (
              <span key={tag} className="tag">
                {TAG_LABELS[tag as Tag]}
              </span>
            ))}
          </div>
        )}
      </div>
      {data && (
        <div className="mcp-foot">
          <ProviderLabels providers={providers} fallback={providerId} limit={3} line="one" />
          <span className="mcp-open">
            Open in Wiki <IconArrowUpRight size={13} />
          </span>
        </div>
      )}
    </div>
  );
}

function Stack({ gap, children }: { gap: number; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap, marginTop: 10 }} aria-label="Reading research card">
      {children}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="mcp-fact">
      <small>{label}</small>
      <span>{children}</span>
    </span>
  );
}

export function ProviderLabels({
  providers,
  limit,
  fallback,
  line = "wrap",
}: {
  providers: string[];
  limit: number;
  /// What to say when the catalog lists the model nowhere right now.
  fallback?: string;
  /// "one" is a row of a fixed width: what does not fit fades out there,
  /// and only then.
  line?: "wrap" | "one";
}) {
  const set = useRef<HTMLSpanElement>(null);
  const clipped = useClipped(set);
  if (!providers.length)
    return fallback ? <span className="mcp-note">Viewed on {fallback}</span> : null;
  return (
    <span className="provider-labels" data-line={line} data-clipped={line === "one" && clipped ? "" : undefined}>
      <span className="provider-label-set" ref={set}>
        {providers.slice(0, limit).map((provider) => (
          <span key={provider} className="provider-label">
            <ProviderLogo providerId={provider} size={13} />
            {provider}
          </span>
        ))}
      </span>
      {providers.length > limit && <span className="provider-more">+{providers.length - limit}</span>}
    </span>
  );
}

/// The vendor as one badge, whatever spelling the researcher used.
export function VendorBadge({ vendor }: { vendor: string | null | undefined }) {
  const name = canonicalVendor(vendor);
  if (!name) return null;
  return (
    <span className="vendor-badge" data-color={vendorColor(vendor)} title={vendor && vendor !== name ? vendor : undefined}>
      {name}
    </span>
  );
}
