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
