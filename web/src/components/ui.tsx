import {
  Badge,
  Box,
  Button,
  CopyButton,
  Group,
  Paper,
  PasswordInput,
  Stack,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
  type BoxProps,
  type MantineColor,
} from "@mantine/core";
import { IconCheck, IconCopy, IconKey } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { keyStore } from "../api";
import { ago, dateTime } from "../format";
import { useNow } from "../hooks";
import { api } from "../api";

export type Tone = "ok" | "warn" | "bad" | "unknown";

export function Dot({ tone, live = false }: { tone: Tone; live?: boolean }) {
  return <span className="dot" data-tone={tone} data-live={live} />;
}

export function RelTime({ unix, fallback = "never" }: { unix: number | null | undefined; fallback?: string }) {
  const now = useNow();
  if (unix === null || unix === undefined || unix <= 0) {
    return (
      <Text component="span" c="dimmed" size="sm">
        {fallback}
      </Text>
    );
  }
  return (
    <Tooltip label={dateTime(unix)} withArrow>
      <Text component="span" size="sm" c="dimmed" style={{ cursor: "help" }}>
        {ago(unix, now)}
      </Text>
    </Tooltip>
  );
}

/// An identifier with a copy button. Ids are what users paste into configs.
export function Copyable({
  value,
  children,
  size = "sm",
  block = false,
}: {
  value: string;
  children?: ReactNode;
  size?: string;
  block?: boolean;
}) {
  return (
    <CopyButton value={value} timeout={1200}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "copied" : "copy"} withArrow>
          <button type="button" className="copy-id" aria-label={copied ? "Copied" : `Copy ${value}`} onClick={copy}>
            <Text
              component="code"
              size={size}
              ff="monospace"
              truncate={!block}
              className={block ? "wrap-anywhere" : undefined}
            >
              {children ?? value}
            </Text>
            <ThemeIcon variant="transparent" color={copied ? "teal" : "gray"} size={16}>
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </ThemeIcon>
          </button>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/// Header of a page: title and optional actions. Descriptions are shown only
/// when they carry non-obvious information.
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group component="header" className="page-heading" justify="space-between" align="center" mb="md" gap="sm">
      <Box miw={0}>
        <Text component="h1" fw={650} fz={24} lh={1.15} style={{ letterSpacing: "-.035em" }}>
          {title}
        </Text>
        {description && (
          <Text size="xs" c="dimmed" mt={2}>
            {description}
          </Text>
        )}
      </Box>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/// The standard card: a titled surface that holds one kind of data.
export function Panel({
  title,
  description,
  actions,
  children,
  ...props
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
} & Omit<BoxProps, "title">) {
  const compact = props.p === 0 || props.p === "0";
  return (
    <Paper withBorder radius="sm" p="sm" miw={0} {...props}>
      {(title || actions) && (
        <Box px={compact ? "sm" : undefined} pt={compact ? "sm" : undefined}>
          <Group justify="space-between" align="center" mb={description || children ? "xs" : 0} gap="xs" wrap="wrap">
            <Box style={{ minWidth: 0 }}>
              <Box fw={600} fz="sm">{title}</Box>
              {description && (
                <Box fz="xs" c="dimmed" mt={2}>{description}</Box>
              )}
            </Box>
            {actions}
          </Group>
        </Box>
      )}
      {children}
    </Paper>
  );
}

/// Compact stat tile: label + value + optional hint, no icon circle.
/// Designed to fit 6 per row on desktop.
export function Stat({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: MantineColor;
  icon?: ReactNode;
}) {
  return (
    <Paper withBorder radius="sm" p="sm" h="100%">
      <Group justify="space-between" align="center" mb={4} wrap="nowrap">
        <Text size="xs" c="dimmed" tt="uppercase" fw={600} style={{ letterSpacing: 0.4 }}>
          {label}
        </Text>
        {icon && <Box c={tone ?? "gray"} opacity={0.7}>{icon}</Box>}
      </Group>
      <Text className="stat-value" c={tone}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed" mt={2} lineClamp={1}>
          {hint}
        </Text>
      )}
    </Paper>
  );
}

const OUTCOME: Record<string, { color: string; label: string }> = {
  ok: { color: "teal", label: "ok" },
  error: { color: "red", label: "error" },
  client_cancel: { color: "gray", label: "cancelled" },
};

export function OutcomeBadge({ outcome }: { outcome: string | null }) {
  if (!outcome) {
    return (
      <Badge color="gray" variant="light" size="sm" radius="sm" style={{ whiteSpace: "nowrap" }}>
        unknown
      </Badge>
    );
  }
  const known = OUTCOME[outcome];
  return (
    <Badge color={known?.color ?? "gray"} variant="light" size="sm" radius="sm" style={{ whiteSpace: "nowrap" }}>
      {known?.label ?? outcome}
    </Badge>
  );
}

export function resultColor(result: string | null): string {
  if (result === "ok") return "teal";
  if (result === "error") return "red";
  return "gray";
}

/// The key gate. The key comes from a person, is stored per their choice, and
/// is never written to the URL or a log.
export function KeyGate({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState("");
  const [persist, setPersist] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    setError(null);
    keyStore.save(key, persist);
    try {
      await api.pools();
      onUnlock();
    } catch (failure) {
      keyStore.clear();
      setError(failure instanceof Error ? failure.message : "the core did not accept the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack align="center" justify="center" mih="100dvh" px="md">
      <Paper withBorder radius="lg" p="xl" w={380} maw="100%">
        <Stack gap="md">
          <Group gap="sm">
            <ThemeIcon size={38} radius="md" variant="light" color="teal">
              <IconKey size={20} />
            </ThemeIcon>
            <Box>
              <Text fw={600}>llm-router</Text>
              <Text size="xs" c="dimmed">
                sign in with a client key
              </Text>
            </Box>
          </Group>
          <form onSubmit={submit}>
            <Stack gap="sm">
              <PasswordInput
                label="Client key"
                placeholder="paste a configured client key"
                value={value}
                onChange={(event) => setValue(event.currentTarget.value)}
                data-autofocus
                autoComplete="off"
                error={error}
                disabled={busy}
              />
              <Switch
                size="xs"
                label="Remember on this browser"
                checked={persist}
                onChange={(event) => setPersist(event.currentTarget.checked)}
              />
              <Button type="submit" loading={busy} disabled={!value.trim()} fullWidth>
                Unlock
              </Button>
              <Text size="xs" c="dimmed">
                The key stays in this browser storage and travels only to this core as a Bearer token.
              </Text>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Stack>
  );
}

export function ColorBar({ percent, color }: { percent: number; color?: string }) {
  return (
    <Box
      h={6}
      style={{ borderRadius: 999, background: "var(--mantine-color-default-border)", overflow: "hidden" }}
    >
      <Box
        h="100%"
        w={`${Math.min(100, Math.max(0, percent))}%`}
        bg={color ?? (percent > 90 ? "red.6" : percent > 70 ? "yellow.6" : "teal.6")}
        style={{ borderRadius: 999, transition: "width 300ms ease" }}
      />
    </Box>
  );
}

/// Inline sparkline: a tiny SVG line with gradient fill, no axes.
/// Used inside stat tiles and compact panels.
export function Sparkline({
  values,
  color = "var(--mantine-color-teal-5)",
  height = 24,
  width = 100,
}: {
  values: number[];
  color?: string;
  height?: number;
  width?: number;
}) {
  if (values.length < 2) {
    return <Box h={height} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`);
  const linePath = `M${points.join(" L")}`;
  const areaPath = `${linePath} L${width.toFixed(1)},${height.toFixed(1)} L0,${height.toFixed(1)} Z`;
  const gradId = `spark-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.25} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.2} shapeRendering="geometricPrecision" />
    </svg>
  );
}
