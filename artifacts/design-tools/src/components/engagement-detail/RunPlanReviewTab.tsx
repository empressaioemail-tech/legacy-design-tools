import { FileUp, Layers } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  canRunPlanReview,
  isCoverageInformational,
} from "../../lib/coverageUi";
import { useEngagementsStore } from "../../store/engagements";
import {
  useCreateEngagementSubmission,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListAttachedDocuments,
  useListEngagementSubmissions,
  useGetSnapshotSheets,
  getGetSnapshotSheetsQueryKey,
  getListAttachedDocumentsQueryKey,
  getListEngagementSubmissionsQueryKey,
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListSubmissionFindingsQueryKey,
  ApiError,
} from "@workspace/api-client-react";
import { TabHeader } from "../cockpit/TabChrome";
import { formatRunPlanReviewProgressLabel } from "./findingGenerationUi";

export type PlanPickOption = {
  pieceId: string;
  kind: "attached-document" | "sheet";
  label: string;
  source: string;
};

function describeRunError(err: unknown): string {
  return err instanceof Error ? err.message : "Could not start plan review.";
}

function isGenerationAlreadyInFlight(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data as { error?: string } | null;
  return data?.error === "finding_generation_already_in_flight";
}

function isEngagementFindingRunInProgress(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const data = err.data as { error?: string; submissionId?: string } | null;
  return data?.error === "engagement_finding_run_in_progress";
}

export function RunPlanReviewTab({
  engagementId,
  engagementJurisdiction,
  engagementCoverageStatus,
  latestSnapshotId,
  onNavigateToTriage,
}: {
  engagementId: string;
  engagementJurisdiction?: string | null;
  engagementCoverageStatus?: string;
  latestSnapshotId?: string | null;
  onNavigateToTriage?: () => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selectedPieceIds, setSelectedPieceIds] = useState<string[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [activeSubmissionId, setActiveSubmissionId] = useState<string | null>(
    null,
  );

  const uploadAttachedDocument = useEngagementsStore(
    (s) => s.uploadAttachedDocument,
  );
  const uploading = useEngagementsStore(
    (s) => s.uploadingDocumentByEngagement[engagementId],
  );
  const uploadError = useEngagementsStore(
    (s) => s.documentUploadErrorByEngagement[engagementId],
  );

  const { data: attachedList, refetch: refetchAttached } =
    useListAttachedDocuments(engagementId, undefined, {
      query: {
        enabled: !!engagementId,
        queryKey: getListAttachedDocumentsQueryKey(engagementId),
      },
    });
  const { data: sheets = [] } = useGetSnapshotSheets(latestSnapshotId ?? "", {
    query: {
      enabled: !!latestSnapshotId,
      queryKey: getGetSnapshotSheetsQueryKey(latestSnapshotId ?? ""),
    },
  });

  const { data: engagementSubmissions, refetch: refetchSubmissions } =
    useListEngagementSubmissions(engagementId, {
      query: {
        enabled: !!engagementId,
        queryKey: getListEngagementSubmissionsQueryKey(engagementId),
        refetchInterval: (q) => {
          const subs = q.state.data;
          if (!subs?.some((s) => s.findingGenerationState === "pending")) {
            return false;
          }
          return 1500;
        },
      },
    });

  const inflightSubmission = useMemo(
    () =>
      engagementSubmissions?.find(
        (s) => s.findingGenerationState === "pending",
      ) ?? null,
    [engagementSubmissions],
  );

  useEffect(() => {
    if (inflightSubmission) {
      setActiveSubmissionId((prev) =>
        prev === inflightSubmission.id ? prev : inflightSubmission.id,
      );
    }
  }, [inflightSubmission]);

  const planOptions = useMemo<PlanPickOption[]>(() => {
    const docs =
      attachedList?.attachedDocuments?.map((d) => ({
        pieceId: d.entityId,
        kind: "attached-document" as const,
        label: d.title,
        source:
          d.documentType === "specification" ? "Client PDF" : "Client materials",
      })) ?? [];
    const sheetOpts = sheets.map((s) => ({
      pieceId: s.id,
      kind: "sheet" as const,
      label: `${s.sheetNumber} — ${s.sheetName}`,
      source: "Revit snapshot",
    }));
    return [...docs, ...sheetOpts];
  }, [attachedList, sheets]);

  useEffect(() => {
    if (planOptions.length === 0) {
      setSelectedPieceIds((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    setSelectedPieceIds((prev) => {
      const valid = prev.filter((id) =>
        planOptions.some((o) => o.pieceId === id),
      );
      if (valid.length > 0) {
        if (
          valid.length === prev.length &&
          valid.every((id, index) => id === prev[index])
        ) {
          return prev;
        }
        return valid;
      }
      const nextId = planOptions[0]!.pieceId;
      if (prev.length === 1 && prev[0] === nextId) return prev;
      return [nextId];
    });
  }, [planOptions]);

  const canRun = canRunPlanReview(engagementJurisdiction);
  const coverageInformational = isCoverageInformational(engagementCoverageStatus);
  const hasPlanSelection = selectedPieceIds.length > 0;
  const selectedPieceIdsRef = useRef(selectedPieceIds);
  selectedPieceIdsRef.current = selectedPieceIds;

  const generate = useGenerateSubmissionFindings({
    mutation: {
      onSuccess: (_data, vars) => {
        setRunError(null);
        queryClient.invalidateQueries({
          queryKey: getListSubmissionFindingsQueryKey(vars.submissionId),
        });
        queryClient.invalidateQueries({
          queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(
            vars.submissionId,
          ),
        });
        onNavigateToTriage?.();
      },
      onError: (err, vars) => {
        if (isGenerationAlreadyInFlight(err)) {
          setRunError(null);
          setActiveSubmissionId(vars.submissionId);
          queryClient.invalidateQueries({
            queryKey: getGetSubmissionFindingsGenerationStatusQueryKey(
              vars.submissionId,
            ),
          });
          onNavigateToTriage?.();
          return;
        }
        setRunError(describeRunError(err));
      },
    },
  });

  const createSubmission = useCreateEngagementSubmission({
    mutation: {
      onSuccess: async (receipt) => {
        setRunError(null);
        setActiveSubmissionId(receipt.submissionId);
        await queryClient.invalidateQueries({
          queryKey: getListEngagementSubmissionsQueryKey(engagementId),
        });
        generate.mutate({
          submissionId: receipt.submissionId,
          data: { planSetPieceIds: selectedPieceIdsRef.current },
        });
      },
      onError: (err) => {
        if (isEngagementFindingRunInProgress(err)) {
          setRunError(null);
          const data = err.data as { submissionId?: string } | null;
          if (data?.submissionId) {
            setActiveSubmissionId(data.submissionId);
          }
          void refetchSubmissions();
          return;
        }
        setRunError(describeRunError(err));
      },
    },
  });

  const statusQuery = useGetSubmissionFindingsGenerationStatus(
    activeSubmissionId ?? "",
    {
      query: {
        enabled: !!activeSubmissionId,
        queryKey: activeSubmissionId
          ? getGetSubmissionFindingsGenerationStatusQueryKey(activeSubmissionId)
          : (["findings-status", "none"] as const),
        refetchInterval: (q: { state: { data?: { state?: string } } }) =>
          q.state.data?.state === "pending" ? 1500 : false,
      },
    },
  );
  const runState = statusQuery.data?.state ?? null;
  const engagementReviewInFlight = !!inflightSubmission;
  const isRunning =
    engagementReviewInFlight ||
    runState === "pending" ||
    createSubmission.isPending ||
    generate.isPending;
  const progressLabel = formatRunPlanReviewProgressLabel(
    runState ?? (engagementReviewInFlight ? "pending" : null),
  );

  const togglePiece = (pieceId: string) => {
    setSelectedPieceIds((prev) =>
      prev.includes(pieceId)
        ? prev.filter((id) => id !== pieceId)
        : [...prev, pieceId],
    );
  };

  const handleRun = () => {
    if (!canRun || !hasPlanSelection || isRunning) return;
    setRunError(null);
    createSubmission.mutate({
      id: engagementId,
      data: {
        note: "Pre-submittal self-review (architect-initiated)",
        discipline: "building",
        deferAutoFindings: true,
      },
    });
  };

  const handleUpload = async (file: File) => {
    await uploadAttachedDocument(engagementId, file);
    await refetchAttached();
  };

  return (
    <div className="cockpit-tab" data-testid="run-plan-review-tab">
      <TabHeader
        overline="Review"
        title="Run plan review"
        subtitle="Pick or upload the plan set to review, then start a pre-submittal compliance pass."
      />
      <div className="sc-card p-6 flex flex-col gap-5">
        {!canRun ? (
          <p className="sc-prose opacity-80" data-testid="run-plan-review-no-jurisdiction">
            Add a project address (so jurisdiction resolves) before running a
            plan review.
          </p>
        ) : coverageInformational ? (
          <p
            className="sc-prose opacity-80"
            data-testid="run-plan-review-web-grounding-note"
          >
            This jurisdiction is not in the ingested code corpus yet — findings
            will be <strong>web-grounded</strong> from authoritative sources on
            demand. You can optionally <strong>Request coverage</strong> on the
            Site tab to warm the local corpus.
          </p>
        ) : null}

        <section className="flex flex-col gap-3">
          <span className="sc-label">PLAN SET</span>
          <p className="sc-meta opacity-70">
            Select attached PDFs (Client Materials) and/or Revit snapshot sheets
            to include in this review.
          </p>
          {planOptions.length > 0 ? (
            <ul
              className="flex flex-col gap-2"
              data-testid="run-plan-review-plan-list"
            >
              {planOptions.map((opt) => {
                const checked = selectedPieceIds.includes(opt.pieceId);
                return (
                  <li key={opt.pieceId}>
                    <label
                      className="flex items-start gap-2 sc-meta cursor-pointer"
                      data-testid={`run-plan-review-plan-${opt.pieceId}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePiece(opt.pieceId)}
                      />
                      <span>
                        <strong>{opt.label}</strong>
                        <span className="opacity-60"> · {opt.source}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p
              className="sc-meta opacity-60"
              data-testid="run-plan-review-plan-empty"
            >
              No plan PDFs or Revit sheets yet — upload a PDF below or send a
              snapshot from Revit.
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <span className="sc-label">UPLOAD PLAN PDF</span>
          <p className="sc-meta opacity-70">
            Upload goes through Client Materials and feeds PDF text/vision in the
            review — no Revit integration required.
          </p>
          <button
            type="button"
            className="sc-btn-ghost sc-btn-sm self-start"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            data-testid="run-plan-review-upload"
          >
            <FileUp size={14} /> {uploading ? "Uploading…" : "Upload plan PDF"}
          </button>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            accept=".pdf,application/pdf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleUpload(f);
              e.target.value = "";
            }}
          />
          {uploadError ? (
            <p className="sc-meta" style={{ color: "var(--danger-text)" }}>
              {uploadError}
            </p>
          ) : null}
        </section>

        {runError ? (
          <p className="text-sm" style={{ color: "var(--danger-text)" }}>
            {runError}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="sc-btn-primary"
            data-testid="run-plan-review-start"
            disabled={!canRun || !hasPlanSelection || isRunning}
            onClick={handleRun}
          >
            {isRunning ? "Review in progress…" : "Run plan review"}
          </button>
          {isRunning ? (
            <span
              className="sc-meta flex items-center gap-1"
              data-testid="run-plan-review-running-pill"
            >
              <Layers size={12} /> {progressLabel}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
