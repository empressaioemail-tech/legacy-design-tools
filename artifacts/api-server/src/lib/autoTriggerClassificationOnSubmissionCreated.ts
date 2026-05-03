/**
 * Hook fired by the submission-create route after a new submission row
 * is committed. Auto-runs the Track 1 classifier so reviewers see the
 * triage strip (project type / disciplines / code books) on the very
 * first inbox render.
 *
 * Strict fire-and-forget: never awaited, never throws, every failure
 * is logged with `{ submissionId, error }` and dropped — the
 * submission HTTP response is not affected. Mirrors AT-2 (the AI plan
 * review trigger in `autoTriggerFindingsOnSubmissionCreated`).
 *
 * The hook idempotently no-ops when a classification row already
 * exists for the submission, so a retry / dev double-call cannot
 * overwrite a reviewer correction that already landed.
 */

import type { logger as Logger } from "./logger";
import { classifySubmission, upsertAutoClassification } from "./classifySubmission";
import { getHistoryService } from "../atoms/registry";

export function autoTriggerClassificationOnSubmissionCreated(
  submissionId: string,
  reqLog: typeof Logger,
): void {
  void (async () => {
    try {
      const result = await classifySubmission(submissionId, reqLog);
      await upsertAutoClassification(
        submissionId,
        result,
        getHistoryService(),
        reqLog,
      );
    } catch (error) {
      reqLog.error(
        { submissionId, error },
        "auto submission-classifier trigger failed",
      );
    }
  })();
}
