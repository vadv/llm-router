import {
  Badge,
  Box,
  Code,
  Divider,
  Drawer,
  Group,
  ScrollArea,
  Stack,
  Text,
} from "@mantine/core";
import { api, type Attempt, type RequestRecord, type SpendSeries } from "../api";
import { usePoll } from "../hooks";
import { allocatedSpend, spendText } from "./usage-math";
import { ModelHoverCard } from "./model-card";
import { Copyable, OutcomeBadge, RelTime, resultColor } from "./ui";
import {
  clock,
  compact,
  dateTime,
  money,
  span,
  tpsFormat,
  usageCost,
} from "../format";

export function RequestDrawer({
  request: current,
  onClose,
}: {
  request: RequestRecord | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      opened={current !== null}
      onClose={onClose}
      position="right"
      size="md"
      title={
        current ? (
          <Group gap="xs" wrap="nowrap">
            <Text fw={600} ff="monospace" size="sm">
              {current.metamodel}
            </Text>
            <OutcomeBadge outcome={current.outcome} />
          </Group>
        ) : null
      }
    >
      {current && <RequestDetail key={current.id} request={current} />}
    </Drawer>
  );
}

function RequestDetail({ request }: { request: RequestRecord }) {
  const missing = request.attempts.filter(a => a.cost == null && a.input_tokens != null && a.output_tokens != null);
  const ids = new Set(missing.map(a => a.provider_id));
  const provider = ids.size === 1 ? missing[0].provider_id : undefined;
  // Use the request's UTC day and the six preceding days, not today's price for an old call.
  const day = 86_400;
  const end = (Math.floor((request.finished_at_unix ?? request.started_at_unix) / day) + 1) * day;
  const reference = usePoll(async () => missing.length ? api.usageSpend(provider, {
    sinceUnix: end - 7 * day, toUnix: Math.min(end, Math.floor(Date.now() / 1000) + 1),
  }) : { series: [], truncated: false }, [end, provider, missing.length], false);
  return (
    <Stack gap="sm">
      <Group gap="lg">
        <Fact label="started" value={dateTime(request.started_at_unix)} />
        <Fact
          label="duration"
          value={span(request.started_at_unix, request.finished_at_unix) ?? "—"}
        />
        <Fact label="key" value={request.key_alias} />
      </Group>
      <Group gap="xs">
        <Text size="xs" c="dimmed">
          id
        </Text>
        <Copyable value={request.id} size="xs" />
      </Group>

      {request.input_preview && (
        <details className="event-detail">
          <summary>
            Input preview{request.input_truncated ? " (truncated)" : ""} · may
            contain sensitive text
          </summary>
          <Code block className="wrap-anywhere" fz="11px">
            {request.input_preview}
          </Code>
        </details>
      )}

      <Divider
        label={`${request.attempts.length} ${request.attempts.length === 1 ? "attempt" : "attempts"}`}
        labelPosition="left"
      />

      <Stack gap="xs">
        {request.attempts.map((attempt, index) => (
          <AttemptDetail
            key={`${attempt.provider_id}-${index}`}
            attempt={attempt}
            index={index}
            rate={reference.data?.series.find(s => s.provider === attempt.provider_id && s.primary_series)}
            estimateStatus={reference.error ? "Balance unavailable" : reference.loading ? "Reading balance…" : "No balance rate"}
          />
        ))}
      </Stack>

      <Text size="11px" c="dimmed">
        <RelTime
          unix={request.finished_at_unix}
          fallback="Finish time not reported"
        />
      </Text>
    </Stack>
  );
}

function AttemptDetail({
  attempt,
  index,
  rate,
  estimateStatus,
}: {
  attempt: Attempt;
  index: number;
  rate?: SpendSeries;
  estimateStatus: string;
}) {
  const tpsVal = tpsFormat(attempt);
  const cost = usageCost(attempt);
  const tokens = attempt.input_tokens == null || attempt.output_tokens == null ? null : attempt.input_tokens + attempt.output_tokens;
  const estimate = allocatedSpend(rate, tokens);
  const toolNames = attempt.tool_names;
  const issues = attempt.issues ?? [];

  return (
    <Box
      p="sm"
      style={{
        border: "1px solid var(--mantine-color-default-border)",
        borderRadius: 6,
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Box
            w={16}
            h={16}
            style={{
              borderRadius: 3,
              background: "var(--mantine-color-default-hover)",
              display: "grid",
              placeItems: "center",
            }}
          >
            <Text size="11px" fw={600} c="dimmed">
              {index + 1}
            </Text>
          </Box>
          <ModelHoverCard
            upstreamId={attempt.upstream_id}
            providerId={attempt.provider_id}
            block
            style={{ flex: 1, minWidth: 0 }}
          >
            <Text size="xs" ff="monospace" truncate>
              {attempt.provider_id}/{attempt.upstream_id}
            </Text>
          </ModelHoverCard>
        </Group>
        <Badge size="xs" variant="light" color={resultColor(attempt.result)}>
          {attempt.result ?? "unknown"}
        </Badge>
      </Group>

      <Group gap="lg" mt={6}>
        <Fact
          label="took"
          value={
            attempt.duration_ms != null
              ? `${compact(attempt.duration_ms / 1000)}s`
              : (span(attempt.started_at_unix, attempt.finished_at_unix) ?? "—")
          }
        />
        <Fact
          label="tokens"
          value={
            attempt.input_tokens === null && attempt.output_tokens === null
              ? "—"
              : `${compact(attempt.input_tokens)} → ${compact(attempt.output_tokens)}`
          }
        />
        {tpsVal !== "—" && <Fact label="tps" value={tpsVal} />}
        {cost != null ? <Fact label="reported cost" value={money(cost)} /> :
          <Fact label="est. spend · 7d balance" value={tokens === null ? "Missing tokens" :
            estimate === null ? estimateStatus : `≈ ${spendText(estimate, rate)}`} />}
        <Fact label="at" value={clock(attempt.started_at_unix)} />
      </Group>

      {attempt.switch_reason && (
        <Text size="xs" c="yellow.5" mt={6}>
          switched: {attempt.switch_reason}
        </Text>
      )}

      {attempt.error && (
        <Code block mt={6} className="wrap-anywhere" fz="11px">
          {attempt.error}
        </Code>
      )}

      {/* An attempt with no tool data reports a null count and an empty
          list; that is not a line. */}
      {(attempt.tool_count != null || (toolNames?.length ?? 0) > 0) && (
        <Text size="xs" c="dimmed" mt={6}>
          tool calls: {attempt.tool_count ?? toolNames!.length}
          {toolNames?.length
            ? ` (${toolNames.join(", ")}${attempt.tool_names_truncated ? "…" : ""})`
            : ""}
          {attempt.tool_list_truncated ? " (+ more)" : ""}
        </Text>
      )}

      {issues.length > 0 && (
        <Text size="xs" c="yellow.5" mt={6}>
          issues: {issues.join(", ")}
        </Text>
      )}

      {attempt.response_preview && (
        <details className="event-detail">
          <summary>
            Response preview{attempt.response_truncated ? " (truncated)" : ""} ·
            may contain sensitive text
          </summary>
          <ScrollArea.Autosize mah={300} offsetScrollbars>
            <Text
              size="xs"
              className="wrap-anywhere"
              style={{ whiteSpace: "pre-wrap" }}
            >
              {attempt.response_preview}
            </Text>
          </ScrollArea.Autosize>
        </details>
      )}
    </Box>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Text size="11px" c="dimmed" fw={500}>
        {label}
      </Text>
      <Text size="xs" ff="monospace">
        {value}
      </Text>
    </Box>
  );
}
