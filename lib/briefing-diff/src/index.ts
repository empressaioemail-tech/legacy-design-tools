/**
 * Public surface for `@workspace/briefing-diff`.
 *
 * Word-level diff helper used by both the design-tools and Plan
 * Review surfaces to annotate, per A–G briefing section, what the
 * current narrative *removed* and *added* relative to the snapshot
 * the briefing was holding before the most recent regeneration.
 *
 * Lifted out of `artifacts/design-tools/src/pages/EngagementDetail.tsx`
 * (Task #303 B.5) so the Plan Review reviewer view (Task #314) can
 * render the same diff without copy-pasting the LCS routine — the
 * two artifacts can't import each other, so the helper has to live
 * in a shared lib if both are to use it.
 */

export { diffWords, type WordDiffOp } from "./diffWords";
export { formatBriefingActor } from "./formatBriefingActor";
