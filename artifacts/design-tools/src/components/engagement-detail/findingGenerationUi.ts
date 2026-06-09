import type { EngagementSubmissionSummary } from "@workspace/api-client-react";

/** User-facing label for the latest AI plan-review run on a submission. */
export function formatFindingGenerationStatusLabel(
  state: EngagementSubmissionSummary["findingGenerationState"],
  error?: string | null,
): string {
  switch (state) {
    case "pending":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return error === "orphaned-timeout" ? "failed (timed out)" : "failed";
    default:
      return "idle";
  }
}

/** Option text for submission pickers — separates AI run from jurisdiction status. */
export function formatSubmissionPickerLabel(
  submission: EngagementSubmissionSummary,
): string {
  const aiState = formatFindingGenerationStatusLabel(
    submission.findingGenerationState,
    submission.findingGenerationError,
  );
  const openCount = submission.openFindingCount ?? 0;
  const openSuffix =
    submission.findingGenerationState === "completed" ||
    submission.findingGenerationState === "failed" ||
    openCount > 0
      ? ` · ${openCount} open`
      : "";
  return `${submission.submittedAt} · review ${aiState}${openSuffix}`;
}

/** Live status line for the Run plan review tab while a run is in flight. */
export function formatRunPlanReviewProgressLabel(
  state: string | null | undefined,
): string {
  switch (state) {
    case "pending":
      return "Running…";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return "Starting…";
  }
}
