import { useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import {
  amount,
  cash,
  number,
  type Cell,
  type Measure,
  type Window,
} from "../components/usage-pivot";
import { compact } from "../format";
import "./request-activity.css";

const fmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const stamp = (n: number) => fmt.format(n * 1000);
const colors = ["var(--mantine-color-teal-5)", "var(--mantine-color-violet-4)"];
export function UsageActivity({
  bins,
  metric,
  unit,
  selected,
  onSelect,
  step,
}: {
  step: number;
  bins: (Window & { cell: Cell })[];
  metric: Measure;
  unit: string;
  selected: Window | null;
  onSelect: (range: Window | null) => void;
}) {
  const values = bins.map((b) => amount(b.cell, metric));
  const peak = values.reduce<number>(
    (best, n, i) => ((n ?? -1) > (values[best] ?? -1) ? i : best),
    0,
  );
  const [cursor, setCursor] = useState<number | null>(null),
    anchor = useRef<number | null>(null);
  const index = Math.min(cursor ?? peak, bins.length - 1),
    bin = bins[index];
  const max = Math.max(0, ...values.map((n) => n ?? 0));
  const at = (e: { clientX: number; currentTarget: HTMLElement }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        bins.length - 1,
        Math.floor(((e.clientX - rect.left) / rect.width) * bins.length),
      ),
    );
  };
  const pick = (i: number, j: number) =>
    onSelect({ from: bins[Math.min(i, j)].from, to: bins[Math.max(i, j)].to });
  const pair = (c: Cell) =>
    metric === "tokens"
      ? [c.input, c.output]
      : [
          metric === "estimate" ? 0 : c.reported,
          metric === "reported" ? 0 : c.estimated,
        ];
  const labels =
    metric === "tokens" ? ["Input", "Output"] : ["Reported", "Estimated"];
  const value = (n: number | null) =>
    metric === "tokens" ? number(n) : cash(n, unit);
  return (
    <div className="usage-activity calls-report">
      <div className="ux-legend">
        <span>
          Each column:{" "}
          {step % 86400 === 0
            ? `${step / 86400}d`
            : step % 3600 === 0
              ? `${step / 3600}h`
              : `${step / 60}m`}{" "}
          · attempt start
        </span>
        {labels.map(
          (s, i) =>
            (metric !== "estimate" || i === 1) &&
            (metric !== "reported" || i === 0) && (
              <b key={s}>
                <i style={{ background: colors[i] }} />
                {s}
              </b>
            ),
        )}
      </div>
      <div className="usage-grid">
        <div className="calls-y" aria-hidden="true">
          <span>{max ? compact(max) : "—"}</span>
          <span>0</span>
        </div>
        <div
          className="calls-plot"
          role="slider"
          tabIndex={0}
          aria-label="Inspect interval"
          aria-valuemin={1}
          aria-valuemax={bins.length}
          aria-valuenow={index + 1}
          aria-valuetext={`${stamp(bin.from)}: ${value(values[index])}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pick(index, index);
              return;
            }
            if (e.key === "Escape") {
              onSelect(null);
              return;
            }
            const n = {
              ArrowLeft: index - 1,
              ArrowRight: index + 1,
              Home: 0,
              End: bins.length - 1,
            }[e.key];
            if (n !== undefined) {
              e.preventDefault();
              setCursor(Math.max(0, Math.min(n, bins.length - 1)));
            }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            anchor.current = at(e);
            e.currentTarget.setPointerCapture(e.pointerId);
            setCursor(anchor.current);
          }}
          onPointerMove={(e) => {
            if (anchor.current !== null || e.pointerType === "mouse")
              setCursor(at(e));
          }}
          onPointerCancel={() => {
            anchor.current = null;
          }}
          onPointerUp={(e) => {
            if (anchor.current !== null) {
              pick(anchor.current, at(e));
              anchor.current = null;
            }
          }}
        >
          {bins.map((b, i) => (
            <div
              className="calls-slot"
              key={b.from}
              data-inspect={index === i || undefined}
              data-selected={
                (selected && b.from >= selected.from && b.to <= selected.to) ||
                undefined
              }
              data-open={
                (b.cell.attempts > 0 && values[i] === null) || undefined
              }
            >
              <div
                className="calls-stack"
                style={{
                  height: `${max ? (100 * (values[i] ?? 0)) / max : 0}%`,
                }}
              >
                {pair(b.cell).map((v, j) =>
                  v > 0 ? (
                    <i key={j} style={{ background: colors[j], flexGrow: v }} />
                  ) : null,
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="calls-x">
          <span>{stamp(bins[0].from)}</span>
          <span>{stamp(bins.at(-1)!.to)}</span>
        </div>
      </div>
      <div className="ux-inspect">
        <div>
          <button
            aria-label="Previous interval"
            disabled={!index}
            onClick={() => setCursor(index - 1)}
          >
            <IconChevronLeft size={15} />
          </button>
          <button
            aria-label="Next interval"
            disabled={index === bins.length - 1}
            onClick={() => setCursor(index + 1)}
          >
            <IconChevronRight size={15} />
          </button>
        </div>
        <strong>
          {stamp(bin.from)} – {stamp(bin.to)}
        </strong>
        <span>
          {!bin.cell.attempts
            ? "No attempts"
            : metric === "tokens"
              ? `${number(bin.cell.inputs ? bin.cell.input : null)} in · ${number(bin.cell.outputs ? bin.cell.output : null)} out · ${number(bin.cell.attempts)} attempts`
              : `${value(values[index])} · ${number(bin.cell.attempts)} attempts`}
        </span>
      </div>
      <small>
        Select or drag columns to filter the table. Use ← → and Enter on the
        keyboard. Hatched intervals have attempts but no value for this metric.
      </small>
    </div>
  );
}
