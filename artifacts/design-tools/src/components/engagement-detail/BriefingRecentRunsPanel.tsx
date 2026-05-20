import { useMemo, useState } from "react";
import {
  useListEngagementBriefingGenerationRuns,
  getListEngagementBriefingGenerationRunsQueryKey,
  type BriefingGenerationRun,
  type EngagementBriefingNarrative,
} from "@workspace/api-client-react";
import {
  BriefingPriorNarrativeDiff,
  BriefingPriorSnapshotHeader,
} from "@workspace/briefing-prior-snapshot";
import {
  readRecentRunsFilterFromUrl,
  readRecentRunsOpenFromUrl,
  writeRecentRunsFilterToUrl,
  writeRecentRunsOpenToUrl,
  type RecentRunsFilter,
} from "./urlState";

/**
 * Human-readable label for one {@link BriefingGenerationRun}'s state.
 * Pinned to the wire enum so a forward-compat value falls back to the
 * raw slug rather than rendering blank — same defensive shape the
 * SubmissionStatusBadge in plan-review uses.
 */
const BRIEFING_RUN_STATE_LABELS: Record<
  BriefingGenerationRun["state"],
  string
> = {
  pending: "Running",
  completed: "Completed",
  failed: "Failed",
};

const BRIEFING_RUN_STATE_COLORS: Record<
  BriefingGenerationRun["state"],
  { bg: string; fg: string }
> = {
  pending: { bg: "var(--info-dim)", fg: "var(--info-text)" },
  completed: { bg: "var(--success-dim)", fg: "var(--success-text)" },
  failed: { bg: "var(--danger-dim)", fg: "var(--danger-text)" },
};

function BriefingRunStateBadge({
  state,
}: {
  state: BriefingGenerationRun["state"];
}) {
  const label = BRIEFING_RUN_STATE_LABELS[state] ?? state;
  const palette =
    BRIEFING_RUN_STATE_COLORS[state] ?? BRIEFING_RUN_STATE_COLORS.pending;
  return (
    <span
      data-testid={`briefing-run-state-badge-${state}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "1px 6px",
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.2,
        textTransform: "uppercase",
        lineHeight: 1.4,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Recent runs disclosure for the briefing tab — Task #230.
 *
 * Surfaces the most recent N briefing-generation attempts the
 * sweep retains (default 5, see
 * `briefingGenerationJobsSweep#DEFAULT_KEEP_PER_ENGAGEMENT`) so
 * an auditor can compare "the run before the bad one" without
 * SSHing into the database. Collapsed by default — the running
 * narrative above is what the auditor lands on, and the prior
 * attempts are an investigation aid, not a primary read.
 *
 * Each row renders the attempt's outcome (state + timestamp). The
 * row expands to surface its `error` (failed branch) or
 * `invalidCitationCount` (completed branch) inline so the
 * comparison window is one click away — clicking a past run
 * doesn't open a modal or navigate away from the briefing the
 * auditor is currently inspecting.
 *
 * The list re-fetches when the parent invalidates its query key,
 * which the parent (`BriefingNarrativePanel`) wires up on
 * generation kickoff and on the pending → terminal transition.
 */
export function BriefingRecentRunsPanel({
  engagementId,
  narrativeGenerationId,
  narrativeIsLoaded,
  currentNarrative,
}: {
  engagementId: string;
  /**
   * Task #281 — id of the `briefing_generation_jobs` row that produced
   * the narrative currently rendered in the parent
   * `BriefingNarrativePanel`, or `null` when no producing run is on
   * file (the engine has never run for this engagement, the very
   * first generation is still pending, the producing job was
   * already pruned out of the keep window, or the row pre-dates
   * the column and the post-merge backfill didn't have a matching
   * job to attribute to). The panel marks the row whose
   * `generationId` equals this value with the "Current" pill —
   * direct id equality, no timestamp inference — so the badge stays
   * exact even when two completions race, the runs route paginates,
   * or a backfill writes sections without inserting a job row.
   * When this is `null` no row is marked, so a brand-new engagement
   * (or one whose producing job has aged out) doesn't sport a
   * misleading "Current" pill on an unrelated row.
   */
  narrativeGenerationId: string | null;
  /**
   * Task #301 — `true` when the briefing query has resolved a
   * non-null `narrative` payload (i.e. there are A–G section
   * bodies on screen above the disclosure), independent of whether
   * the producing job's id is still on file. Combined with a null
   * `narrativeGenerationId` this means: the auditor is looking at
   * a real narrative whose producing run has aged out of the
   * keep-N retention window (or pre-dates the `generation_id`
   * column and the post-merge backfill couldn't attribute it).
   * In that combination the panel renders a one-line caption
   * explaining why no row is marked Current, so the missing pill
   * doesn't read as "the disclosure is broken." When the
   * narrative itself is null (engine has never run for this
   * engagement, or the very first generation is still pending)
   * no caption renders — the absence of a Current pill is
   * already self-explanatory.
   */
  narrativeIsLoaded: boolean;
  /**
   * Task #303 B.5 — the narrative *currently* on screen in the
   * parent panel. The prior-narrative block diffs each A–G section
   * against the matching section in this value so the auditor can
   * see, word by word, what the most recent regeneration removed
   * and added relative to the snapshot the briefing was holding
   * before. When `null` (no narrative on file yet) the diff
   * collapses to "every prior token is unchanged", which renders
   * the prior body verbatim — the safe degenerate case.
   */
  currentNarrative: EngagementBriefingNarrative | null;
}) {
  // Task #275 — both the open/closed state of the disclosure and the
  // active filter are mirrored to the URL so an auditor who finds a
  // suspicious failed-then-rerun pattern can drop a link in a Slack
  // thread that lands a teammate on the same filtered, already-open
  // view. The setters below sync to `replaceState` on every change to
  // avoid polluting back-button history with one entry per click.
  // (`RecentRunsFilter` is declared next to the URL helpers at the
  // top of the file so the helpers can reference it.)
  const [open, setOpenState] = useState<boolean>(() =>
    readRecentRunsOpenFromUrl(),
  );
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    writeRecentRunsOpenToUrl(next);
  };
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  // Task #355 — the title row, the meta line, and the
  // "Copy plain text" button (the latter delegating to the
  // Task #350 `<CopyPlainTextButton />` in `@workspace/portal-ui`
  // for the discriminated success / error pill state, the ~2 s
  // revert timer, the unmount cleanup, and the
  // `briefing-run-prior-narrative-copy-*` testids) now live in
  // the shared `<BriefingPriorSnapshotHeader />` from
  // `@workspace/briefing-prior-snapshot`. The two surfaces
  // consume one implementation so the JSX, testids, friendly
  // actor rewrite, and copy-button timing can never drift.
  // Task #262 — auditors comparing the failed-then-rerun pattern on a
  // noisy engagement need a way to slice the retained list down to the
  // suspicious rows. The filter is purely client-side (the route
  // contract is unchanged) and "All" is the default so the disclosure
  // still opens onto the full history.
  const [filter, setFilterState] = useState<RecentRunsFilter>(() =>
    readRecentRunsFilterFromUrl(),
  );
  const setFilter = (next: RecentRunsFilter): void => {
    setFilterState(next);
    writeRecentRunsFilterToUrl(next);
  };
  // Only fetch when the disclosure is open. The status poll above
  // already drives the at-a-glance "what is the latest run doing?"
  // story — this list is the deeper comparison view, so it can stay
  // dormant until the auditor explicitly asks for it. Saves one
  // extra round trip on every page load for a feature most users
  // will not open every visit.
  const runsQuery = useListEngagementBriefingGenerationRuns(engagementId, {
    query: {
      queryKey: getListEngagementBriefingGenerationRunsQueryKey(engagementId),
      enabled: open,
      refetchOnWindowFocus: false,
    },
  });
  const runs = runsQuery.data?.runs ?? [];
  // Task #280 — the wire envelope also carries the section_a..g
  // backup the briefing held *before* its current narrative was
  // written. There's at most one (the briefing row only retains
  // one snapshot — older runs have already been overwritten by
  // newer regenerations) so we resolve the producing row by
  // matching its [startedAt, completedAt] interval against the
  // backup's `generatedAt` timestamp, mirroring the Current-pill
  // logic below. Older rows whose backups were already overwritten
  // simply don't match and fall through to the existing details.
  const priorNarrative = runsQuery.data?.priorNarrative ?? null;
  const count = runs.length;
  type RecentRun = (typeof runs)[number];
  // Task #276 — pre-compute the per-bucket tallies so each filter chip
  // can render a count alongside its label. Surfacing the count means
  // an auditor can see at a glance whether the comparison-of-attempts
  // story is even worth opening, instead of clicking each chip just
  // to discover the empty-state copy. The buckets stay in sync with
  // the predicate below by using the same conditions.
  const failedCount = runs.filter(
    (run: RecentRun) => run.state === "failed",
  ).length;
  const invalidCount = runs.filter(
    (run: RecentRun) =>
      run.state === "completed" && (run.invalidCitationCount ?? 0) > 0,
  ).length;
  const filterCounts: Record<RecentRunsFilter, number> = {
    all: count,
    failed: failedCount,
    invalid: invalidCount,
  };
  const visibleRuns = runs.filter((run: RecentRun) => {
    if (filter === "failed") return run.state === "failed";
    if (filter === "invalid") {
      return (
        run.state === "completed" && (run.invalidCitationCount ?? 0) > 0
      );
    }
    return true;
  });
  const visibleCount = visibleRuns.length;
  // Task #281 — match the on-screen narrative to its producing
  // row by direct id equality. The server stamps the producing
  // job's id onto `parcel_briefings.generation_id` inside the
  // same transaction that overwrites the section columns, so
  // the briefing's `narrative.generationId` *is* the row that
  // produced what's on screen — no timestamp window inference
  // required. We still confirm the matching id is actually
  // present in the runs list (the producing job may have aged
  // out of the keep window between the briefing fetch and the
  // runs fetch, in which case no row should be marked) and we
  // search the full `runs` list rather than `visibleRuns` so
  // the Task #262 filter cannot accidentally suppress the pill
  // when the producing row is filtered out of view. When
  // `narrativeGenerationId` is null (legacy unbackfilled row,
  // pruned producing job, or no generation has ever run on
  // this briefing) we honestly mark nothing instead of
  // mislabelling an unrelated row.
  const currentGenerationId = useMemo<string | null>(() => {
    if (narrativeGenerationId === null) return null;
    for (const run of runs as RecentRun[]) {
      if (run.generationId === narrativeGenerationId) {
        return run.generationId;
      }
    }
    return null;
  }, [narrativeGenerationId, runs]);

  // Task #280 — same interval-match shape as Current, but against
  // the prior narrative's `generatedAt`. Resolves to the
  // generationId of the row that produced the body now living in
  // `prior_section_*` (i.e. the run *before* the one whose output
  // is currently on screen). Older rows in the list whose backups
  // have already been overwritten will not match — the briefing
  // row only retains one snapshot — so they fall through to the
  // existing details branch with no prior body to render. A
  // missing or unparseable timestamp resolves to null so we
  // never pick an arbitrary row.
  //
  // Task #313 — legacy backups can carry `generatedBy` without a
  // `generatedAt` (per-row provenance was added after the section
  // backup columns on some installs). Without a fallback, the
  // entire prior block is suppressed even though we have the
  // actor on file, costing auditors useful "who regenerated this
  // last" provenance on older engagements. When `generatedAt` is
  // null but `generatedBy` is set, attach the prior body to the
  // most recent completed run that pre-dates the current
  // narrative — the meta line will gracefully render just the
  // "by …" half (the existing presence check on each half
  // already handles that, so we never fabricate a date).
  const priorGenerationId = useMemo<string | null>(() => {
    if (!priorNarrative) return null;
    if (priorNarrative.generatedAt !== null) {
      // The orval/zod codegen coerces `generatedAt` to `Date`, but
      // tests + the runtime queryFn pass through ISO strings, so
      // normalize via `new Date(...)` which accepts both shapes
      // and yields `NaN` on garbage.
      const stampedMs = new Date(
        priorNarrative.generatedAt as Date | string,
      ).getTime();
      if (Number.isNaN(stampedMs)) return null;
      for (const run of runs as RecentRun[]) {
        if (run.state !== "completed") continue;
        if (run.completedAt === null) continue;
        const startedMs = Date.parse(String(run.startedAt));
        const completedMs = Date.parse(String(run.completedAt));
        if (Number.isNaN(startedMs) || Number.isNaN(completedMs)) continue;
        if (stampedMs >= startedMs && stampedMs <= completedMs) {
          return run.generationId;
        }
      }
      return null;
    }
    // Fallback path — `generatedAt` is null. Only attempt the
    // actor-only fallback when we actually have an actor to
    // surface; otherwise we'd be picking a row purely to render
    // an empty meta line, which is exactly the noise the
    // interval matcher exists to avoid.
    if (priorNarrative.generatedBy === null) return null;
    // Bound the search to runs that pre-date whatever produced the
    // current narrative. When the current run is in the retained
    // window we can use its `startedAt` as a hard boundary; when
    // it isn't (pruned by the keep-N sweep) we fall back to "most
    // recent completed run on file", since the prior body is by
    // definition not the current narrative and any earlier
    // completed run is a better answer than suppressing the
    // block entirely.
    let boundaryMs: number | null = null;
    if (currentGenerationId !== null) {
      for (const run of runs as RecentRun[]) {
        if (run.generationId === currentGenerationId) {
          const startedMs = Date.parse(String(run.startedAt));
          if (!Number.isNaN(startedMs)) boundaryMs = startedMs;
          break;
        }
      }
    }
    // The runs list arrives newest-first, so the first eligible
    // completed row is the most recent one that pre-dates the
    // current narrative.
    for (const run of runs as RecentRun[]) {
      if (run.state !== "completed") continue;
      if (run.generationId === currentGenerationId) continue;
      if (boundaryMs !== null) {
        const startedMs = Date.parse(String(run.startedAt));
        if (Number.isNaN(startedMs)) continue;
        if (startedMs >= boundaryMs) continue;
      }
      return run.generationId;
    }
    return null;
  }, [priorNarrative, runs, currentGenerationId]);

  return (
    <div
      data-testid="briefing-recent-runs"
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        background: "var(--surface-1, transparent)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls="briefing-recent-runs-body"
        data-testid="briefing-recent-runs-toggle"
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600 }}>Recent runs</span>
        <span
          aria-hidden
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginLeft: 12,
          }}
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div
          id="briefing-recent-runs-body"
          data-testid="briefing-recent-runs-body"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            padding: "0 12px 12px 12px",
          }}
        >
          {/*
            Task #301 — when the narrative is on screen but the
            producing job's id is no longer on file (the run aged
            out of the keep-N sweep window, or the row pre-dates
            the `generation_id` column), no row in the list below
            can carry the "Current" pill. Without a signal, the
            missing pill reads as "the disclosure is broken." A
            one-line caption above the list closes that loop
            without changing any other behavior. Suppressed when
            the narrative itself is null (no producing run has
            ever been stamped) — the absence of a Current pill is
            already self-explanatory in that case.
          */}
          {narrativeIsLoaded && narrativeGenerationId === null && (
            <div
              data-testid="briefing-recent-runs-pruned-caption"
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                paddingBottom: 4,
              }}
            >
              The run that produced this narrative is no longer in
              the retained window.
            </div>
          )}
          {runsQuery.isLoading && (
            <div
              data-testid="briefing-recent-runs-loading"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              Loading recent runs…
            </div>
          )}
          {runsQuery.isError && !runsQuery.isLoading && (
            <div
              role="alert"
              data-testid="briefing-recent-runs-error"
              style={{ fontSize: 12, color: "var(--danger-text)" }}
            >
              Couldn't load recent runs. Try again.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && count === 0 && (
            <div
              data-testid="briefing-recent-runs-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No briefing generations have run yet for this engagement.
            </div>
          )}
          {!runsQuery.isLoading && !runsQuery.isError && count > 0 && (
            <div
              role="group"
              aria-label="Filter recent runs"
              data-testid="briefing-recent-runs-filter"
              style={{
                display: "flex",
                gap: 4,
                paddingBottom: 4,
              }}
            >
              {(
                [
                  { key: "all", label: "All" },
                  { key: "failed", label: "Failed" },
                  { key: "invalid", label: "Has invalid citations" },
                ] as const
              ).map((opt) => {
                const active = filter === opt.key;
                const bucketCount = filterCounts[opt.key];
                return (
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={active}
                    data-testid={`briefing-recent-runs-filter-${opt.key}`}
                    onClick={() => {
                      setFilter(opt.key);
                      // Collapse any expanded row that the new filter
                      // would hide so the disclosure doesn't keep an
                      // off-screen detail block "open" in state.
                      setExpandedRunId(null);
                    }}
                    style={{
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 999,
                      border: "1px solid var(--border-subtle)",
                      background: active
                        ? "var(--surface-2, var(--accent-subtle, #eef))"
                        : "transparent",
                      color: active
                        ? "var(--text-default)"
                        : "var(--text-muted)",
                      cursor: "pointer",
                    }}
                  >
                    {opt.label}{" "}
                    {/*
                      Task #276 — render the matching-run count next to
                      each chip's label so an auditor can see at a glance
                      whether narrowing to that bucket would surface
                      anything (e.g. "Failed (0)" warns the auditor not
                      to bother clicking through to the empty-state).
                      The count tracks the same predicate the active
                      filter applies, so the displayed number always
                      matches the row count the auditor would see.
                    */}
                    <span
                      data-testid={`briefing-recent-runs-filter-${opt.key}-count`}
                      style={{ opacity: 0.7 }}
                    >
                      ({bucketCount})
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {count > 0 && visibleCount === 0 && (
            <div
              data-testid="briefing-recent-runs-filter-empty"
              style={{ fontSize: 12, color: "var(--text-muted)" }}
            >
              No runs match this filter.
            </div>
          )}
          {visibleCount > 0 && (
            <ul
              data-testid="briefing-recent-runs-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {visibleRuns.map((run) => {
                const isExpanded = expandedRunId === run.generationId;
                const isCurrent = run.generationId === currentGenerationId;
                // Task #280 — only the row whose interval contains
                // the prior backup's `generatedAt` gets the inline
                // prior body. Older rows (whose backups have already
                // been overwritten by newer regenerations) fall
                // through to the existing details branch with no
                // prior section block — the briefing row only
                // retains one snapshot, so we can't honestly surface
                // anything for them.
                const isPriorRow =
                  priorGenerationId !== null &&
                  run.generationId === priorGenerationId;
                const startedLabel = new Date(run.startedAt).toLocaleString();
                const detailAvailable =
                  (run.state === "failed" && !!run.error) ||
                  (run.state === "completed" &&
                    (run.invalidCitationCount ?? 0) > 0);
                return (
                  <li
                    key={run.generationId}
                    data-testid={`briefing-run-${run.generationId}`}
                    aria-current={isCurrent ? "true" : undefined}
                    style={{
                      // Task #263 — subtly highlight the row whose
                      // generation produced the narrative on screen
                      // so the comparison story ("here's what's on
                      // screen, and here's what was on screen
                      // before it") reads end-to-end. Use the same
                      // info accent the success badges already use
                      // so the highlight is visible without
                      // shouting; the explicit "Current" pill in
                      // the row header carries the meaning.
                      border: isCurrent
                        ? "1px solid var(--info-text)"
                        : "1px solid var(--border-subtle)",
                      borderRadius: 4,
                      background: isCurrent
                        ? "var(--info-dim)"
                        : "transparent",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedRunId((prev) =>
                          prev === run.generationId ? null : run.generationId,
                        )
                      }
                      aria-expanded={isExpanded}
                      data-testid={`briefing-run-toggle-${run.generationId}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 8px",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12,
                      }}
                    >
                      <BriefingRunStateBadge state={run.state} />
                      {isCurrent && (
                        <span
                          data-testid={`briefing-run-current-pill-${run.generationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--info-text)",
                            color: "var(--bg-input, #fff)",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                            lineHeight: 1.4,
                          }}
                        >
                          Current
                        </span>
                      )}
                      {isPriorRow && (
                        // Task #280 — flag the row that produced
                        // what was on screen *before* the Current
                        // narrative so the side-by-side comparison
                        // story reads end-to-end. Same shape as
                        // the Current pill but in a muted accent
                        // so it never competes visually with
                        // "what is on screen right now".
                        <span
                          data-testid={`briefing-run-prior-pill-${run.generationId}`}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "1px 6px",
                            borderRadius: 4,
                            background: "var(--surface-2, var(--border-subtle))",
                            color: "var(--text-muted)",
                            fontSize: 10,
                            fontWeight: 600,
                            letterSpacing: 0.2,
                            textTransform: "uppercase",
                            lineHeight: 1.4,
                          }}
                        >
                          Prior
                        </span>
                      )}
                      <span style={{ flex: 1, color: "var(--text-default)" }}>
                        {startedLabel}
                      </span>
                      {run.state === "completed" &&
                        (run.invalidCitationCount ?? 0) > 0 && (
                          <span
                            data-testid={`briefing-run-invalid-count-${run.generationId}`}
                            style={{
                              fontSize: 11,
                              color: "var(--warning-text)",
                            }}
                          >
                            {run.invalidCitationCount} invalid citation
                            {run.invalidCitationCount === 1 ? "" : "s"}
                          </span>
                        )}
                      <span
                        aria-hidden
                        style={{ fontSize: 11, color: "var(--text-muted)" }}
                      >
                        {isExpanded ? "▾" : "▸"}
                      </span>
                    </button>
                    {isExpanded && (
                      <div
                        data-testid={`briefing-run-details-${run.generationId}`}
                        style={{
                          padding: "0 8px 8px 8px",
                          fontSize: 12,
                          color: "var(--text-muted)",
                          display: "flex",
                          flexDirection: "column",
                          gap: 2,
                        }}
                      >
                        <div>
                          Started: {new Date(run.startedAt).toLocaleString()}
                        </div>
                        <div>
                          Completed:{" "}
                          {run.completedAt
                            ? new Date(run.completedAt).toLocaleString()
                            : "—"}
                        </div>
                        {run.state === "failed" && (
                          <div
                            data-testid={`briefing-run-error-${run.generationId}`}
                            style={{ color: "var(--danger-text)" }}
                          >
                            Error: {run.error ?? "Unknown error"}
                          </div>
                        )}
                        {run.state === "completed" && (
                          <div
                            data-testid={`briefing-run-invalid-detail-${run.generationId}`}
                          >
                            Invalid citations:{" "}
                            {run.invalidCitationCount ?? 0}
                          </div>
                        )}
                        {!detailAvailable && run.state === "pending" && (
                          <div>Generation in progress…</div>
                        )}
                        {isPriorRow && priorNarrative && (
                          // Task #280 — render the seven A–G section
                          // bodies the briefing held *before* its
                          // current narrative was written. Only
                          // mounted on the Prior row (the one whose
                          // [startedAt, completedAt] interval
                          // contains the backup's `generatedAt`),
                          // so older rows whose backups have already
                          // been overwritten don't get a misleading
                          // "this is the prior body" block. The
                          // Current row never reaches this branch
                          // either — its narrative is already
                          // rendered above the disclosure, so
                          // duplicating it here would be noise.
                          //
                          // Task #355 — the title row, "Generated
                          // <when> by <actor>" meta line, and "Copy
                          // plain text" button (with its 2 s
                          // "Copied!" confirmation) live in
                          // `@workspace/briefing-prior-snapshot` so
                          // the testids, copy payload shape, and
                          // revert timing stay byte-identical with
                          // the Plan Review surface without copy-
                          // pasting two parallel JSX subtrees. The
                          // per-section diff below is panel-render-
                          // specific and stays inline.
                          //
                          // Task #303 B.5 — per-section word-level
                          // diff vs the current narrative, rendered
                          // with strikethrough for tokens the new
                          // run dropped and underline for tokens
                          // it inserted. When the section is
                          // identical the renderer falls through
                          // to a "(unchanged)" pill so the
                          // auditor isn't asked to re-read
                          // identical paragraphs.
                          <div
                            data-testid={`briefing-run-prior-narrative-${run.generationId}`}
                            style={{
                              marginTop: 6,
                              display: "flex",
                              flexDirection: "column",
                              gap: 4,
                              borderTop: "1px solid var(--border-subtle)",
                              paddingTop: 6,
                            }}
                          >
                            <BriefingPriorSnapshotHeader
                              runGenerationId={run.generationId}
                              priorNarrative={priorNarrative}
                            />
                            <BriefingPriorNarrativeDiff
                              runGenerationId={run.generationId}
                              priorNarrative={priorNarrative}
                              currentNarrative={currentNarrative}
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
