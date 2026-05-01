export { DashboardLayout } from "./components/DashboardLayout";
export type { DashboardLayoutProps } from "./components/DashboardLayout";
export { Sidebar } from "./components/Sidebar";
export type {
  SidebarProps,
  SidebarGroup,
  SidebarItem,
} from "./components/Sidebar";
export { Header } from "./components/Header";
export type { HeaderProps, HeaderSearch } from "./components/Header";
export { SubmitToJurisdictionDialog } from "./components/SubmitToJurisdictionDialog";
export type { SubmitToJurisdictionDialogProps } from "./components/SubmitToJurisdictionDialog";
export { SubmissionRecordedBanner } from "./components/SubmissionRecordedBanner";
export type { SubmissionRecordedBannerProps } from "./components/SubmissionRecordedBanner";
export { ReviewerComment } from "./components/ReviewerComment";
export type { ReviewerCommentProps } from "./components/ReviewerComment";
export { ReviewerAnnotationAffordance } from "./components/ReviewerAnnotationAffordance";
export type { ReviewerAnnotationAffordanceProps } from "./components/ReviewerAnnotationAffordance";
export { ReviewerAnnotationPanel } from "./components/ReviewerAnnotationPanel";
export type { ReviewerAnnotationPanelProps } from "./components/ReviewerAnnotationPanel";

// Briefing divergences — shared by design-tools (architect surface)
// and plan-review (read-only reviewer surface). Promoted to portal-ui
// by Wave 2 Sprint B (Task #306) so the two surfaces stay in
// lock-step on copy / palette / grouping / acknowledgement deep-link.
export { BriefingDivergenceRow } from "./components/BriefingDivergenceRow";
export type { BriefingDivergenceRowProps } from "./components/BriefingDivergenceRow";
export { BriefingDivergenceGroup } from "./components/BriefingDivergenceGroup";
export type { BriefingDivergenceGroupProps } from "./components/BriefingDivergenceGroup";
export { BriefingDivergencesPanel } from "./components/BriefingDivergencesPanel";
export type { BriefingDivergencesPanelProps } from "./components/BriefingDivergencesPanel";
export { BriefingDivergenceDetailDialog } from "./components/BriefingDivergenceDetailDialog";
export type { BriefingDivergenceDetailDialogProps } from "./components/BriefingDivergenceDetailDialog";
export { ResolvedByChip } from "./components/ResolvedByChip";
export type { ResolvedByChipProps } from "./components/ResolvedByChip";

// Shared "Copy plain text" button used by the prior-narrative block on
// both Plan Review and design-tools (Task #350). Lifted out of the two
// surfaces so the discriminated copyResult state, ~2 s feedback timer,
// unmount cleanup, and `*-copy-confirm-*` / `*-copy-error-*` testids
// can't drift between the two copies.
export { CopyPlainTextButton } from "./components/CopyPlainTextButton";
export type { CopyPlainTextButtonProps } from "./components/CopyPlainTextButton";

export {
  BRIEFING_DIVERGENCE_REASON_COLORS,
  BRIEFING_DIVERGENCE_REASON_LABELS,
  MATERIALIZABLE_ELEMENT_KIND_LABELS,
  briefingDivergenceRowDomId,
  formatRelativeMaterializedAt,
  formatResolvedAcknowledgement,
  groupDivergencesByElement,
  resolverInitials,
  resolverLabel,
  type BriefingDivergenceGroupShape,
} from "./lib/briefing-divergences";

// Code-atom pill — shared by design-tools (BriefingCodeAtomPill,
// CodeAtomChip) and plan-review (Findings tab citations). Lifted in
// AIR-2 (Task #310) so the three call sites render identical pills
// against the shared `splitOnCodeAtomTokens` tokenizer.
export {
  CodeAtomPill,
  CODE_SECTION_TOKEN_RE,
  splitOnCodeAtomTokens,
} from "./components/CodeAtomPill";
export type {
  CodeAtomPillProps,
  RenderCodeAtomTokensOptions,
} from "./components/CodeAtomPill";

// Briefing context surface — Task #305 (Wave 2 Sprint A).
//
// These four components were previously inline in
// `artifacts/design-tools/src/components/` (or, for
// `BriefingRecentRunsPanel`, duplicated in plan-review). They are
// hoisted here so plan-review's reviewer surface can render the same
// read-only "Engagement Context" view that the architect sees in
// design-tools without either artifact importing the other.
export { SiteContextViewer } from "./components/SiteContextViewer";
export type { SiteContextViewerProps } from "./components/SiteContextViewer";
export {
  BriefingSourceCitationPill,
  BriefingCodeAtomPill,
  BriefingInvalidCitationPill,
  renderBriefingBody,
  scrollToBriefingSource,
} from "./components/briefingCitations";
export {
  BriefingSourceDetails,
  formatFederalSummaryMarkdown,
  formatSetbackSummaryMarkdown,
} from "./components/BriefingSourceDetails";
export { BriefingRecentRunsPanel } from "./components/BriefingRecentRunsPanel";

// Per-source briefing row + per-layer history disclosure + A–G
// narrative panel — extracted from
// `artifacts/design-tools/src/pages/EngagementDetail.tsx` (Task #316)
// so plan-review reviewers see the same per-source generation
// history, divergence pills, and prior-run comparison disclosure
// as architects. Each component takes a `readOnly` prop that hides
// the architect-only mutate affordances on the reviewer surface.
export { BriefingSourceRow } from "./components/BriefingSourceRow";
export type { BriefingSourceRowProps } from "./components/BriefingSourceRow";
export { BriefingSourceHistoryPanel } from "./components/BriefingSourceHistoryPanel";
export type { BriefingSourceHistoryPanelProps } from "./components/BriefingSourceHistoryPanel";
export { BriefingNarrativePanel } from "./components/BriefingNarrativePanel";
export type { BriefingNarrativePanelProps } from "./components/BriefingNarrativePanel";
export {
  BRIEFING_GENERATE_LAYERS_ACTOR_LABEL,
  BRIEFING_SOURCE_HISTORY_TIER_STORAGE_PREFIX,
  BRIEFING_SOURCE_HISTORY_TIER_LABEL,
  BRIEFING_SOURCE_STALE_THRESHOLD_DAYS,
  CONVERSION_STATUS_STYLE,
  SOURCE_KIND_BADGE_LABEL,
  briefingSourceHistoryTierStorageKey,
  computeBriefingSourceRange,
  diffBriefingSourceFields,
  extractAdapterKeyFromProvider,
  formatBriefingDiffValue,
  formatBriefingSourceRangeShort,
  formatBriefingSourceRangeTitle,
  formatByteSize,
  formatCacheAgeLabel,
  isAdapterSourceKind,
  isBriefingSourceRangeStale,
  useBriefingSourceHistoryTier,
} from "./lib/briefingSourceHelpers";

// Composite read-only briefing surface used by the plan-review
// submission detail modal's "Engagement Context" tab.
export { EngagementContextPanel } from "./components/EngagementContextPanel";
export type { EngagementContextPanelProps } from "./components/EngagementContextPanel";

export {
  initTheme,
  setTheme,
  getTheme,
  toggleTheme,
  type ThemeName,
} from "./lib/theme";

export {
  useSidebarState,
  type SidebarStateValue,
} from "./lib/sidebar-state";

export {
  FRIENDLY_AGENT_LABELS,
  friendlyAgentLabel,
  formatActorLabel,
  type ActorLike,
} from "./lib/actorLabel";
