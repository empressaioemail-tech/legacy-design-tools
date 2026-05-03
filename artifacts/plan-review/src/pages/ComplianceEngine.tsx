/**
 * Task #493 — Compliance Engine console.
 *
 * Reviewer-only console at `/compliance` that surfaces every recent
 * finding-engine run across every submission in one feed. The page
 * complements the per-submission FindingsRunsPanel embedded in the
 * submission-detail modal — that panel is scoped to a single
 * submission, this page is the portfolio-wide view used by reviewers
 * who triage multiple submissions per day.
 *
 * Surface composition:
 *   - KPI strip (totalRuns, successRate, avgDurationMs,
 *     invalidCitationsTotal, discardedFindingsTotal) backed by
 *     `GET /api/findings/runs/summary`.
 *   - Filter bar: state pill (all|pending|succeeded|failed) + free-text
 *     search over engagement name / jurisdiction. Search is FE-only;
 *     state is server-side via the `state` query param.
 *   - Run list: rows show engagement, state pill, started-at, duration,
 *     invalid-citation + discarded-finding counters. Each row's title
 *     and trailing chevron are real `<Link>`s to the
 *     SubmissionDetailModal Findings tab via the existing
 *     `?submission=…&tab=findings` deep link, so middle-click /
 *     open-in-new-tab work and the deep-link is exposed without
 *     needing the side panel. Clicking the row body selects it for
 *     the side detail panel.
 *   - Run detail panel (right side): full timestamps, duration, error,
 *     invalid-citation tokens (inline list), and a "Re-run" CTA that
 *     calls the same `useGenerateSubmissionFindings` hook the
 *     per-submission panel uses. 409 single-flight responses are
 *     surfaced inline ("A run is already in flight").
 *
 * Single-flight UX: Re-run is disabled whenever ANY visible run for
 * the selected submission is pending — not just while the local
 * mutation is in flight — so the reviewer cannot click into a 409.
 * After kickoff we poll `/findings/status` at the same 1.5s cadence
 * the per-submission panel uses, then invalidate the cross-submission
 * feed when the job settles so the row pill flips live.
 *
 * Live updates: while ANY pending run is visible in the feed (the
 * unfiltered list), the runs list and KPI summary are refetched on a
 * 1500ms cadence so reviewers can watch pending rows flip to their
 * terminal state without clicking Refresh. Polling automatically stops
 * once every visible run has settled, so an idle page makes no extra
 * network traffic. The detail panel reads the selected run from the
 * same list, so it tracks the terminal outcome on the next poll tick.
 *
 * Audience gate: route is wrapped in `RequireAudience` in `App.tsx`
 * so non-reviewers land on the shared `access-denied` screen instead
 * of seeing the page chrome with every action 403'ing. The matching
 * nav entry is hidden via `requiresAudience: "internal"` in
 * `NavGroups`.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight } from "lucide-react";
import { DashboardLayout } from "@workspace/portal-ui";
import {
  ApiError,
  useListFindingsRuns,
  useGetFindingsRunsSummary,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  getListFindingsRunsQueryKey,
  getGetFindingsRunsSummaryQueryKey,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  type FindingsRunsListItem,
  type FindingsRunsListResponse,
  type FindingsRunsSummaryMetric,
  type FindingsRunsSummaryResponse,
  type ListFindingsRunsState,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavGroups } from "../components/NavGroups";
import { KpiTile } from "../components/KpiTile";
import { relativeTime } from "../lib/relativeTime";

type StateFilter = "all" | "pending" | "succeeded" | "failed";

const FILTER_TABS: ReadonlyArray<{
  value: StateFilter;
  label: string;
  testId: string;
}> = [
  { value: "all", label: "All", testId: "compliance-filter-all" },
  { value: "pending", label: "Pending", testId: "compliance-filter-pending" },
  {
    value: "succeeded",
    label: "Succeeded",
    testId: "compliance-filter-succeeded",
  },
  { value: "failed", label: "Failed", testId: "compliance-filter-failed" },
];

const STATE_PILL_CLASS: Record<FindingsRunsListItem["state"], string> = {
  pending: "sc-pill sc-pill-cyan",
  succeeded: "sc-pill sc-pill-green",
  failed: "sc-pill sc-pill-red",
};

const STATE_PILL_LABEL: Record<FindingsRunsListItem["state"], string> = {
  pending: "pending",
  succeeded: "succeeded",
  failed: "failed",
};

function formatInteger(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
  const m = s / 60;
  return m < 10 ? `${m.toFixed(1)}m` : `${Math.round(m)}m`;
}

function kpiTileProps(
  metric: FindingsRunsSummaryMetric | undefined,
  format: (v: number) => string,
): { value: string; trend?: "up" | "down"; trendLabel?: string } {
  if (!metric || metric.value == null) return { value: "—" };
  const props: { value: string; trend?: "up" | "down"; trendLabel?: string } = {
    value: format(metric.value),
  };
  if (metric.trend && metric.trendLabel) {
    props.trend = metric.trend;
    props.trendLabel = metric.trendLabel;
  }
  return props;
}

function deepLinkForRun(run: FindingsRunsListItem): string {
  return `/engagements/${run.engagementId}?submission=${run.submissionId}&tab=findings`;
}

/** Map server `error` codes from POST /findings/generate to friendly copy.
 *  409 with `generation_in_flight` is the single-flight signal documented
 *  by the kickoff route. */
function describeRerunError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown } | null;
    const code =
      data && typeof data === "object" && typeof data.error === "string"
        ? data.error
        : null;
    if (err.status === 409) {
      return "A finding-engine run is already in flight for this submission.";
    }
    if (code === "findings_require_internal_audience") {
      return "Only reviewers can trigger finding-engine runs.";
    }
    if (code === "submission_not_found") {
      return "That submission no longer exists.";
    }
    if (code) return code;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Re-run failed.";
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: FindingsRunsListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const startedAt = new Date(run.startedAt);
  const deepLink = deepLinkForRun(run);
  // Row is a non-interactive container; selection happens on click,
  // and the deep-link affordances (title text + trailing chevron)
  // are real `<Link>`s so middle-click / open-in-new-tab work and
  // the row visibly exposes a deep link to the submission Findings
  // tab even before the side panel updates.
  return (
    <div
      data-testid={`compliance-run-row-${run.generationId}`}
      data-selected={selected ? "true" : "false"}
      onClick={onSelect}
      className="sc-card-row flex items-center gap-3 cursor-pointer"
      style={
        selected
          ? { borderLeft: "3px solid var(--info-text)" }
          : { borderLeft: "3px solid transparent" }
      }
    >
      <div className="flex flex-col min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <Link
            href={deepLink}
            className="sc-medium truncate no-underline"
            data-testid={`compliance-run-row-${run.generationId}-link`}
            onClick={(e) => e.stopPropagation()}
          >
            {run.engagementName}
          </Link>
          <span
            className={`${STATE_PILL_CLASS[run.state]} shrink-0`}
            data-testid={`compliance-run-row-${run.generationId}-state`}
          >
            {STATE_PILL_LABEL[run.state]}
          </span>
        </div>
        <div className="flex items-center gap-3 mt-1 min-w-0">
          <span className="sc-meta truncate">
            {run.jurisdiction ?? "no jurisdiction"} ·{" "}
            <span title={startedAt.toLocaleString()}>
              {relativeTime(run.startedAt)}
            </span>
            {run.durationMs != null
              ? ` · ${formatDuration(run.durationMs)}`
              : ""}
          </span>
        </div>
      </div>
      <div className="hidden md:flex flex-col items-end gap-1 shrink-0 sc-mono-sm text-[var(--text-secondary)] w-32 text-right">
        {run.invalidCitationCount != null && run.invalidCitationCount > 0 ? (
          <span
            data-testid={`compliance-run-row-${run.generationId}-invalid`}
            title="Invalid citation tokens stripped from this run"
          >
            {run.invalidCitationCount} invalid
          </span>
        ) : null}
        {run.discardedFindingCount != null &&
        run.discardedFindingCount > 0 ? (
          <span
            data-testid={`compliance-run-row-${run.generationId}-discarded`}
            title="Findings discarded after citation validation"
          >
            {run.discardedFindingCount} discarded
          </span>
        ) : null}
      </div>
      <Link
        href={deepLink}
        className="no-underline shrink-0"
        aria-label={`Open Findings tab for ${run.engagementName}`}
        data-testid={`compliance-run-row-${run.generationId}-chevron`}
        onClick={(e) => e.stopPropagation()}
      >
        <ChevronRight size={14} className="text-[var(--text-muted)]" />
      </Link>
    </div>
  );
}

function RunDetailPanel({
  run,
  onRerun,
  rerunPending,
  rerunError,
}: {
  run: FindingsRunsListItem;
  onRerun: () => void;
  rerunPending: boolean;
  rerunError: string | null;
}) {
  const startedAt = new Date(run.startedAt);
  const completedAt = run.completedAt ? new Date(run.completedAt) : null;
  return (
    <div
      className="sc-card flex flex-col gap-4 p-4"
      data-testid="compliance-run-detail"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col min-w-0">
          <span className="sc-label">RUN DETAIL</span>
          <span
            className="sc-medium mt-1 truncate"
            data-testid="compliance-run-detail-engagement"
          >
            {run.engagementName}
          </span>
          <span className="sc-meta truncate">
            {run.jurisdiction ?? "no jurisdiction"}
          </span>
        </div>
        <span
          className={STATE_PILL_CLASS[run.state]}
          data-testid="compliance-run-detail-state"
        >
          {STATE_PILL_LABEL[run.state]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sc-mono-sm">
        <dt className="sc-meta">Started</dt>
        <dd
          className="text-[var(--text-primary)]"
          data-testid="compliance-run-detail-started"
        >
          {startedAt.toLocaleString()}
        </dd>
        <dt className="sc-meta">Completed</dt>
        <dd
          className="text-[var(--text-primary)]"
          data-testid="compliance-run-detail-completed"
        >
          {completedAt ? completedAt.toLocaleString() : "—"}
        </dd>
        <dt className="sc-meta">Duration</dt>
        <dd
          className="text-[var(--text-primary)]"
          data-testid="compliance-run-detail-duration"
        >
          {run.durationMs != null ? formatDuration(run.durationMs) : "—"}
        </dd>
        <dt className="sc-meta">Discarded findings</dt>
        <dd
          className="text-[var(--text-primary)]"
          data-testid="compliance-run-detail-discarded"
        >
          {run.discardedFindingCount ?? 0}
        </dd>
        <dt className="sc-meta">Invalid citations</dt>
        <dd
          className="text-[var(--text-primary)]"
          data-testid="compliance-run-detail-invalid"
        >
          {run.invalidCitationCount ?? 0}
        </dd>
      </dl>

      {run.error ? (
        <div
          className="sc-meta"
          data-testid="compliance-run-detail-error"
          style={{
            padding: "8px 10px",
            background: "var(--danger-dim)",
            color: "var(--danger-text)",
            borderRadius: 6,
          }}
        >
          {run.error}
        </div>
      ) : null}

      {run.invalidCitations && run.invalidCitations.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="sc-label">INVALID CITATION TOKENS</span>
          <ul
            className="flex flex-col gap-1 sc-mono-sm"
            data-testid="compliance-run-detail-invalid-list"
          >
            {run.invalidCitations.map((token, idx) => (
              <li
                key={`${token}-${idx}`}
                className="truncate text-[var(--text-secondary)]"
                title={token}
              >
                {token}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={deepLinkForRun(run)}
          className="sc-btn-sm"
          data-testid="compliance-run-detail-open-submission"
        >
          Open submission findings
        </Link>
        <button
          type="button"
          className="sc-btn-primary"
          onClick={onRerun}
          disabled={rerunPending}
          data-testid="compliance-run-detail-rerun"
        >
          {rerunPending ? "Re-running…" : "Re-run engine"}
        </button>
      </div>

      {rerunError ? (
        <div
          role="alert"
          className="sc-meta"
          data-testid="compliance-run-detail-rerun-error"
          style={{ color: "var(--danger-text)" }}
        >
          {rerunError}
        </div>
      ) : null}
    </div>
  );
}

export default function ComplianceEngine() {
  const navGroups = useNavGroups();

  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [rerunSubmissionId, setRerunSubmissionId] = useState<string | null>(
    null,
  );

  // Server-side state filter; pass through as the typed enum so the
  // generated client builds the correct query param. `all` omits it.
  const stateParam: ListFindingsRunsState | undefined =
    stateFilter === "all"
      ? undefined
      : (stateFilter as ListFindingsRunsState);
  const listParams = stateParam ? { state: stateParam } : undefined;

  // Live updates: while any pending run is visible we poll both the
  // list and the summary on a 1.5s cadence (matching the per-submission
  // panel) so every pending row can flip to its terminal state — and
  // the KPI strip can catch up — without a manual refresh. The list's
  // refetchInterval reads the most recent response off the query cache
  // so the cycle is self-sustaining: a settled feed stops polling, a
  // new pending row (kicked off here or elsewhere) starts it again on
  // the next refetch triggered by mutation invalidation.
  const runsQuery = useListFindingsRuns(listParams, {
    query: {
      queryKey: getListFindingsRunsQueryKey(listParams),
      refetchInterval: (query: { state: { data?: FindingsRunsListResponse } }) => {
        const data = query.state.data;
        const hasPending = (data?.runs ?? []).some(
          (r: FindingsRunsListItem) => r.state === "pending",
        );
        return hasPending ? 1500 : false;
      },
    },
  });
  const runs = useMemo<FindingsRunsListItem[]>(() => {
    const data: FindingsRunsListResponse | undefined = runsQuery.data;
    return data?.runs ?? [];
  }, [runsQuery.data]);

  const hasPendingRuns = useMemo(
    () => runs.some((r) => r.state === "pending"),
    [runs],
  );

  const summaryQuery = useGetFindingsRunsSummary({
    query: {
      queryKey: getGetFindingsRunsSummaryQueryKey(),
      refetchInterval: hasPendingRuns ? 1500 : false,
    },
  });
  const summary: FindingsRunsSummaryResponse | undefined = summaryQuery.data;

  const trimmedQuery = searchQuery.trim().toLowerCase();
  const filteredRuns = useMemo(() => {
    if (!trimmedQuery) return runs;
    return runs.filter((r) => {
      const haystack = [r.engagementName, r.jurisdiction ?? "", r.error ?? ""]
        .join(" ")
        .toLowerCase();
      return haystack.includes(trimmedQuery);
    });
  }, [runs, trimmedQuery]);

  const selectedRun =
    filteredRuns.find((r) => r.generationId === selectedRunId) ??
    filteredRuns[0] ??
    null;

  // Pending-tracking — single-flight UX requires the re-run button to
  // be disabled whenever ANY visible run for that submission is still
  // pending, not just while the local mutation is in flight. Compute
  // the set of submissions with at least one pending run from the
  // unfiltered feed (filtering by state would mask pending rows for
  // other-submission filters).
  const pendingSubmissionIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of runs) {
      if (r.state === "pending") set.add(r.submissionId);
    }
    return set;
  }, [runs]);

  // Status polling — after a re-run kickoff (or whenever the selected
  // submission has a pending row) we poll `/findings/status` until it
  // reports a terminal state. The 1.5s cadence matches FindingsRunsPanel
  // so the row pill animates in lockstep with the per-submission view.
  const pollSubmissionId = selectedRun?.submissionId ?? "";
  const shouldPoll =
    pollSubmissionId.length > 0 &&
    (pendingSubmissionIds.has(pollSubmissionId) ||
      rerunSubmissionId === pollSubmissionId);
  const statusQuery = useGetSubmissionFindingsGenerationStatus(
    pollSubmissionId,
    {
      query: {
        queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(
          pollSubmissionId,
        ),
        enabled: shouldPoll,
        refetchInterval: shouldPoll ? 1500 : false,
      },
    },
  );
  const polledState = statusQuery.data?.state ?? null;
  const polledIsPending = polledState === "pending";

  // When polling settles to a terminal state (completed/failed/idle),
  // refresh the cross-submission feed so the row pill flips and counters
  // catch up without waiting for the next manual refresh.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (
      pollSubmissionId &&
      polledState &&
      polledState !== "pending" &&
      rerunSubmissionId === pollSubmissionId
    ) {
      setRerunSubmissionId(null);
      void queryClient.invalidateQueries({
        queryKey: ["/api/findings/runs"],
      });
      void queryClient.invalidateQueries({
        queryKey: getGetFindingsRunsSummaryQueryKey(),
      });
    }
  }, [polledState, pollSubmissionId, rerunSubmissionId, queryClient]);

  // Re-run hook — same single-flight endpoint per-submission panel
  // uses. We invalidate the cross-submission feeds on success so the
  // new pending row pops to the top of the list, then let the polling
  // effect above flip it to its terminal state.
  const generate = useGenerateSubmissionFindings({
    mutation: {
      onSuccess: () => {
        setRerunError(null);
        void queryClient.invalidateQueries({
          queryKey: ["/api/findings/runs"],
        });
        void queryClient.invalidateQueries({
          queryKey: getGetFindingsRunsSummaryQueryKey(),
        });
      },
      onError: (err) => {
        setRerunError(describeRerunError(err));
        setRerunSubmissionId(null);
      },
    },
  });

  const handleRerun = (run: FindingsRunsListItem) => {
    setRerunError(null);
    setRerunSubmissionId(run.submissionId);
    generate.mutate({ submissionId: run.submissionId, data: {} });
  };

  const selectedSubmissionPending =
    selectedRun != null &&
    (pendingSubmissionIds.has(selectedRun.submissionId) ||
      polledIsPending ||
      (generate.isPending && rerunSubmissionId === selectedRun.submissionId));

  return (
    <DashboardLayout
      title="Compliance Engine"
      navGroups={navGroups}
      brandLabel="SMARTCITY OS"
      brandProductName="Plan Review"
      search={{
        placeholder: "Filter runs by engagement or jurisdiction…",
        value: searchQuery,
        onChange: setSearchQuery,
      }}
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-[22px] font-bold font-['Oxygen'] text-[var(--text-primary)] m-0">
              Compliance Engine
            </h2>
            <div
              className="sc-body mt-1"
              data-testid="compliance-summary-line"
            >
              {filteredRuns.length} recent{" "}
              {filteredRuns.length === 1 ? "run" : "runs"}
              {trimmedQuery ? " (filtered)" : ""}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              className="sc-btn-ghost"
              onClick={() => {
                void runsQuery.refetch();
                void summaryQuery.refetch();
              }}
              disabled={runsQuery.isFetching}
              data-testid="compliance-refresh"
            >
              {runsQuery.isFetching ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div
              className="grid grid-cols-2 md:grid-cols-5 gap-3"
              data-testid="compliance-kpi-strip"
            >
              <KpiTile
                label="Total runs (30d)"
                {...kpiTileProps(summary?.totalRuns, formatInteger)}
              />
              <KpiTile
                label="Success rate"
                {...kpiTileProps(summary?.successRate, formatPercent)}
              />
              <KpiTile
                label="Avg duration"
                {...kpiTileProps(summary?.avgDurationMs, formatDuration)}
              />
              <KpiTile
                label="Invalid citations"
                {...kpiTileProps(
                  summary?.invalidCitationsTotal,
                  formatInteger,
                )}
              />
              <KpiTile
                label="Discarded findings"
                {...kpiTileProps(
                  summary?.discardedFindingsTotal,
                  formatInteger,
                )}
              />
            </div>

            <div
              role="tablist"
              aria-label="Filter finding-engine runs by state"
              className="flex items-center gap-2 flex-wrap"
              data-testid="compliance-filter"
            >
              {FILTER_TABS.map((tab) => {
                const selected = stateFilter === tab.value;
                return (
                  <button
                    key={tab.value}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setStateFilter(tab.value)}
                    data-testid={tab.testId}
                    className={selected ? "sc-btn-primary" : "sc-btn-sm"}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
              <div className="sc-card">
                <div className="sc-card-header sc-row-sb">
                  <span className="sc-label">RECENT RUNS</span>
                  <span className="sc-meta">{filteredRuns.length} items</span>
                </div>
                <div
                  className="flex flex-col"
                  data-testid="compliance-runs-list"
                >
                  {runsQuery.isLoading ? (
                    <div
                      className="p-8 text-center sc-body"
                      data-testid="compliance-runs-loading"
                    >
                      Loading runs…
                    </div>
                  ) : runsQuery.isError ? (
                    <div
                      className="p-8 text-center sc-body text-[var(--danger-text)]"
                      data-testid="compliance-runs-error"
                    >
                      Couldn't load runs. Try refreshing.
                    </div>
                  ) : filteredRuns.length === 0 ? (
                    <div
                      className="p-8 text-center sc-body"
                      data-testid="compliance-runs-empty"
                    >
                      No finding-engine runs match this view.
                    </div>
                  ) : (
                    filteredRuns.map((run) => (
                      <RunRow
                        key={run.generationId}
                        run={run}
                        selected={
                          selectedRun?.generationId === run.generationId
                        }
                        onSelect={() => setSelectedRunId(run.generationId)}
                      />
                    ))
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3">
                {selectedRun ? (
                  <RunDetailPanel
                    run={selectedRun}
                    onRerun={() => handleRerun(selectedRun)}
                    rerunPending={selectedSubmissionPending}
                    rerunError={
                      rerunSubmissionId === selectedRun.submissionId
                        ? rerunError
                        : null
                    }
                  />
                ) : (
                  <div
                    className="sc-card p-6 text-center sc-body"
                    data-testid="compliance-run-detail-empty"
                  >
                    Select a run to see details.
                  </div>
                )}
              </div>
            </div>
      </div>
    </DashboardLayout>
  );
}
