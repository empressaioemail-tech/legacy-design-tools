/**
 * Codex Reviewer QA — comment-letter draft mutation (CDX-9).
 *
 * `useDraftCommentLetter` drives the multi-step draft against the reused
 * Cortex L3 endpoints exposed by `@workspace/api-client-react`: it
 * creates the `deliverable-letter` atom with its composed sections, then
 * merges per-section finding provenance.
 *
 * The provenance merges run SEQUENTIALLY, not in parallel: the L3
 * `POST /deliverable-letters/{id}/sections/{i}/provenance` route does a
 * read-modify-write of the whole `sections` JSON column, so concurrent
 * merges to the same letter would race and clobber one another.
 *
 * No new backend — the create + provenance-merge routes are the L3
 * surface Lane C.4 shipped (PR #51).
 */
import { useMutation } from "@tanstack/react-query";
import {
  createDeliverableLetter,
  mergeDeliverableLetterProvenance,
} from "@workspace/api-client-react";
import type { CommentLetterDraft } from "./commentLetter";

/** Variables for the draft mutation. */
export interface DraftCommentLetterVariables {
  engagementId: string;
  draft: CommentLetterDraft;
}

/**
 * Create the comment letter and attach per-section finding provenance.
 * Resolves to the new letter's entityId so the caller can route to it.
 */
export function useDraftCommentLetter() {
  return useMutation<string, unknown, DraftCommentLetterVariables>({
    mutationFn: async ({ engagementId, draft }) => {
      const created = await createDeliverableLetter(engagementId, {
        title: draft.title,
        sections: draft.sections,
      });
      const letterId = created.deliverableLetter.entityId;

      // Sequential — see the file header note on the read-modify-write
      // race in the L3 provenance route.
      for (const plan of draft.provenancePlan) {
        if (plan.findingIds.length === 0) continue;
        await mergeDeliverableLetterProvenance(letterId, plan.sectionIndex, {
          findingIds: plan.findingIds,
        });
      }

      return letterId;
    },
  });
}
