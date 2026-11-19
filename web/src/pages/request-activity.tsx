import { useState } from "react";
import { Badge, Button } from "@mantine/core";
import {
  IconActivity,
  IconArrowRight,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import { api, type RequestActivity, type RequestQuery } from "../api";
import { Panel } from "../components/ui";
import {
  callTimeline,
  type CallInterval,
} from "../components/request-timeline";
import { usePoll } from "../hooks";
import { SourceNote } from "./overview-links";
import "./request-activity.css";

const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const hm = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const hms = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export function intervalLabel({ from, to }: CallInterval) {
  const a = new Date(from * 1000),
    b = new Date(to * 1000);
  const time = from % 60 || to % 60 ? hms : hm;
  return `${day.format(a)} ${time.format(a)} – ${a.toDateString() === b.toDateString() ? "" : day.format(b) + " "}${time.format(b)}`;
}
const parts = [
  ["ok", "Successful"],
  ["errors", "Failed"],
  ["cancels", "Cancelled"],
  ["other", "Other"],
] as const;
function grain(step: number) {
  return step >= 86400
    ? `${step / 86400}d`
    : step >= 3600
      ? `${step / 3600}h`
      : `${step / 60}m`;
}

type Props = {
  filters: Partial<RequestQuery>;
  period: string;
  selected: CallInterval | null;
  onPick: (s: CallInterval | null) => void;
};
export function ActivityPanel({ filters, period, selected, onPick }: Props) {
  const source = usePoll(
    () => api.requestActivity(filters, period),
    [
      period,
      filters.provider,
      filters.model,
      filters.outcome,
      filters.keyAlias,
      filters.metamodel,
      filters.family,
      filters.sinceUnix,
      filters.toUnix,
    ],
    !selected && filters.toUnix === undefined && period !== "all",
  );
  const [snapshot, setSnapshot] = useState<RequestActivity | null>(null);
  const data = selected && snapshot ? snapshot : source.data;
  return (
    <Panel
      title={
        <h2>
          <IconActivity size={18} /> Request activity
        </h2>
      }
      description="Saved calls by start time. Each client call counts once, even after a retry."
      actions={
        <div className="calls-chart-key">
          {period === "all" && filters.toUnix === undefined && !selected && (
            <Button variant="subtle" size="compact-xs" onClick={source.reload}>
              Refresh archive
            </Button>
          )}
          <Badge variant="light" color="teal" tt="none">
            {selected
              ? "Inspecting interval"
              : filters.toUnix !== undefined
                ? "Selected range"
                : period === "all"
                  ? "All retained"
                  : `Last ${period}`}
          </Badge>
        </div>
      }
    >
      {!(selected && snapshot) && (
        <SourceNote source={source} name="Request activity" />
      )}
      {data &&
        (data.buckets.length ? (
          <ActivityChart
            data={data}
            selected={selected}
            pick={(s) => {
              setSnapshot(s ? data : null);
              onPick(s);
            }}
          />
        ) : (
          <div className="calls-quiet">
            <strong>No saved calls in this selection</strong>
            <span>
              Try a wider period or fewer filters. Calls appear after they
              finish and are saved.
            </span>
          </div>
        ))}
    </Panel>
  );
}
function ActivityChart({
  data,
  selected,
  pick,
}: {
  data: RequestActivity;
  selected: CallInterval | null;
  pick: (s: CallInterval | null) => void;
}) {
  const bins = callTimeline(data),
    last = data.buckets.at(-1)!,
    total = data.buckets.reduce((n, b) => n + b.total, 0),
    peak = Math.max(...data.buckets.map((b) => b.peak_per_minute));
  const roof = Math.max(1, ...bins.map((b) => b.total));
  const [inspect, setInspect] = useState<number | null>(null);
  const index = Math.max(
    0,
    Math.min(
      bins.length - 1,
      Math.floor(
        ((inspect ?? selected?.from ?? last.last_start) - bins[0].start) /
          data.step_secs,
      ),
    ),
  );
  const bin = bins[index];
  function move(next: number) {
    setInspect(bins[Math.max(0, Math.min(bins.length - 1, next))].start);
  }
  const axis = (t: number) =>
    data.step_secs >= 86400
      ? day.format(t * 1000)
      : new Date(data.to_unix * 1000).toDateString() !==
          new Date(bins[0].from * 1000).toDateString()
        ? `${day.format(t * 1000)} ${hm.format(t * 1000)}`
        : hm.format(t * 1000);
  const axisStart = bins[0].from,
    axisEnd = bins.at(-1)!.to;
  const hasOther = bins.some((b) => b.other > 0);
  const atX = (e: { clientX: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        bins.length - 1,
        Math.floor(((e.clientX - r.left) * bins.length) / r.width),
      ),
    );
  };
  return (
    <div className="calls-report">
      <div className="calls-stats">
        <div>
          <span>Saved calls</span>
          <strong>{total.toLocaleString()}</strong>
        </div>
        <div>
          <span>Peak minute</span>
          <strong>
            {peak.toLocaleString()} <small>calls/min</small>
          </strong>
        </div>
        <div>
          <span>Latest start</span>
          <strong title={new Date(last.last_start * 1000).toLocaleString()}>
            {hm.format(last.last_start * 1000)}{" "}
            <small>{day.format(last.last_start * 1000)}</small>
          </strong>
        </div>
      </div>
      <div className="calls-chart-key">
        <b>Calls per {grain(data.step_secs)}</b>
        <div>
          {parts
            .filter(([key]) => key !== "other" || hasOther)
            .map(([key, label]) => (
              <span key={key}>
                <i data-kind={key} />
                {label}
              </span>
            ))}
        </div>
      </div>
      <div className="calls-plot-wrap">
        <div className="calls-y" aria-hidden="true">
          <span>{roof.toLocaleString()}</span>
          <span>0</span>
        </div>
        <div
          className="calls-plot"
          tabIndex={0}
          role="slider"
          aria-label="Inspect request interval"
          aria-describedby="calls-chart-help"
          aria-valuemin={1}
          aria-valuemax={bins.length}
          aria-valuenow={index + 1}
          aria-valuetext={`${intervalLabel(bin)}, ${bin.total} saved calls`}
          onKeyDown={(e) => {
            switch (e.key) {
              case "ArrowLeft":
              case "ArrowDown":
                move(index - 1);
                break;
              case "ArrowRight":
              case "ArrowUp":
                move(index + 1);
                break;
              case "Home":
                move(0);
                break;
              case "End":
                move(bins.length - 1);
                break;
              case "Enter":
              case " ":
                pick({ from: bin.from, to: bin.to });
                break;
              default:
                return;
            }
            e.preventDefault();
          }}
          onPointerMove={(e) => {
            if (e.pointerType === "mouse") move(atX(e));
          }}
          onClick={(e) => {
            const b = bins[atX(e)];
            setInspect(b.start);
            pick({ from: b.from, to: b.to });
          }}
        >
          {bins.map((b, i) => (
            <div
              key={b.start}
              className="calls-slot"
              data-open={b.open || undefined}
              data-inspect={i === index || undefined}
              data-selected={selected?.from === b.from || undefined}
              aria-hidden="true"
            >
              <div
                className="calls-stack"
                style={{ height: `${(b.total / roof) * 100}%` }}
              >
                {parts.map(
                  ([key]) =>
                    b[key] > 0 && (
                      <i
                        key={key}
                        data-kind={key}
                        style={{ flexGrow: b[key] }}
                      />
                    ),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="calls-x" aria-hidden="true">
        <span>{axis(axisStart)}</span>
        <span>{axis(bins[Math.floor(bins.length / 2)].start)}</span>
        <span>{axis(axisEnd)}</span>
      </div>
      <div className="calls-inspector">
        <div className="calls-bin-head">
          <div className="calls-shift">
            <button
              type="button"
              aria-label="Previous interval"
              disabled={index === 0}
              onClick={() => move(index - 1)}
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              type="button"
              aria-label="Next interval"
              disabled={index === bins.length - 1}
              onClick={() => move(index + 1)}
            >
              <IconChevronRight size={15} />
            </button>
          </div>
          <div>
            <strong>{intervalLabel(bin)}</strong>
            <small>
              {bin.open
                ? "Current interval · still filling"
                : "Inspected interval"}{" "}
              · local time
            </small>
          </div>
        </div>
        <div className="calls-bin-values">
          <b>
            {bin.total} {bin.total === 1 ? "call" : "calls"}
          </b>
          {parts
            .filter(([k]) => k !== "other" || bin.other)
            .map(([k, label]) => (
              <span key={k}>
                <i data-kind={k} />
                {bin[k]} {label.toLowerCase()}
              </span>
            ))}
          {bin.retried > 0 && <span>{bin.retried} retried</span>}
        </div>
        <Button
          size="xs"
          variant="light"
          rightSection={<IconArrowRight size={14} />}
          onClick={() => pick({ from: bin.from, to: bin.to })}
        >
          Show interval in log
        </Button>
      </div>
      <p id="calls-chart-help">
        Select a bar to filter the log, or use ← → and Enter. The newest calls
        can appear after a short delay.
      </p>
    </div>
  );
}
