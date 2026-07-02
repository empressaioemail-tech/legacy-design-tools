/**
 * Compliance Run tile — wraps the CDX-3/4/5 review surface from ReviewPage.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  useListCodeJurisdictions,
} from "@workspace/api-client-react";
import { FindingCard } from "../../components/FindingCard";
import { JurisdictionBar } from "../../components/JurisdictionBar";
import { sortFindings } from "../../lib/findings";
import {
  describeOverrideError,
  useAcceptFinding,
  useOverrideFinding,
  useRejectFinding,
} from "../../lib/reviewApi";
import { useEngagement } from "@hauska/tile-shell";
import { useCode } from "@hauska/tile-shell";
import { TileStatusBanner } from "@hauska/tile-shell";
import {
  useAnnotationSelection,
  useDocumentViewerNavigation,
} from "@hauska/tile-shell";
import { TileErrorBoundary } from "@hauska/cortex-tiles";
import { runCompliancePass } from "../../lib/planReviewBff";
import {
  usePlanReviewEngagementSubmissions,
  usePlanReviewSubmissionFindings,
  usePlanReviewSubmissionFindingsStatus,
} from "../../lib/planReviewBffQueries";

const labelStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
};

const selectStyle: CSSProperties = {
  minWidth: 180,
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-input, var(--bg-elevated))",
  color: "var(--text-primary)",
  fontSize: 13,
};

function ComplianceRunTileInner() {
  const { engagementId, engagement } = useEngagement();
  const { setJurisdictionKey, setPrecedenceResult } = useCode();
  const { selectedFindingId } = useAnnotationSelection();
  const { requestPage, findingPages } = useDocumentViewerNavigation();
  const queryClient = useQueryClient();
  const [submissionId, setSubmissionId] = useState("");

  useEffect(() => {
    if (engagement?.jurisdiction) {
      setJurisdictionKey(engagement.jurisdiction);
    }
  }, [engagement?.jurisdiction, setJurisdictionKey]);

  const submissionsQuery = usePlanReviewEngagementSubmissions(engagementId ?? "", {
    query: {
      queryKey: getListEngagementSubmissionsQueryKey(engagementId ?? ""),
      enabled: Boolean(engagementId),
    },
  });
  const submissions = submissionsQuery.data ?? [];

  const jurisdictionsQuery = useListCodeJurisdictions();
  const jurisdictions = jurisdictionsQuery.data ?? [];

  const selectedSubmission =
    submissions.find((s) => s.id === submissionId) ?? null;

  const statusQuery = usePlanReviewSubmissionFindingsStatus(submissionId, {
    query: {
      queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
      enabled: submissionId !== "",
      refetchInterval: (query) =>
        query.state.data?.state === "pending" ? 2_000 : false,
    },
  });
  const status = statusQuery.data ?? null;
  const isGenerating = status?.state === "pending";

  const findingsQuery = usePlanReviewSubmissionFindings(submissionId, {
    query: {
      queryKey: getListSubmissionFindingsQueryKey(submissionId),
      enabled: submissionId !== "",
    },
  });
  const findings = sortFindings(findingsQuery.data?.findings ?? []);

  const lastStateRef = useRef<string | null>(null);
  useEffect(() => {
    const current = status?.state ?? null;
    if (
      lastStateRef.current === "pending" &&
      (current === "completed" || current === "failed")
    ) {
      void queryClient.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
    }
    lastStateRef.current = current;
  }, [status?.state, submissionId, queryClient]);

  const runMutation = useMutation({
    mutationFn: async () => {
      if (!engagementId || !submissionId) throw new Error("missing context");
      const bff = await runCompliancePass(engagementId, submissionId);
      if (bff.precedenceResult) {
        setPrecedenceResult(bff.precedenceResult);
      }
      return bff;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey:
          getGetSubmissionFindingsGenerationStatusQueryKey(submissionId),
      });
    },
  });

  const acceptMutation = useAcceptFinding(submissionId);
  const rejectMutation = useRejectFinding(submissionId);
  const overrideMutation = useOverrideFinding(submissionId);

  function findingBusy(findingId: string): boolean {
    return (
      (acceptMutation.isPending && acceptMutation.variables === findingId) ||
      (rejectMutation.isPending && rejectMutation.variables === findingId) ||
      (overrideMutation.isPending &&
        overrideMutation.variables?.findingId === findingId)
    );
  }

  if (!engagementId) {
    return (
      <div style={{ padding: 12 }}>
        <TileStatusBanner status="live" label="Compliance Run" />
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Select a case from Intake & Queue to run compliance.
        </p>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        overflow: "auto",
        height: "100%",
      }}
    >
      <TileStatusBanner status="live" label="Compliance Run" />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={labelStyle}>Submission</span>
          <select
            data-testid="submission-select"
            value={submissionId}
            onChange={(e) => setSubmissionId(e.target.value)}
            style={selectStyle}
          >
            <option value="">
              {submissionsQuery.isLoading ? "Loading…" : "Select submission"}
            </option>
            {submissions.map((s) => (
              <option key={s.id} value={s.id}>
                {new Date(s.submittedAt).toLocaleDateString()} · {s.status}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          data-testid="run-review-button"
          disabled={!submissionId || isGenerating || runMutation.isPending}
          onClick={() => runMutation.mutate()}
          style={{
            padding: "8px 14px",
            borderRadius: 6,
            border: "none",
            background: "var(--accent, var(--info-text))",
            color: "var(--accent-contrast, #fff)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
            opacity: !submissionId || isGenerating ? 0.5 : 1,
          }}
        >
          {isGenerating || runMutation.isPending ? "Running…" : "Run review"}
        </button>
      </div>

      <JurisdictionBar
        engagement={engagement}
        submission={selectedSubmission}
        jurisdictions={jurisdictions}
        corpusLoading={jurisdictionsQuery.isLoading}
      />

      {findings.length > 0 ? (
        <div data-testid="findings-list" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              highlighted={finding.id === selectedFindingId}
              onSelect={(id) => {
                const p = findingPages[id];
                if (typeof p === "number") {
                  requestPage(p, id);
                }
              }}
              onAccept={(id) => acceptMutation.mutate(id)}
              onReject={(id) => rejectMutation.mutate(id)}
              onOverride={(id, draft) =>
                overrideMutation.mutate({ findingId: id, draft })
              }
              busy={findingBusy(finding.id)}
              overrideError={
                overrideMutation.isError &&
                overrideMutation.variables?.findingId === finding.id
                  ? describeOverrideError(overrideMutation.error)
                  : null
              }
            />
          ))}
        </div>
      ) : (
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {submissionId
            ? isGenerating
              ? "Engine running…"
              : "No findings yet."
            : "Pick a submission."}
        </p>
      )}
    </div>
  );
}

/**
 * OPTION 3 (per Track C Phase 3 dispatch): this tile stays app-resident because
 * it depends on @workspace/api-client-react generated query-key helpers, the
 * app-only FindingCard / JurisdictionBar components, and the app-lib review
 * mutation hooks (useAcceptFinding/useOverrideFinding/useRejectFinding). Moving
 * it would force the entire review-page contract into the package interface.
 * It is still wrapped in the shared TileErrorBoundary from @hauska/cortex-tiles.
 */
export default function ComplianceRunTile() {
  return (
    <TileErrorBoundary label="Compliance Run">
      <ComplianceRunTileInner />
    </TileErrorBoundary>
  );
}
