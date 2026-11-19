import { Box, Group, Text } from "@mantine/core";
import { useResizeObserver } from "@mantine/hooks";
import { useState } from "react";
import { clock, dateTime } from "../format";
import { splitModelGroup } from "../model-key";
import { ModelHoverCard } from "./model-card";
import { axisDecimals, change, frame, nearestIndex, runs, ticks, type Series } from "./chart-math";

/// A time chart with real axes: grid, value labels, time labels, a hover
/// crosshair and optional window-reset markers. Drawn as plain SVG so the
/// bundle carries no chart library. `stacked` adds the series into bands,
/// which is how input and output tokens read as one spend.
export function Chart({
  series,
  height = 160,
  stacked = false,
  zeroBased = true,
  format = (value) => String(Math.round(value)),
  markers = [],
  legend = true,
  modelLabels = false,
}: {
  series: Series[];
  height?: number;
  stacked?: boolean;
  /// Start the value axis at zero. Turn it off for a nearly full quota, whose
  /// slope is invisible on a zero-based axis.
  zeroBased?: boolean;
  format?: (value: number) => string;
  markers?: { unix: number; label: string }[];
  legend?: boolean;
  /// Legend names are "provider/upstream_id" groups: let them open a
  /// researched model card instead of being dead text.
  modelLabels?: boolean;
}) {
  const [ref, rect] = useResizeObserver<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const width = Math.max(200, Math.round(rect.width) || 600);
  const built = frame(series, stacked, zeroBased);
  const { xs, values, totals, min, max } = built;

  const left = 40;
  const right = 8;
  const top = 8;
  const bottom = 18;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const first = xs[0] ?? 0;
  const last = xs[xs.length - 1] ?? 0;
  const spanX = Math.max(1, last - first);
  const x = (unix: number) =>
    xs.length < 2 ? left + plotWidth / 2 : left + ((unix - first) / spanX) * plotWidth;
  const y = (value: number) => top + plotHeight - ((value - min) / (max - min)) * plotHeight;
  const axisTime = (unix: number) =>
    spanX <= 36 * 3600
      ? clock(unix)
      : new Date(unix * 1000).toLocaleDateString(undefined, { day: "2-digit", month: "short" });

  if (xs.length === 0) {
    return (
      <Box ref={ref} h={height} style={{ display: "grid", placeItems: "center" }}>
        <Text size="xs" c="dimmed">
          no data
        </Text>
      </Box>
    );
  }

  const valueTicks = ticks(min, max, 3);
  const timeStamps = xs.length < 2 ? [first] : [first, first + spanX / 2, last];
  const bands = stacked ? runs(values) : [];
  const level = !zeroBased && !stacked ? change(values[0] ?? []) : null;
  const decimals = axisDecimals(min, max, 4);
  const label = (value: number) => {
    const text = format(value);
    if (zeroBased || text !== format(value + (max - min) / 4)) {
      return text;
    }
    const fixed = value.toFixed(decimals);
    if (decimals >= 14 && fixed === (value + (max - min) / 4).toFixed(decimals)) {
      return Number(value.toPrecision(6)).toString();
    }
    return fixed;
  };
  const stackTop = (index: number, upto: number) =>
    values.slice(0, upto + 1).reduce((sum, row) => sum + (row[index] ?? 0), 0);

  const linePaths = series.map((_, row) => {
    const segments: string[] = [];
    let open = false;
    xs.forEach((unix, index) => {
      const value = values[row][index];
      if (value === null) {
        open = false;
        return;
      }
      segments.push(`${open ? "L" : "M"}${x(unix).toFixed(1)},${y(value).toFixed(1)}`);
      open = true;
    });
    return segments.join(" ");
  });

  // Stable gradient IDs: series label sanitized.
  const gradId = (label: string) => `grad-${label.replace(/[^a-zA-Z0-9]/g, "")}`;

  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left - left) / plotWidth;
    setHover(nearestIndex(xs, first + ratio * spanX));
  };
  const key = (event: React.KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (step !== 0) {
      event.preventDefault();
      setHover((current) => Math.min(xs.length - 1, Math.max(0, (current ?? xs.length - 1) + step)));
    } else if (event.key === "Escape") setHover(null);
    else if (event.key === "End") setHover(xs.length - 1);
    else if (event.key === "Home") setHover(0);
  };

  const hoverUnix = hover === null ? null : xs[hover];
  const tooltipLeft = hover === null ? 0 : Math.min(Math.max(x(xs[hover]) + 10, 4), width - 148);

  return (
    <Box>
      {legend && series.length > 1 && (
        <Group gap="sm" mb={2}>
          {series.map((one) => {
            const parsed = modelLabels ? splitModelGroup(one.label) : null;
            return (
              <Group gap={4} key={one.label} wrap="nowrap" miw={0}>
                <Box style={{ width: 8, height: 8, borderRadius: 2, background: one.color, flexShrink: 0 }} />
                <ModelHoverCard upstreamId={parsed?.upstreamId} providerId={parsed?.providerId}>
                  <Text size="xs" c="dimmed" truncate>
                    {one.label}
                  </Text>
                </ModelHoverCard>
              </Group>
            );
          })}
        </Group>
      )}
      {level !== null && (
        <Group gap="sm" mb={2} wrap="nowrap" justify="space-between">
          <Text size="xs" c="dimmed">
            {level.delta === 0
              ? "no change"
              : `${level.delta < 0 ? "spent" : "added"} ${label(Math.abs(level.delta))}`}
            {level.percent !== null &&
              ` (${Math.abs(level.percent) < 0.0005
                  ? "<0.001"
                  : Math.abs(level.percent).toFixed(Math.abs(level.percent) < 0.1 ? 3 : 2)}%)`}
          </Text>
          {min > 0 ? (
            <Text size="xs" c="dimmed">
              {label(min)}…{label(max)}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              {label(min)}…{label(max)}
            </Text>
          )}
        </Group>
      )}
      <Box
        ref={ref}
        tabIndex={0}
        role="img"
        aria-label={`${series.map((one) => one.label).join(", ")}: ${dateTime(first)} … ${dateTime(last)}`}
        style={{ position: "relative", outlineOffset: 2 }}
        onKeyDown={key}
      >
        <svg
          width={width}
          height={height}
          onPointerMove={move}
          onPointerLeave={() => setHover(null)}
          style={{ display: "block", touchAction: "pan-y" }}
        >
          <defs>
            {series.map((one) => (
              <linearGradient key={gradId(one.label)} id={gradId(one.label)} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={one.color} stopOpacity={0.22} />
                <stop offset="100%" stopColor={one.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          {valueTicks.map((value) => (
            <g key={value}>
              <line
                x1={left}
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--mantine-color-default-border)"
                strokeWidth={1}
                strokeOpacity={0.35}
                strokeDasharray="2 4"
              />
              <text
                x={left - 5}
                y={y(value) + 3}
                textAnchor="end"
                fontSize={10}
                fill="var(--mantine-color-dimmed)"
              >
                {label(value)}
              </text>
            </g>
          ))}
          {timeStamps.map((unix, index) => (
            <text
              key={unix}
              x={x(unix)}
              y={height - 4}
              textAnchor={index === 0 ? "start" : index === timeStamps.length - 1 ? "end" : "middle"}
              fontSize={10}
              fill="var(--mantine-color-dimmed)"
            >
              {axisTime(unix)}
            </text>
          ))}

          {markers.map((marker) =>
            marker.unix >= first && marker.unix <= last ? (
              <g key={`${marker.unix}-${marker.label}`}>
                <line
                  x1={x(marker.unix)}
                  x2={x(marker.unix)}
                  y1={top}
                  y2={top + plotHeight}
                  stroke="var(--mantine-color-dimmed)"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
                <text
                  x={x(marker.unix) + 3}
                  y={top + 8}
                  fontSize={9}
                  fill="var(--mantine-color-dimmed)"
                >
                  {marker.label}
                </text>
              </g>
            ) : null,
          )}

          {/* Hover area: a subtle vertical band before the crosshair line */}
          {hover !== null && (
            <rect
              x={x(xs[hover]) - plotWidth / Math.max(1, xs.length) / 2}
              y={top}
              width={plotWidth / Math.max(1, xs.length)}
              height={plotHeight}
              fill="var(--mantine-color-text)"
              fillOpacity={0.04}
            />
          )}

          {stacked
            ? bands.map((run) =>
                series.map((one, row) => {
                  const upper = run.map((index) => `${x(xs[index]).toFixed(1)},${y(stackTop(index, row)).toFixed(1)}`);
                  const lower = run
                    .slice()
                    .reverse()
                    .map((index) => `${x(xs[index]).toFixed(1)},${y(stackTop(index, row) - (values[row][index] ?? 0)).toFixed(1)}`);
                  return (
                    <polygon
                      key={`${run[0]}-${one.label}`}
                      points={[...upper, ...lower].join(" ")}
                      fill={one.color}
                      fillOpacity={0.65}
                      stroke={one.color}
                      strokeWidth={0.8}
                      strokeOpacity={0.4}
                    />
                  );
                }),
              )
            : series.map((one, row) => (
                <g key={one.label}>
                  {level !== null && row === 0 && (
                    <>
                      {runs([values[0]]).map((run) => {
                        const head = run[0];
                        const tail = run[run.length - 1];
                        const points = [
                          ...run.map((index) => {
                            const value = values[0][index] ?? level.from;
                            return `${x(xs[index]).toFixed(1)},${y(value).toFixed(1)}`;
                          }),
                          `${x(xs[tail]).toFixed(1)},${y(level.from).toFixed(1)}`,
                          `${x(xs[head]).toFixed(1)},${y(level.from).toFixed(1)}`,
                        ].join(" ");
                        return (
                          <polygon
                            key={`fill-${head}`}
                            points={points}
                            fill={one.color}
                            fillOpacity={0.12}
                          />
                        );
                      })}
                      <line
                        x1={left}
                        x2={width - right}
                        y1={y(level.from)}
                        y2={y(level.from)}
                        stroke={one.color}
                        strokeOpacity={0.4}
                        strokeWidth={1}
                        strokeDasharray="4 3"
                      />
                    </>
                  )}
                  {zeroBased && !stacked && series.length === 1 && (
                    <path
                      d={`${linePaths[row]} L${x(last).toFixed(1)},${(top + plotHeight).toFixed(1)} L${x(first).toFixed(1)},${(top + plotHeight).toFixed(1)} Z`}
                      fill={`url(#${gradId(one.label)})`}
                    />
                  )}
                  <path d={linePaths[row]} fill="none" stroke={one.color} strokeWidth={1.2} shapeRendering="geometricPrecision" />
                </g>
              ))}

          {hover !== null && (
            <g>
              <line
                x1={x(xs[hover])}
                x2={x(xs[hover])}
                y1={top}
                y2={top + plotHeight}
                stroke="var(--mantine-color-text)"
                strokeOpacity={0.25}
                strokeWidth={1}
              />
              {series.map((one, row) => {
                const value = values[row][hover];
                if (value === null) return null;
                const at = stacked ? stackTop(hover, row) : value;
                return (
                  <g key={one.label}>
                    <circle cx={x(xs[hover])} cy={y(at)} r={5} fill={one.color} fillOpacity={0.2} />
                    <circle
                      cx={x(xs[hover])}
                      cy={y(at)}
                      r={3}
                      fill={one.color}
                      stroke="var(--mantine-color-body)"
                      strokeWidth={1.5}
                    />
                  </g>
                );
              })}
            </g>
          )}
        </svg>
        {hover !== null && hoverUnix !== null && (
          <Box
            style={{
              position: "absolute",
              top: 4,
              left: tooltipLeft,
              pointerEvents: "none",
              background: "var(--mantine-color-body)",
              border: "1px solid var(--mantine-color-default-border)",
              borderRadius: "var(--mantine-radius-sm)",
              padding: "4px 8px",
              backdropFilter: "blur(4px)",
              minWidth: 120,
            }}
          >
            <Text size="xs" c="dimmed" mb={2}>
              {dateTime(hoverUnix)}
            </Text>
            {series.map((one, row) => (
              <Group gap={6} justify="space-between" key={one.label} wrap="nowrap">
                <Group gap={4} wrap="nowrap">
                  <Box style={{ width: 6, height: 6, borderRadius: 1, background: one.color }} />
                  <Text size="xs" truncate>
                    {one.label}
                  </Text>
                </Group>
                <Text size="xs" fw={600}>
                  {values[row][hover] === null ? "—" : format(values[row][hover] as number)}
                </Text>
              </Group>
            ))}
            {stacked && series.length > 1 && (
              <Group justify="space-between" mt={2}>
                <Text size="xs" c="dimmed">
                  total
                </Text>
                <Text size="xs" fw={700}>
                  {format(totals[hover])}
                </Text>
              </Group>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}