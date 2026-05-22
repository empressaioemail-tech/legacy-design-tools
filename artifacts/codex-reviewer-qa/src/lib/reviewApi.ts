/**
 * Codex Reviewer QA — finding adjudication hooks (CDX-4).
 *
 * Thin react-query wrappers over the cortex-api adjudication routes —
 * `POST /findings/{id}/accept | reject | override` — exposed by the
 * generated `@workspace/api-client-react` client. Each mutation
 * invalidates the submission's findings list on success, so the card
 * re-renders with the server-stamped reviewer attribution + timestamp.
 *
 * The adjudication itself is recorded server-side (the cortex-api route
 * stamps `reviewerStatusBy` / `reviewerStatusChangedAt` and emits a
 * `finding.accepted|rejected|overridden` history event) — this module
 * only triggers it and re-pulls the result.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  acceptFinding,
  getListSubmissionFindingsQueryKey,
  overrideFinding,
  rejectFinding,
} from "@workspace/api-client-react";
import type { OverrideDraft } from "./findings";

function useFindingsInvalidator(submissionId: string): () => void {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({
      queryKey: getListSubmissionFindingsQueryKey(submissionId),
    });
  };
}

/** Accept a finding — `POST /findings/{id}/accept`. */
export function useAcceptFinding(submissionId: string) {
  const invalidate = useFindingsInvalidator(submissionId);
  return useMutation<unknown, unknown, string>({
    mutationFn: (findingId) => acceptFinding(findingId),
    onSuccess: invalidate,
  });
}

/** Reject a finding — `POST /findings/{id}/reject`. */
export function useRejectFinding(submissionId: string) {
  const invalidate = useFindingsInvalidator(submissionId);
  return useMutation<unknown, unknown, string>({
    mutationFn: (findingId) => rejectFinding(findingId),
    onSuccess: invalidate,
  });
}

/** Variables for the override mutation — id in the path, draft in the body. */
export interface OverrideVariables {
  findingId: string;
  draft: OverrideDraft;
}

/** Override (edit) a finding — `POST /findings/{id}/override`. */
export function useOverrideFinding(submissionId: string) {
  const invalidate = useFindingsInvalidator(submissionId);
  return useMutation<unknown, unknown, OverrideVariables>({
    mutationFn: ({ findingId, draft }) =>
      overrideFinding(findingId, {
        text: draft.text,
        severity: draft.severity,
        category: draft.category,
        reviewerComment: draft.reviewerComment,
      }),
    onSuccess: invalidate,
  });
}

/**
 * Human-readable message for an override failure. cortex-api returns
 * 409 `finding_already_overridden` when a finding has already been
 * overridden once — overrides are single-revision.
 */
export function describeOverrideError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.status === 409 &&
    error.data !== null &&
    typeof error.data === "object" &&
    (error.data as { error?: unknown }).error === "finding_already_overridden"
  ) {
    return "This finding has already been overridden once — it cannot be overridden again.";
  }
  return "Could not save the override. Try again.";
}
