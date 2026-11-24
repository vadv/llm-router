import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
  Modal,
  NativeSelect,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconCode,
  IconLayersLinked,
  IconLayoutDashboard,
  IconPhoto,
  IconPlus,
  IconRoute,
  IconSearch,
  IconSparkles,
  IconStack2,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { api, type Member, type Pool } from "../api";
import { ModelHoverCard } from "../components/model-card";
import { ProviderLogo } from "../components/provider-logo";
import { contextWindow } from "../format";
import { usePoll } from "../hooks";
import { memberKey, poolSuggestions, type Goal } from "../pool-suggestions";
import { useModelSummaries } from "../use-model-summaries";
import { poolEvidence } from "../pool-evidence";
import "./pool-builder.css";

export const poolGoals = [
  {
    value: "fit",
    label: "Your routes",
    example: "Match an existing route",
    icon: IconRoute,
    hint: "Prioritizes models you already group together and the same model on another connection.",
  },
  {
    value: "coding",
    label: "Coding",
    example: "Implement or debug code",
    icon: IconCode,
    hint: "Coding-tagged IDs and members of your coding pools come first. This is not a benchmark.",
  },
  {
    value: "design",
    label: "Build interfaces",
    example: "Written brief → web UI",
    icon: IconLayoutDashboard,
    hint: "Turn a written brief into a web UI. Compare frontend work and WebDev evaluations. If your brief includes a mockup, prioritize image input too.",
  },
  {
    value: "vision",
    label: "Review screenshots",
    example: "Screenshot → visual feedback",
    icon: IconPhoto,
    hint: "Inspect a screen or compare an implementation to a mockup. Check image input on the primary and every fallback. Vision alone is not a design score.",
  },
  {
    value: "reasoning",
    label: "Reasoning",
    example: "Work through a problem",
    icon: IconSparkles,
    hint: "Reasoning-tagged IDs and members of your reasoning pools come first. This is not a benchmark.",
  },
  {
    value: "context",
    label: "Long context",
    example: "Read large documents",
    icon: IconStack2,
    hint: "Largest reported context first. Models without a reported limit come last among unbanned connections.",
  },
] as const;
export type PoolDraft = Pool & {
  existing: boolean;
  goal?: Goal;
  reference?: string;
};
const PAGE = 5;
export function PoolBuilder({
  draft,
  pools,
  providerIds,
  onClose,
  onSaved,
}: {
  draft: PoolDraft;
  pools: Pool[];
  providerIds: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  // A previous save message must not cover the next editor's actions.
  useEffect(() => {
    notifications.hide("pool-builder-saved");
  }, []);
  const catalog = usePoll(api.catalog, [], false),
    bans = usePoll(api.bans, []);
  const [members, setMembers] = useState<Member[]>(draft.members),
    [name, setName] = useState(draft.name);
  const [goal, setGoal] = useState<Goal>(draft.goal ?? "fit"),
    [ref, setRef] = useState(draft.reference ?? ""),
    [query, setQuery] = useState(""),
    [connection, setConnection] = useState(""),
    [limit, setLimit] = useState(PAGE);
  const [manual, setManual] = useState(false),
    [provider, setProvider] = useState(""),
    [id, setId] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const nameIssue = !/^[a-z0-9._-]{1,64}$/.test(name.trim())
    ? "Use 1–64 lowercase letters, digits, dots, dashes or underscores."
    : !draft.existing && pools.some((p) => p.name === name.trim())
      ? "This pool name is already in use."
      : "";
  const valid =
    !nameIssue &&
    members.length > 0 &&
    members.every((m) => providerIds.includes(m.provider_id));
  const entries = catalog.data,
    activeBans = bans.data;
  const visualGoal = goal === "design" || goal === "vision" ? goal : null;
  const [benchmark, setBenchmark] = useState(""),
    [attachImage, setAttachImage] = useState(false);
  const needsImage = goal === "vision" || (goal === "design" && attachImage);
  const needsBriefs = visualGoal !== null;
  const keyList = useMemo(
    () =>
      needsBriefs && entries
        ? JSON.stringify(
            [...new Set(entries.map((m) => m.knowledge_key))].sort(),
          )
        : null,
    [needsBriefs, entries],
  );
  const index = useModelSummaries(keyList);
  const evidence = useMemo(
    () =>
      visualGoal && entries && index.state?.cards
        ? poolEvidence(entries, index.state.cards, visualGoal, benchmark)
        : null,
    [visualGoal, entries, index.state?.cards, benchmark],
  );
  const catalogKeys = useMemo(
    () => new Map(entries?.map((m) => [memberKey(m), m.knowledge_key])),
    [entries],
  );
  const rows = useMemo(
    () =>
      poolSuggestions(
        entries ?? [],
        pools,
        members,
        ref,
        goal,
        query,
        connection,
        activeBans ?? [],
        Date.now() / 1000,
        evidence?.byKey,
        needsImage,
      ),
    [
      entries,
      pools,
      members,
      ref,
      goal,
      query,
      connection,
      activeBans,
      evidence,
      needsImage,
    ],
  );
  // What the Wiki cards say about context, for listings that state none.
  const cardContext = useMemo(
    () =>
      new Map(
        (index.state?.cards ?? []).flatMap((card) =>
          card.context_window ? [[card.key, card.context_window] as const] : [],
        ),
      ),
    [index.state?.cards],
  );
  const sources = new Set(members.map((m) => m.provider_id)).size;
  const primaryContext =
    members[0] &&
    entries?.find((m) => memberKey(m) === memberKey(members[0]))
      ?.context_tokens;
  function jump(id: string) {
    const el = document.getElementById(id);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "start" });
  }
  const already = (m: Member) =>
    members.some((r) => memberKey(r) === memberKey(m));
  const add = (m: Member) => {
    setMembers((current) =>
      current.some((r) => memberKey(r) === memberKey(m))
        ? current
        : [
            ...current,
            { provider_id: m.provider_id, upstream_id: m.upstream_id },
          ],
    );
    setError("");
  };
  const move = (at: number, to: number) => {
    if (to < 0 || to >= members.length) return;
    const next = [...members];
    [next[at], next[to]] = [next[to], next[at]];
    setMembers(next);
  };
  const manualMember = { provider_id: provider, upstream_id: id.trim() };
  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.putPool(name.trim(), members, !draft.existing);
      notifications.show({
        id: "pool-builder-saved",
        color: "teal",
        message: `Pool ${name.trim()} saved`,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
  return (
    <Modal
      opened
      onClose={() => {
        if (!busy) onClose();
      }}
      closeOnClickOutside={false}
      closeOnEscape={!busy}
      withCloseButton={!busy}
      size="64rem"
      xOffset="min(2vw, 1rem)"
      yOffset="min(2vh, 2rem)"
      centered
      classNames={{ content: "pb-modal", body: "pb-body" }}
      title={
        <div className="pb-heading">
          <span className="pb-emblem">
            <IconRoute size={23} />
          </span>
          <span className="pb-dialog-name">
            {draft.existing ? "Edit pool" : "New pool"}
          </span>
        </div>
      }
    >
      <fieldset className="pb-work" disabled={busy}>
        <div className="pb-setup">
          <TextInput
            label="Pool name"
            placeholder="e.g. coding-team"
            description="The model ID your clients send."
            size="sm"
            data-autofocus={!draft.existing}
            disabled={draft.existing}
            maxLength={64}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={(name.length > 0 && nameIssue) || undefined}
          />
          <NativeSelect
            label="Reference pool"
            description="Use its members to prioritize suggestions."
            size="sm"
            data={[
              { value: "", label: "No reference" },
              ...pools
                .filter((p) => p.name !== draft.name)
                .map((p) => ({ value: p.name, label: p.name })),
            ]}
            value={ref}
            onChange={(e) => {
              setRef(e.currentTarget.value);
              setLimit(PAGE);
            }}
          />
        </div>
        <div className="pb-layout">
          <section
            className="pb-finder"
            id="pb-finder"
            tabIndex={-1}
            aria-label="Model finder"
          >
            <div className="pb-title">
              <h3>Model finder</h3>
              <span className="pb-count">
                {entries ? `${entries.length} in catalog` : "Catalog"}
              </span>
            </div>
            <div
              className="pb-goals"
              role="group"
              aria-label="Prioritize models for"
            >
              {poolGoals.map((g) => (
                <button
                  type="button"
                  key={g.value}
                  aria-pressed={goal === g.value}
                  onClick={() => {
                    setGoal(g.value);
                    setLimit(PAGE);
                  }}
                >
                  <g.icon size={14} />
                  {g.label}
                </button>
              ))}
            </div>
            <p className="pb-hint">
              {poolGoals.find((g) => g.value === goal)?.hint}
            </p>
            {visualGoal && (
              <div className="pb-evidence" aria-label="Model selection reasons">
                <span className="pb-label">Selection reasons · saved Wiki</span>
                {visualGoal === "design" && (
                  <Checkbox
                    size="xs"
                    my="xs"
                    label="I’ll attach a screenshot or mockup"
                    checked={attachImage}
                    onChange={(e) => {
                      setAttachImage(e.currentTarget.checked);
                      setLimit(PAGE);
                    }}
                  />
                )}
                {index.state?.error ? (
                  <p>
                    Wiki is unavailable. Recommendations use catalog data only.{" "}
                    <button type="button" onClick={index.reload}>
                      Retry Wiki
                    </button>
                  </p>
                ) : !evidence ? (
                  <p>
                    {catalog.error
                      ? "Waiting for catalog data."
                      : "Reading saved model briefs…"}
                  </p>
                ) : evidence.metric ? (
                  <>
                    <NativeSelect
                      label="Compare the same benchmark"
                      size="xs"
                      value={evidence.metric.id}
                      onChange={(e) => {
                        setBenchmark(e.currentTarget.value);
                        setLimit(PAGE);
                      }}
                      data={evidence.options.map((o) => ({
                        value: o.id,
                        label: `${o.label} (${o.count})`,
                      }))}
                    />
                    <p>
                      {evidence.metric.count} distinct{" "}
                      {evidence.metric.count === 1
                        ? "model has"
                        : "models have"}{" "}
                      this measurement. Scored models first
                      {needsImage ? " within each image-input group" : ""};
                      missing is not zero.
                    </p>
                  </>
                ) : (
                  <p>
                    {visualGoal === "design"
                      ? "No comparable frontend benchmark in this catalog. Showing documented UI work, then route fit."
                      : "No comparable screen-task benchmark in this catalog. Showing documented image input, then screen use cases."}
                  </p>
                )}
              </div>
            )}
            <div className="pb-search">
              <TextInput
                aria-label="Search models"
                placeholder="Search model or connection"
                size="xs"
                leftSection={<IconSearch size={14} />}
                value={query}
                onChange={(e) => {
                  setQuery(e.currentTarget.value);
                  setLimit(PAGE);
                }}
              />
              <NativeSelect
                aria-label="Filter by connection"
                size="xs"
                value={connection}
                onChange={(e) => {
                  setConnection(e.currentTarget.value);
                  setLimit(PAGE);
                }}
                data={[{ value: "", label: "All connections" }, ...providerIds]}
              />
            </div>
            {catalog.error && (
              <Alert color="orange" title="Catalog could not be read">
                {catalog.error}{" "}
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={catalog.reload}
                >
                  Retry
                </Button>
              </Alert>
            )}
            {bans.error && (
              <p className="pb-hint">
                Ban status unavailable. Suggestions are not health checks.
              </p>
            )}
            <div className="pb-options" aria-label="Suggested models">
              {rows
                .slice(0, limit)
                .map(({ model, reasons, banned, result }) => (
                  <article key={memberKey(model)} className="pb-option">
                    <ProviderLogo providerId={model.provider_id} size={24} />
                    <div className="pb-copy">
                      <ModelHoverCard
                        upstreamId={model.upstream_id}
                        providerId={model.provider_id}
                      >
                        <strong>{model.upstream_id}</strong>
                      </ModelHoverCard>
                      <span className="pb-meta">
                        {model.provider_id}
                        {(model.context_tokens ?? cardContext.get(model.knowledge_key)) && (
                          <>
                            {" "}
                            <i>·</i>{" "}
                            {contextWindow(
                              model.context_tokens ?? cardContext.get(model.knowledge_key)!,
                            )}{" "}
                            context
                          </>
                        )}
                      </span>
                      {result && (
                        <div className="pb-eval">
                          <strong>{result.rating.value}</strong>{" "}
                          {result.benchmark.label}
                          <small>
                            {result.benchmark.source}
                            {result.rating.as_of ? ` · ${result.rating.as_of}` : ""}
                          </small>
                        </div>
                      )}
                      <span className="pb-reason">
                        {banned && <b>Active ban · </b>}
                        {reasons.slice(0, 2).join(" · ")}
                        {primaryContext &&
                        model.context_tokens &&
                        model.context_tokens < primaryContext
                          ? " · Smaller context than primary"
                          : ""}
                      </span>
                    </div>
                    <ActionIcon
                      className="pb-add"
                      variant="light"
                      size="lg"
                      title={members.length ? "Add fallback" : "Set primary"}
                      aria-label={`Add ${model.upstream_id} on ${model.provider_id}`}
                      onClick={() => add(model)}
                    >
                      <IconPlus size={17} />
                    </ActionIcon>
                  </article>
                ))}
            </div>
            {!rows.length && (
              <p className="pb-hint" role="status">
                {!entries && !catalog.error
                  ? "Reading the catalog…"
                  : catalog.error
                    ? "You can still add a known model ID below."
                    : query || connection
                      ? "No remaining models match these filters."
                      : "No more catalog models to add."}
              </p>
            )}
            {rows.length > limit && (
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => setLimit((v) => v + PAGE)}
              >
                Show more models ({rows.length - limit})
              </Button>
            )}
            <div className="pb-manual">
              <button
                type="button"
                aria-expanded={manual}
                onClick={() => setManual(!manual)}
              >
                {manual ? "Hide manual entry" : "Model not listed? Add by ID"}
              </button>
              {manual && (
                <div>
                  <NativeSelect
                    label="Connection"
                    size="xs"
                    value={provider}
                    onChange={(e) => setProvider(e.currentTarget.value)}
                    data={[
                      { value: "", label: "Choose connection" },
                      ...providerIds,
                    ]}
                  />
                  <TextInput
                    label="Upstream model ID"
                    size="xs"
                    value={id}
                    onChange={(e) => setId(e.currentTarget.value)}
                  />
                  <Button
                    size="xs"
                    variant="default"
                    disabled={
                      !providerIds.includes(provider) ||
                      !id.trim() ||
                      already(manualMember)
                    }
                    onClick={() => {
                      add(manualMember);
                      setId("");
                    }}
                  >
                    Add ID
                  </Button>
                </div>
              )}
            </div>
          </section>
          <section
            className="pb-route"
            id="pb-route"
            tabIndex={-1}
            aria-label="Route preview"
          >
            <div className="pb-title">
              <h3>Your route</h3>
              <IconLayersLinked size={22} />
            </div>
            <p className="pb-hint">
              The router tries the primary first, then fallbacks in the order
              below.
            </p>
            {!members.length && (
              <div className="pb-empty">
                <span>01</span>
                <strong>Choose your primary</strong>
                <p>
                  Add a model from the finder. Nothing routes here until you
                  save.
                </p>
              </div>
            )}
            <ol>
              {members.map((m, i) => (
                <li key={memberKey(m)}>
                  <span className="pb-step">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="pb-copy">
                    <Badge
                      size="xs"
                      variant={i ? "default" : "light"}
                      tt="none"
                    >
                      {i ? "Fallback" : "Primary"}
                    </Badge>
                    <strong>{m.upstream_id}</strong>
                    <span className="pb-meta">
                      {m.provider_id}
                      {!providerIds.includes(m.provider_id)
                        ? " · Unconfigured connection"
                        : ""}
                    </span>
                    {activeBans?.some(
                      (b) =>
                        memberKey(b) === memberKey(m) &&
                        b.expires_at_unix > Date.now() / 1000,
                    ) && (
                      <Badge size="xs" color="orange" variant="light">
                        Active ban
                      </Badge>
                    )}
                    {needsImage && (
                      <span className="pb-reason">
                        {evidence?.byKey.get(
                          catalogKeys.get(memberKey(m)) ?? "",
                        )?.imageInput
                          ? "Wiki: image input documented"
                          : "Check image input before routing screenshots"}
                      </span>
                    )}
                    <div className="pb-order">
                      {[
                        {
                          label: "Move up",
                          icon: IconArrowUp,
                          run: () => move(i, i - 1),
                          off: !i,
                        },
                        {
                          label: "Move down",
                          icon: IconArrowDown,
                          run: () => move(i, i + 1),
                          off: i === members.length - 1,
                        },
                        {
                          label: "Remove",
                          icon: IconX,
                          run: () =>
                            setMembers(members.filter((_, j) => i !== j)),
                          off: false,
                        },
                      ].map((a) => (
                        <ActionIcon
                          key={a.label}
                          size="sm"
                          variant="subtle"
                          color="gray"
                          title={a.label}
                          aria-label={`${a.label}: ${m.upstream_id} on ${m.provider_id}`}
                          disabled={a.off}
                          onClick={a.run}
                        >
                          <a.icon size={14} />
                        </ActionIcon>
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            {members.length > 0 && (
              <div className="pb-note">
                {members.length === 1
                  ? "Primary selected. Add another connection if you want a fallback."
                  : sources === 1
                    ? "All members share one connection. Its outage can affect every fallback."
                    : `${sources} connections in this route. Check that each model supports your client’s requests.`}
              </div>
            )}
            <button
              type="button"
              className="pb-jump"
              onClick={() => jump("pb-finder")}
            >
              Back to models ↑
            </button>
          </section>
        </div>
      </fieldset>
      <div className="pb-bottom">
        {error && (
          <Alert role="alert" color="red">
            {error}
          </Alert>
        )}
        <div>
          <button
            type="button"
            className="pb-route-link"
            aria-label="View route preview"
            onClick={() => jump("pb-route")}
          >
            <span className="pb-link-label">View route</span>
            <span aria-live="polite">
              {members.length
                ? `${members.length} ${members.length === 1 ? "member" : "members"} · ${sources} ${sources === 1 ? "connection" : "connections"}`
                : "No members yet"}
            </span>{" "}
            ↓
          </button>
          <Button size="xs" variant="default" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="xs"
            leftSection={<IconCheck size={15} />}
            disabled={!valid}
            title={
              !name.trim()
                ? "Enter a pool name"
                : !members.length
                  ? "Choose a primary model"
                  : undefined
            }
            loading={busy}
            onClick={save}
          >
            {draft.existing ? "Save members" : "Create pool"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
