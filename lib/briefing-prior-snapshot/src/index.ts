/**
 * Public surface for `@workspace/briefing-prior-snapshot` (Task #355).
 *
 * Renders the "Narrative on screen before this run was overwritten"
 * disclosure header — title row, "Generated <when> by <actor>" meta
 * line, and "Copy plain text" button (with its 2 s "Copied!"
 * confirmation) — that both Plan Review and design-tools mount on
 * the prior row of their `BriefingRecentRunsPanel`.
 *
 * Lifted out of the two parallel JSX subtrees in
 *   `artifacts/plan-review/src/components/BriefingRecentRunsPanel.tsx`
 *   `artifacts/design-tools/src/pages/EngagementDetail.tsx`
 * because every recent task in this area (#332, #333, #337, #338,
 * #340, #344) carried a "mirrors the design-tools side byte-for-byte
 * so a future shared-lib lift is a no-op" comment, and Task #344 is
 * direct evidence that the drift class is real (a leftover Task #337
 * mirror block was both re-introducing the hardcoded "Briefing engine
 * (mock)" label and silently double-rendering the meta testid,
 * breaking 4 tests). Centralizing the JSX, testids, copy payload
 * shape, and the 2 s revert timer here removes the drift class
 * entirely instead of fixing each instance one helper at a time.
 */

export {
  BriefingPriorSnapshotHeader,
  SECTION_ORDER,
  pickSection,
  buildPriorSnapshotClipboardText,
  type BriefingSectionKey,
  type PriorNarrativeSnapshot,
  type FormatGeneratedAt,
  type FormattedTimestamp,
} from "./BriefingPriorSnapshotHeader";

export { BriefingPriorNarrativeDiff } from "./BriefingPriorNarrativeDiff";
