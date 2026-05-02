/**
 * Hook fired by the submission-create route after a new submission row
 * is committed. Auto-kicks the AI plan-review run so reviewers no
 * longer have to press "Run AI plan review" manually.
 *
 * Strict fire-and-forget: never awaited, never throws, every failure
 * is logged with `{ submissionId, error }` and dropped — the
 * submission HTTP response is not affected and the architect is not
 * shown an AI failure (engine errors are recorded on the
 * `finding_runs` row's `state=failed`/`error` columns by
 * `runFindingGeneration`, which is the surface reviewers re-run from).
 */

import type { logger as Logger } from "./logger";
import { kickoffFindingGenerationForSubmission } from "../routes/findings";

export function autoTriggerFindingsOnSubmissionCreated(
  submissionId: string,
  reqLog: typeof Logger,
): void {
  void (async () => {
    try {
      await kickoffFindingGenerationForSubmission(submissionId, reqLog);
    } catch (error) {
      reqLog.error(
        { submissionId, error },
        "auto plan-review trigger failed",
      );
    }
  })();
}
