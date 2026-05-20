import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  FindingCategory,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListEngagementSubmissions,
  useListSubmissionFindings,
  useOverrideFinding,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  type EngagementSubmissionSummary,
  type Finding,
} from "@workspace/api-client-react";
import {
  ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT,
  FindingDetailPanel,
  FindingsList,
  countUnaddressedFindings,
} from "@workspace/portal-ui";
import {
  readFindingsCategoryFilterFromUrl,
  readFindingsSeverityFilterFromUrl,
  readFindingsShowAddressedFromUrl,
  writeFindingsCategoryFilterToUrl,
  writeFindingsSeverityFilterToUrl,
  writeFindingsShowAddressedToUrl,
  type FindingsCategoryFilter,
  type FindingsSeverityFilter,
} from "./urlState";

const FINDINGS_SEVERITY_CHIP_LABELS: Record<FindingsSeverityFilter, string> = {
  all: "All severities",
  blocker: "Blocker",
  concern: "Concern",
  advisory: "Advisory",
};

const FINDINGS_CATEGORY_CHIP_LABELS: Record<FindingCategory, string> = {
  setback: "Setback",
  height: "Height",
  coverage: "Coverage",
  egress: "Egress",
  use: "Use",
  "overlay-conflict": "Overlay conflict",
  "divergence-related": "Divergence",
  other: "Other",
};

/**
 * Filter chip strip rendered above the FindingsList (Task #436).
 *
 * Three independent groups: severity bucket (single-select with "All"),
 * finding category (single-select with "All"), and a Show addressed
 * toggle. Each chip carries a `data-active` attribute so the test
 * file can assert which one is currently selected without depending
 * on visual styling. The category list is derived from the generated
 * `FindingCategory` enum so adding a category in the API spec
 * automatically widens the chip row.
 */
function FindingsFilterChips({
  severityFilter,
  onSeverityChange,
  categoryFilter,
  onCategoryChange,
  showAddressed,
  onShowAddressedChange,
}: {
  severityFilter: FindingsSeverityFilter;
  onSeverityChange: (next: FindingsSeverityFilter) => void;
  categoryFilter: FindingsCategoryFilter;
  onCategoryChange: (next: FindingsCategoryFilter) => void;
  showAddressed: boolean;
  onShowAddressedChange: (next: boolean) => void;
}) {
  const severityOptions: FindingsSeverityFilter[] = [
    "all",
    "blocker",
    "concern",
    "advisory",
  ];
  const categoryOptions: FindingsCategoryFilter[] = [
    "all",
    ...(Object.keys(FindingCategory) as FindingCategory[]),
  ];
  const chipStyle = (active: boolean): React.CSSProperties => ({
    padding: "3px 10px",
    borderRadius: 999,
    border: active
      ? "1px solid var(--cyan)"
      : "1px solid var(--border-default)",
    background: active ? "var(--cyan-accent-bg)" : "transparent",
    color: active ? "var(--cyan)" : "var(--text-secondary)",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "inherit",
  });
  return (
    <div
      data-testid="findings-tab-filters"
      className="sc-card p-3"
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <div
        data-testid="findings-tab-filters-severity"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
      >
        <span className="sc-label" style={{ minWidth: 72 }}>
          SEVERITY
        </span>
        {severityOptions.map((opt) => {
          const active = severityFilter === opt;
          return (
            <button
              key={opt}
              type="button"
              data-testid={`findings-tab-filter-severity-${opt}`}
              data-active={active ? "true" : "false"}
              onClick={() => onSeverityChange(opt)}
              style={chipStyle(active)}
            >
              {FINDINGS_SEVERITY_CHIP_LABELS[opt]}
            </button>
          );
        })}
      </div>
      <div
        data-testid="findings-tab-filters-category"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
      >
        <span className="sc-label" style={{ minWidth: 72 }}>
          CATEGORY
        </span>
        {categoryOptions.map((opt) => {
          const active = categoryFilter === opt;
          return (
            <button
              key={opt}
              type="button"
              data-testid={`findings-tab-filter-category-${opt}`}
              data-active={active ? "true" : "false"}
              onClick={() => onCategoryChange(opt)}
              style={chipStyle(active)}
            >
              {opt === "all" ? "All categories" : FINDINGS_CATEGORY_CHIP_LABELS[opt]}
            </button>
          );
        })}
      </div>
      <div
        data-testid="findings-tab-filters-addressed"
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}
      >
        <span className="sc-label" style={{ minWidth: 72 }}>
          ADDRESSED
        </span>
        <button
          type="button"
          data-testid="findings-tab-filter-show-addressed"
          data-active={!showAddressed ? "true" : "false"}
          aria-pressed={!showAddressed}
          onClick={() => onShowAddressedChange(!showAddressed)}
          style={chipStyle(!showAddressed)}
        >
          {showAddressed ? "Show addressed" : "Hide addressed"}
        </button>
      </div>
    </div>
  );
}

/**
 * Map a thrown re-run error to a user-facing string. Mirrors the
 * reviewer-side helper in
 * `artifacts/plan-review/src/pages/ComplianceEngine.tsx` — we keep
 * the architect-side surface in the same idiom so the strings stay
 * close in tone even if they diverge in wording.
 */
function describeRerunError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return "A finding-engine run is already in flight for this submission.";
    }
    if (err.status === 403) {
      return "Findings require internal audience.";
    }
    if (err.status === 404) {
      return "Submission not found.";
    }
    return err.message ?? "Failed to start plan review run.";
  }
  return "Failed to start plan review run.";
}

/**
 * Architect-side "Findings" tab (Task #421 / V1-1 / V1-7).
 *
 * Owns the per-engagement submission picker, the per-submission
 * findings query, and the override mutation. The list + detail
 * card themselves live in `lib/portal-ui` so any future reviewer
 * audit surface can render the same chrome — this component is the
 * thin data-layer adapter that wires those views to the engagement
 * page.
 *
 * Selection rules:
 *   - Submission picker defaults to the engagement's most-recent
 *     submission (passed in by the parent so the badge fetch and
 *     this fetch share the same id without two reductions).
 *   - Selected finding clears whenever the submission switches —
 *     a finding from a different submission would render stale
 *     citations / CAD ref against the wrong drawings.
 *   - On submission switch we wait for the new findings list to
 *     resolve and then auto-select the first row in severity order
 *     so the detail panel is never blank when the architect first
 *     lands on a submission with at least one finding.
 *
 * The override mutation calls `useOverrideFinding` with the
 * existing row's text/severity/category preserved (the wire treats
 * an override as a same-content revision under a fresh reviewer
 * comment) and stamps {@link ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT}
 * so the reviewer-side timeline can render the "addressed in next
 * revision" affordance. On success we invalidate
 * `getListSubmissionFindingsQueryKey` for the active submission so
 * the row's status flips to `overridden` (which dims it via
 * {@link FindingsList}'s addressed branch) without a manual reload.
 */
export function FindingsTab({
  engagementId,
  initialSubmissionId,
  onElementRefClick,
}: {
  engagementId: string;
  initialSubmissionId: string | null;
  /**
   * Invoked when the architect clicks the CAD `elementRef` chip on a
   * finding. The page wires this to swing the tab strip over to the
   * Site Context (3D BIM) tab and pre-select the element so the
   * "tap citation, see the wall" loop closes without manual tab juggling.
   */
  onElementRefClick?: (elementRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const codeLibraryBase = `${import.meta.env.BASE_URL}code-library`;

  const {
    data: submissions,
    isLoading: submissionsLoading,
    error: submissionsError,
  } = useListEngagementSubmissions(engagementId, {
    query: {
      enabled: !!engagementId,
      queryKey: getListEngagementSubmissionsQueryKey(engagementId),
    },
  });

  const sortedSubmissions = useMemo<EngagementSubmissionSummary[]>(() => {
    if (!submissions) return [];
    return [...submissions].sort(
      (a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt),
    );
  }, [submissions]);

  const [selectedSubmissionId, setSelectedSubmissionId] = useState<
    string | null
  >(initialSubmissionId);
  // Once submissions resolve, fall back to the freshest one so the
  // picker always has a valid selection — we do NOT overwrite an
  // explicit user pick once they touch the dropdown.
  useEffect(() => {
    if (selectedSubmissionId !== null) return;
    if (sortedSubmissions.length === 0) return;
    setSelectedSubmissionId(sortedSubmissions[0].id);
  }, [selectedSubmissionId, sortedSubmissions]);

  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  // Drop the active selection whenever the submission changes —
  // citations and CAD refs would render against the wrong drawings.
  useEffect(() => {
    setSelectedFindingId(null);
  }, [selectedSubmissionId]);

  // Filter chips state (Task #436). Mirrored to the URL via the
  // helpers above so a deep-link survives a refresh, matching the
  // ?tab= and backfill-filter conventions.
  const [severityFilter, setSeverityFilterState] =
    useState<FindingsSeverityFilter>(() => readFindingsSeverityFilterFromUrl());
  const setSeverityFilter = (next: FindingsSeverityFilter): void => {
    setSeverityFilterState(next);
    writeFindingsSeverityFilterToUrl(next);
  };
  const [categoryFilter, setCategoryFilterState] =
    useState<FindingsCategoryFilter>(() => readFindingsCategoryFilterFromUrl());
  const setCategoryFilter = (next: FindingsCategoryFilter): void => {
    setCategoryFilterState(next);
    writeFindingsCategoryFilterToUrl(next);
  };
  const [showAddressed, setShowAddressedState] = useState<boolean>(() =>
    readFindingsShowAddressedFromUrl(),
  );
  const setShowAddressed = (next: boolean): void => {
    setShowAddressedState(next);
    writeFindingsShowAddressedToUrl(next);
  };

  const findingsQueryKey = selectedSubmissionId
    ? getListSubmissionFindingsQueryKey(selectedSubmissionId)
    : (["findings", "none"] as const);
  const {
    data: findingsData,
    isLoading: findingsLoading,
    error: findingsError,
  } = useListSubmissionFindings(selectedSubmissionId ?? "", {
    query: {
      enabled: !!selectedSubmissionId,
      queryKey: findingsQueryKey,
    },
  });
  const findings = findingsData?.findings ?? [];

  // PL-02 — manual plan-review trigger. Status query polls
  // `/findings/status` at 1.5s while a run is pending, idle otherwise,
  // matching the reviewer-side ComplianceEngine cadence. The mutation
  // hits POST `/findings/generate`; on success we invalidate the
  // findings list + status so the list pops in the moment the engine
  // settles. Error copy is mapped through `describeRerunError`.
  const statusQuery = useGetSubmissionFindingsGenerationStatus(
    selectedSubmissionId ?? "",
    {
      query: {
        enabled: !!selectedSubmissionId,
        queryKey: selectedSubmissionId
          ? getGetSubmissionFindingsGenerationStatusQueryKey(
              selectedSubmissionId,
            )
          : (["findings-status", "none"] as const),
        refetchInterval: (q: { state: { data?: { state?: string } } }) =>
          q.state.data?.state === "pending" ? 1500 : false,
      },
    },
  );
  const [rerunError, setRerunError] = useState<string | null>(null);
  const generate = useGenerateSubmissionFindings({
    mutation: {
      onSuccess: () => {
        if (!selectedSubmissionId) return;
        queryClient.invalidateQueries({
          queryKey: getListSubmissionFindingsQueryKey(selectedSubmissionId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(
            selectedSubmissionId,
          ),
        });
        setRerunError(null);
      },
      onError: (err) => {
        setRerunError(describeRerunError(err));
      },
    },
  });
  const runState = statusQuery.data?.state ?? null;
  const isRunning = runState === "pending" || generate.isPending;
  const handleRerun = () => {
    if (!selectedSubmissionId || isRunning) return;
    if (runState === "completed" || runState === "failed") {
      const ok =
        typeof window === "undefined"
          ? true
          : window.confirm(
              "Re-run AI plan review? Prior runs are preserved.",
            );
      if (!ok) return;
    }
    setRerunError(null);
    generate.mutate({ submissionId: selectedSubmissionId, data: {} });
  };

  // Apply the active filter chips (Task #436) before handing the list
  // to FindingsList. The "X unaddressed of Y" counter above keeps
  // reading from the unfiltered list so the architect always sees
  // the submission's true size, even when the filters are narrow.
  const filteredFindings = useMemo<Finding[]>(() => {
    return findings.filter((f) => {
      if (severityFilter !== "all" && f.severity !== severityFilter) {
        return false;
      }
      if (categoryFilter !== "all" && f.category !== categoryFilter) {
        return false;
      }
      if (!showAddressed && f.status === "overridden") return false;
      return true;
    });
  }, [findings, severityFilter, categoryFilter, showAddressed]);

  // Auto-select the highest-severity row in the filtered list when it
  // resolves so the right pane is never blank if there is anything to
  // triage. Re-runs when the filter set changes — if the active row
  // gets filtered out we fall through to the next visible blocker.
  useEffect(() => {
    if (selectedFindingId !== null) {
      const stillVisible = filteredFindings.some(
        (f) => f.id === selectedFindingId,
      );
      if (stillVisible) return;
    }
    if (filteredFindings.length === 0) {
      if (selectedFindingId !== null) setSelectedFindingId(null);
      return;
    }
    const sorted = [...filteredFindings].sort((a, b) => {
      const order = { blocker: 0, concern: 1, advisory: 2 } as const;
      const delta = order[a.severity] - order[b.severity];
      if (delta !== 0) return delta;
      return Date.parse(a.aiGeneratedAt) - Date.parse(b.aiGeneratedAt);
    });
    setSelectedFindingId(sorted[0].id);
  }, [filteredFindings, selectedFindingId]);

  const selectedFinding =
    filteredFindings.find((f) => f.id === selectedFindingId) ?? null;

  const overrideMutation = useOverrideFinding();
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const handleAddressWithRevision = (finding: Finding) => {
    setOverrideError(null);
    overrideMutation.mutate(
      {
        findingId: finding.id,
        data: {
          text: finding.text,
          severity: finding.severity,
          category: finding.category,
          reviewerComment: ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT,
        },
      },
      {
        onSuccess: () => {
          if (selectedSubmissionId) {
            queryClient.invalidateQueries({
              queryKey: getListSubmissionFindingsQueryKey(
                selectedSubmissionId,
              ),
            });
          }
        },
        onError: (err: unknown) => {
          if (err instanceof ApiError) {
            setOverrideError(err.message);
          } else if (err instanceof Error) {
            setOverrideError(err.message);
          } else {
            setOverrideError("Could not address finding. Try again.");
          }
        },
      },
    );
  };

  if (submissionsLoading) {
    return (
      <div className="sc-prose opacity-60" data-testid="findings-tab-loading">
        Loading submissions…
      </div>
    );
  }
  if (submissionsError) {
    return (
      <div
        className="alert-block warning"
        data-testid="findings-tab-error"
      >
        Could not load submissions for this engagement.
      </div>
    );
  }
  if (sortedSubmissions.length === 0) {
    return (
      <div
        className="sc-card p-6"
        data-testid="findings-tab-empty-no-submissions"
      >
        <div className="sc-prose opacity-70">
          No submissions yet. Click <strong>Submit to jurisdiction</strong>{" "}
          above to record a submission — the AI plan review runs
          automatically as soon as you do.
        </div>
      </div>
    );
  }

  const rerunCtaLabel = isRunning
    ? "Running…"
    : runState
      ? "Re-run plan review"
      : "Run plan review";

  return (
    <div className="flex flex-col gap-3" data-testid="findings-tab">
      <div className="sc-row-sb" style={{ gap: 12 }}>
        <label
          className="sc-label"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          SUBMISSION
          <select
            data-testid="findings-tab-submission-picker"
            className="sc-select"
            value={selectedSubmissionId ?? ""}
            onChange={(e) => setSelectedSubmissionId(e.target.value || null)}
            style={{ minWidth: 240 }}
          >
            {sortedSubmissions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.submittedAt}
                {s.status ? ` · ${s.status}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginLeft: "auto",
          }}
        >
          <span
            className="sc-meta"
            data-testid="findings-tab-unaddressed-count"
            style={{ opacity: 0.7, fontSize: 11 }}
          >
            {findings.length === 0
              ? "0 findings"
              : `${countUnaddressedFindings(findings)} unaddressed of ${findings.length}`}
          </span>
          {isRunning && (
            <span
              data-testid="findings-tab-rerun-running-pill"
              style={{
                background: "var(--info-dim)",
                color: "var(--info-text)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                padding: "2px 8px",
                borderRadius: 999,
              }}
            >
              Running
            </span>
          )}
          <button
            type="button"
            className="sc-btn-primary"
            onClick={handleRerun}
            disabled={isRunning || !selectedSubmissionId}
            data-testid="findings-tab-rerun"
          >
            {rerunCtaLabel}
          </button>
        </div>
      </div>

      {rerunError && (
        <div
          role="alert"
          data-testid="findings-tab-rerun-error"
          className="sc-alert sc-alert-error"
        >
          {rerunError}
        </div>
      )}

      {runState === "failed" && !isRunning && (
        <div
          role="alert"
          data-testid="findings-tab-auto-failure-badge"
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "10px 12px",
            border: "1px solid var(--danger-border, var(--danger-text))",
            background: "var(--danger-dim)",
            borderRadius: 6,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--danger-text)",
              }}
            >
              AI plan review failed
            </div>
            <div
              data-testid="findings-tab-auto-failure-detail"
              style={{
                fontSize: 12,
                color: "var(--danger-text)",
                marginTop: 2,
                wordBreak: "break-word",
              }}
            >
              {statusQuery.data?.error
                ? `The most recent attempt failed: ${statusQuery.data.error}`
                : "The most recent automatic attempt failed. Re-run to try again."}
            </div>
          </div>
        </div>
      )}

      <FindingsFilterChips
        severityFilter={severityFilter}
        onSeverityChange={setSeverityFilter}
        categoryFilter={categoryFilter}
        onCategoryChange={setCategoryFilter}
        showAddressed={showAddressed}
        onShowAddressedChange={setShowAddressed}
      />

      <div
        className="grid"
        style={{
          gridTemplateColumns: "minmax(280px, 360px) 1fr",
          gap: 12,
          minHeight: 420,
        }}
      >
        <div
          className="sc-card"
          style={{ overflow: "auto", maxHeight: 600 }}
        >
          {findingsLoading ? (
            <div
              className="sc-prose opacity-60 p-4"
              data-testid="findings-tab-list-loading"
            >
              Loading findings…
            </div>
          ) : findingsError ? (
            <div
              className="alert-block warning m-3"
              data-testid="findings-tab-list-error"
            >
              Could not load findings for this submission.
            </div>
          ) : findings.length === 0 ? (
            <div
              className="sc-prose opacity-60 p-4"
              data-testid="findings-tab-list-empty"
            >
              No findings on this submission.
            </div>
          ) : filteredFindings.length === 0 ? (
            <div
              className="sc-prose opacity-60 p-4"
              data-testid="findings-tab-list-filtered-empty"
            >
              No findings match the active filters.
            </div>
          ) : (
            <FindingsList
              findings={filteredFindings}
              selectedFindingId={selectedFindingId}
              onSelect={setSelectedFindingId}
            />
          )}
        </div>

        <FindingDetailPanel
          finding={selectedFinding}
          codeLibraryBase={codeLibraryBase}
          onAddressWithRevision={handleAddressWithRevision}
          isAddressing={overrideMutation.isPending}
          addressError={overrideError}
          onRetry={handleAddressWithRevision}
          onClose={() => setSelectedFindingId(null)}
          onElementRefClick={onElementRefClick}
        />
      </div>
    </div>
  );
}
