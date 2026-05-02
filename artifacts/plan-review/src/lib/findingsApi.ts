/**
 * Findings — production-surface barrel.
 *
 * Single swap point between the plan-review reviewer UI and the
 * backend. Most hooks still re-export the in-memory mock from
 * `./findingsMock`; `useCreateSubmissionFinding` is wired to the
 * real generated Orval hook. On success it bridges the returned
 * row into the mock store (via `mockUpsertFinding`) so the
 * mock-backed list refetch renders the new finding without a
 * reload — the bridge will be removed when the list hook itself
 * is swapped to the generated GET.
 */

import {
  useMutation,
  useQueryClient,
  type UseMutationOptions,
} from "@tanstack/react-query";
import {
  ApiError,
  createSubmissionFinding as createSubmissionFindingApi,
  getCreateSubmissionFindingUrl,
  getListSubmissionFindingsQueryKey,
} from "@workspace/api-client-react";

import {
  listSubmissionFindingsKey,
  mockUpsertFinding,
  type CreateSubmissionFindingPayload,
  type Finding,
  type FindingCitation,
} from "./findingsMock";

export type {
  CreateSubmissionFindingPayload,
  Finding,
  FindingActor,
  FindingCategory,
  FindingCitation,
  FindingCodeCitation,
  FindingRun,
  FindingSeverity,
  FindingSourceCitation,
  FindingStatus,
  OverrideFindingPayload,
} from "./findingsMock";

export {
  useAcceptFinding,
  useGenerateSubmissionFindings,
  useGetSubmissionFindingsGenerationStatus,
  useListSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  useOverrideFinding,
  useRejectFinding,
  FindingAlreadyOverriddenError,
  useFindingsGenerationPolling,
  FINDING_CATEGORY_LABELS,
  FINDING_SEVERITY_LABELS,
  FINDING_STATUS_LABELS,
  SEVERITY_ORDER,
  compareFindings,
  listSubmissionFindingsKey,
  listSubmissionFindingsRunsKey,
  submissionFindingsStatusKey,
} from "./findingsMock";

interface FindingMutateContext {
  submissionId: string;
}

/**
 * Friendly labels for the structured `error` codes returned by
 * `POST /api/submissions/:id/findings`. Unknown codes fall through
 * to the raw code so the cause is never swallowed.
 */
const SERVER_ERROR_LABELS: Record<string, string> = {
  invalid_submission_id: "That submission id is not valid.",
  invalid_create_finding_body:
    "Some required fields are missing or invalid. Check the title, severity, and category.",
  submission_not_found: "This submission no longer exists.",
  missing_session_requestor:
    "Your session is missing reviewer attribution. Sign in again and retry.",
  findings_require_internal_audience:
    "Only reviewers can add findings to a submission.",
  "Failed to create finding":
    "The server could not save this finding. Try again in a moment.",
};

/** Map a thrown create-finding error to a user-facing string. */
export function describeCreateFindingError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data;
    if (data && typeof data === "object") {
      const code = (data as { error?: unknown }).error;
      if (typeof code === "string") {
        return SERVER_ERROR_LABELS[code] ?? code;
      }
    }
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return "Failed to add finding.";
}

/**
 * Manual-add hook. POSTs to the real backend, normalizes the wire
 * shape to the local `Finding`, and bridges the row into the mock
 * store so the existing list refetch shows it. Errors propagate
 * unchanged for `describeCreateFindingError`.
 */
export function useCreateSubmissionFinding(
  submissionId: string,
  options?: UseMutationOptions<
    Finding,
    unknown,
    CreateSubmissionFindingPayload,
    FindingMutateContext
  >,
) {
  const qc = useQueryClient();
  return useMutation<
    Finding,
    unknown,
    CreateSubmissionFindingPayload,
    FindingMutateContext
  >({
    mutationFn: async (payload) => {
      const title = payload.title.trim();
      if (!title) throw new Error("Title is required.");
      const description = payload.description?.trim() ?? "";
      const body = {
        title,
        description: description.length > 0 ? description : null,
        severity: payload.severity,
        category: payload.category,
        codeCitation: payload.codeCitation ?? null,
        sourceCitation: payload.sourceCitation ?? null,
        elementRef: payload.elementRef ?? null,
      };
      const result = await createSubmissionFindingApi(submissionId, body);
      return wireFindingToLocal(result.finding);
    },
    ...(options ?? {}),
    onSuccess: (data, ...rest) => {
      // Bridge while the list hook still reads from the mock
      // store: push the server row in so the next refetch (queued
      // by the invalidations below) renders the new finding.
      mockUpsertFinding(submissionId, data);
      qc.invalidateQueries({
        queryKey: listSubmissionFindingsKey(submissionId),
      });
      qc.invalidateQueries({
        queryKey: getListSubmissionFindingsQueryKey(submissionId),
      });
      qc.invalidateQueries({
        queryKey: [getCreateSubmissionFindingUrl(submissionId)],
      });
      return options?.onSuccess?.(data, ...rest);
    },
  });
}

/**
 * Normalize the generated wire `Finding` to the local mock-shaped
 * `Finding`. The two unions are field-for-field compatible but
 * sourced from different type aliases, so the citations array
 * needs an explicit narrow.
 */
function wireFindingToLocal(wire: {
  id: string;
  submissionId: string;
  severity: Finding["severity"];
  category: Finding["category"];
  status: Finding["status"];
  text: string;
  citations: ReadonlyArray<unknown>;
  confidence: number;
  lowConfidence: boolean;
  reviewerStatusBy: Finding["reviewerStatusBy"];
  reviewerStatusChangedAt: string | null;
  reviewerComment: string | null;
  elementRef: string | null;
  sourceRef: { id: string; label: string } | null;
  aiGeneratedAt: string;
  revisionOf: string | null;
}): Finding {
  const citations: FindingCitation[] = [];
  for (const c of wire.citations) {
    if (!c || typeof c !== "object") continue;
    const kind = (c as { kind?: unknown }).kind;
    if (kind === "code-section") {
      const atomId = (c as { atomId?: unknown }).atomId;
      if (typeof atomId === "string") {
        citations.push({ kind: "code-section", atomId });
      }
    } else if (kind === "briefing-source") {
      const id = (c as { id?: unknown }).id;
      const label = (c as { label?: unknown }).label;
      if (typeof id === "string" && typeof label === "string") {
        citations.push({ kind: "briefing-source", id, label });
      }
    }
  }
  return {
    id: wire.id,
    submissionId: wire.submissionId,
    severity: wire.severity,
    category: wire.category,
    status: wire.status,
    text: wire.text,
    citations,
    confidence: wire.confidence,
    lowConfidence: wire.lowConfidence,
    reviewerStatusBy: wire.reviewerStatusBy,
    reviewerStatusChangedAt: wire.reviewerStatusChangedAt,
    reviewerComment: wire.reviewerComment,
    elementRef: wire.elementRef,
    sourceRef: wire.sourceRef,
    aiGeneratedAt: wire.aiGeneratedAt,
    revisionOf: wire.revisionOf,
  };
}
