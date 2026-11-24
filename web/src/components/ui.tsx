import {
  Badge,
  Box,
  Button,
  CopyButton,
  Group,
  Paper,
  PasswordInput,
  Switch,
  Text,
  ThemeIcon,
  Tooltip,
  type BoxProps,
  type MantineColor,
} from "@mantine/core";
import { IconArrowsExchange, IconCheck, IconCopy } from "@tabler/icons-react";
import { type ReactNode, useState } from "react";
import { api, keyStore } from "../api";
import { ago, dateTime } from "../format";
import { useNow } from "../hooks";
import "./ui.css";

export type Tone = "ok" | "warn" | "bad" | "unknown";

export function Dot({ tone, live = false }: { tone: Tone; live?: boolean }) {
  return <span className="dot" data-tone={tone} data-live={live} />;
}

/// A moment shown as "3m ago", with the exact time one hover away. The help
/// cursor says so: there is nothing to click.
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

/// An identifier with a copy button. Ids are what people paste into configs.
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
        <Tooltip label={copied ? "Copied" : "Copy"} withArrow>
          <button
            type="button"
            className="copy-id"
            aria-label={copied ? "Copied" : `Copy ${value}`}
            onClick={copy}
          >
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

/// How a page opens: one title, at most one line under it, and what can be
/// done from here on the right.
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-heading">
      <Box miw={0} style={{ flex: "1 1 280px" }}>
        <Text component="h1" className="page-title">
          {title}
        </Text>
        {description && <p className="page-lede">{description}</p>}
      </Box>
      {actions && (
        <Group gap={8} wrap="wrap" style={{ flex: "0 0 auto" }}>
          {actions}
        </Group>
      )}
    </header>
  );
}

/// The standard panel: a titled surface that holds one kind of data.
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
    <Paper withBorder radius="md" p="sm" miw={0} {...props}>
      {(title || actions) && (
        <Box px={compact ? "sm" : undefined} pt={compact ? "sm" : undefined}>
          <div className="panel-head">
            <Box miw={0}>
              <Box className="panel-title">{title}</Box>
              {description && <Box className="panel-lede">{description}</Box>}
            </Box>
            {actions}
          </div>
        </Box>
      )}
      {children}
    </Paper>
  );
}

/// Compact stat tile: label, value, optional hint.
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
    <Paper withBorder radius="md" p="sm" h="100%">
      <Group justify="space-between" align="center" mb={6} wrap="nowrap">
        <Text size="xs" c="dimmed" fw={500}>
          {label}
        </Text>
        {icon && (
          <Box c={tone ?? "gray"} opacity={0.6}>
            {icon}
          </Box>
        )}
      </Group>
      <Text className="stat-value" c={tone}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed" mt={3} lineClamp={1}>
          {hint}
        </Text>
      )}
    </Paper>
  );
}

/// Nothing to show, and what to do about it.
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && (
        <span className="empty-icon" aria-hidden>
          {icon}
        </span>
      )}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/// A labelled control in a filter row. The label wraps the control, so the
/// control needs no name of its own and a click anywhere reaches it.
export function Field({
  label,
  children,
  grow = false,
}: {
  label: ReactNode;
  children: ReactNode;
  /// Take the room the other fields leave.
  grow?: boolean;
}) {
  return (
    <label className={grow ? "field is-wide" : "field"}>
      <span className="field-label">{label}</span>
      {children}
    </label>
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
      <Badge color="gray" variant="light" size="sm" style={{ whiteSpace: "nowrap" }}>
        unknown
      </Badge>
    );
  }
  const known = OUTCOME[outcome];
  return (
    <Badge color={known?.color ?? "gray"} variant="light" size="sm" style={{ whiteSpace: "nowrap" }}>
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
    <main className="gate">
      <form className="gate-card" onSubmit={submit} noValidate>
        <div className="gate-brand">
          <span className="brand-mark">
            <IconArrowsExchange size={17} stroke={2} />
          </span>
          <div>
            <h1>llm-router</h1>
            <p>Sign in with a client key</p>
          </div>
        </div>
        <PasswordInput
          aria-label="Client key"
          label="Client key"
          placeholder="Paste a client key from the router config"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          data-autofocus
          autoComplete="off"
          error={error}
          disabled={busy}
          size="md"
          styles={{ label: { fontSize: 12, fontWeight: 500, color: "var(--ink-soft)" } }}
        />
        <Switch
          size="sm"
          label="Keep me signed in on this browser"
          checked={persist}
          onChange={(event) => setPersist(event.currentTarget.checked)}
          styles={{ label: { fontSize: 12.5 } }}
        />
        <Button type="submit" size="md" loading={busy} disabled={!value.trim()} fullWidth>
          Unlock
        </Button>
        <p className="gate-note">
          The key stays in this browser and is sent only to this router.
        </p>
      </form>
    </main>
  );
}

export function ColorBar({ percent, color }: { percent: number; color?: string }) {
  return (
    <Box
      h={6}
      style={{ borderRadius: 999, background: "var(--surface-hover)", overflow: "hidden" }}
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
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth={1.3} shapeRendering="geometricPrecision" />
    </svg>
  );
}
