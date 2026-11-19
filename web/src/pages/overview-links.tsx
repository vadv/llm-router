import { IconArrowUpRight } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { clock } from "../format";
import type { Resource, Route } from "../hooks";

export function drillUrl(route: Route, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return `#/${route}${query ? `?${query}` : ""}`;
}

export function Drill({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="ov-drill" href={href}>
      {children}
      <IconArrowUpRight size={13} aria-hidden="true" />
    </a>
  );
}

export function SourceNote<T>({ source, name }: { source: Resource<T>; name: string }) {
  if (source.error)
    return (
      <div className="ov-source" role="status">
        <span>
          {name}:{" "}
          {source.updatedAt === null
            ? "unavailable"
            : `showing last data from ${clock(source.updatedAt / 1000)}`}
        </span>
        <button type="button" onClick={source.reload} aria-label={`Retry ${name}`}>
          Retry
        </button>
      </div>
    );
  if (source.data === undefined)
    return (
      <small className="ov-loading" role="status">
        Loading {name}…
      </small>
    );
  return null;
}
