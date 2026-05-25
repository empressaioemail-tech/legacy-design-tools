export { DashboardLayout } from "./components/DashboardLayout";
export type { DashboardLayoutProps } from "./components/DashboardLayout";
export { StatusPill } from "./components/StatusPill";
export type { StatusPillProps } from "./components/StatusPill";
export { KpiTile } from "./components/KpiTile";
export type { KpiTileProps } from "./components/KpiTile";
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
// Task #431 — reviewer↔architect inline reply thread anchored to a
// submission. Audience-agnostic at the component layer; the parent
// surface decides which `authorRole` to tag posts with.
export { SubmissionCommentThread } from "./components/SubmissionCommentThread";
export type { SubmissionCommentThreadProps } from "./components/SubmissionCommentThread";
export { ReviewerAnnotationAffordance } from "./components/ReviewerAnnotationAffordance";
export type { ReviewerAnnotationAffordanceProps } from "./components/ReviewerAnnotationAffordance";
export { ReviewerAnnotationPanel } from "./components/ReviewerAnnotationPanel";
export type { ReviewerAnnotationPanelProps } from "./components/ReviewerAnnotationPanel";

// Wave 2 Sprint D / V1-2 — reviewer-side affordance for filing a
// "please refresh" request against a stale target atom. The dialog
// is the free-text reason capture; the affordance is the small
// inline button that opens it. Both are reviewer-only by deployment
// context (the parent gates render on `audience === "internal"`),
// kept audience-agnostic in portal-ui so the components stay
// reusable when a future audience model lands.
export { RequestRefreshDialog } from "./components/RequestRefreshDialog";
export type { RequestRefreshDialogProps } from "./components/RequestRefreshDialog";
export { RequestRefreshAffordance } from "./components/RequestRefreshAffordance";
export type { RequestRefreshAffordanceProps } from "./components/RequestRefreshAffordance";

// Task #429 — shared helper hook so the three reviewer-side
// Request-Refresh affordances bind to the same per-engagement
// reviewer-requests list query and disable themselves on a matching
// pending row. See `lib/reviewerRequestPending.ts`.
export { useReviewerRequestIsPending } from "./lib/reviewerRequestPending";

// Shared mnml.ai render surface. RenderCard + RenderGallery are
// audience-agnostic; RenderKickoffDialog is architect-only by
// deployment context (only the design-tools Renders tab mounts it).
export {
  RenderCard,
  isRenderInFlight,
  isRenderCancellable,
} from "./components/RenderCard";
export type { RenderCardProps } from "./components/RenderCard";
export { RenderGallery } from "./components/RenderGallery";
export type { RenderGalleryProps } from "./components/RenderGallery";
export { RenderKickoffDialog, RenderKickoffPanel } from "./components/RenderKickoffDialog";
export type {
  RenderKickoffDialogProps,
  RenderKickoffPanelProps,
  RenderKickoffVariant,
} from "./components/RenderKickoffDialog";
// doc 40c B.6 — credit-balance chip for the Renders tab. Reads
// `GET /api/renders/credits`; renders nothing when the renders preview
// is disabled (the gallery owns that message).
export { RenderCreditsBadge } from "./components/RenderCreditsBadge";
export { DragDropUpload } from "./components/DragDropUpload";
export type { DragDropUploadProps } from "./components/DragDropUpload";
export { MaskCanvas } from "./components/MaskCanvas";
export type { MaskCanvasProps } from "./components/MaskCanvas";
export { BeforeAfterSlider } from "./components/BeforeAfterSlider";
export type { BeforeAfterSliderProps } from "./components/BeforeAfterSlider";
export { MnmlExpertParamGrid } from "./components/MnmlExpertParamGrid";
export type { MnmlExpertParamGridProps } from "./components/MnmlExpertParamGrid";
export { ConstellationCanvas } from "./components/ConstellationCanvas";
export type { ConstellationCanvasProps } from "./components/ConstellationCanvas";
export { RenderPowerToolDialog } from "./components/render-tools/RenderPowerToolDialog";
export type { RenderPowerToolDialogProps } from "./components/render-tools/RenderPowerToolDialog";
export type { PowerToolKind } from "./components/render-tools/powerToolKickoff";

// Promoted from artifacts/plan-review so design-tools can mount the
// same read-only Three.js BIM viewer on its Snapshots tab without
// forking. Audience-agnostic; callers pass `selectedElementRef` for
// finding-citation drill-in.
export { BimModelViewport } from "./components/BimModelViewport";
export type { BimModelViewportProps } from "./components/BimModelViewport";
export { ViewCubeWidget } from "./components/ViewCubeWidget";
export type { ViewCubeWidgetProps, ViewCubeRegionId } from "./components/ViewCubeWidget";
export { BimViewCube } from "./components/BimViewCube";

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
export {
  CodeAtomDetailModal,
} from "./components/CodeAtomDetailModal";
export type { CodeAtomDetailModalProps } from "./components/CodeAtomDetailModal";

// Briefing context surface — Task #305 (Wave 2 Sprint A).
//
// These four components were previously inline in
// `artifacts/design-tools/src/components/` (or, for
// `BriefingRecentRunsPanel`, duplicated in plan-review). They are
// hoisted here so plan-review's reviewer surface can render the same
// read-only "Engagement Context" view that the architect sees in
// design-tools without either artifact importing the other.
export { SiteContextViewer } from "./components/SiteContextViewer";
export type { SiteContextViewerProps, BuildingOverlayState } from "./components/SiteContextViewer";
export {
  BriefingSourceCitationPill,
  BriefingCodeAtomPill,
  BriefingInvalidCitationPill,
  renderBriefingBody,
  renderBriefingMarkdown,
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
  evaluateRowFreshness,
  extractAdapterKeyFromProvider,
  formatBriefingDiffValue,
  formatBriefingSourceRangeShort,
  formatBriefingSourceRangeTitle,
  formatByteSize,
  formatCacheAgeLabel,
  isAdapterSourceKind,
  isBriefingSourceRangeStale,
  useBriefingSourceHistoryTier,
  type ProvenanceTier,
  type SnapshotFreshnessVerdict,
} from "./lib/briefingSourceHelpers";

// Composite read-only briefing surface used by the plan-review
// submission detail modal's "Engagement Context" tab.
export { EngagementContextPanel } from "./components/EngagementContextPanel";
export type { EngagementContextPanelProps } from "./components/EngagementContextPanel";

// Headline Parcel & Zoning summary card on the Site tab — Task #424.
// Replaces the long-standing "Coming soon" placeholder with the same
// parcel-id / zoning / overlays / provenance the briefing surfaces.
export { ParcelZoningCard } from "./components/ParcelZoningCard";
export type { ParcelZoningCardProps } from "./components/ParcelZoningCard";

// Reviewer-side low-confidence chip — extracted in Task #427 so the
// FindingsTab row in plan-review and any future architect-preview
// surface render the identical "Low conf" pill against the same
// `Model confidence NN%` tooltip copy.
export { LowConfidencePill } from "./components/LowConfidencePill";
export type { LowConfidencePillProps } from "./components/LowConfidencePill";

// Architect-side AIR-1 findings surfaces (Task #421 / V1-1 / V1-7).
export {
  FindingsList,
  compareFindings,
  countUnaddressedFindings,
  isFindingAddressed,
  isFindingReviewerPromoted,
  sortFindings,
} from "./components/FindingsList";
export type { FindingsListProps } from "./components/FindingsList";
export {
  FindingDetailPanel,
  ADDRESS_WITH_NEXT_REVISION_REVIEWER_COMMENT,
} from "./components/FindingDetailPanel";
export type { FindingDetailPanelProps } from "./components/FindingDetailPanel";

export {
  initTheme,
  setTheme,
  getTheme,
  toggleTheme,
  setChromeTheme,
  getChromeTheme,
  isDarkChromeTheme,
  useChromeTheme,
  useStyleProbeThemePreview,
  STYLE_PROBE_THEMES,
  type ThemeName,
  type ChromeThemeId,
  type StyleProbeThemeId,
} from "./lib/theme";
export { StyleProbeThemePicker } from "./components/StyleProbeThemePicker";
export { ChromeThemeToggle } from "./components/ChromeThemeToggle";

export {
  useSidebarState,
  LEFT_SIDEBAR_DEFAULT_WIDTH,
  LEFT_SIDEBAR_MIN_WIDTH,
  LEFT_SIDEBAR_MAX_WIDTH,
  RIGHT_SIDEBAR_DEFAULT_WIDTH,
  RIGHT_SIDEBAR_MIN_WIDTH,
  RIGHT_SIDEBAR_MAX_WIDTH,
  PROJECT_RAIL_DEFAULT_WIDTH,
  PROJECT_RAIL_MIN_WIDTH,
  PROJECT_RAIL_MAX_WIDTH,
  VIEWS_RAIL_DEFAULT_WIDTH,
  VIEWS_RAIL_MIN_WIDTH,
  VIEWS_RAIL_MAX_WIDTH,
  type SidebarStateValue,
} from "./lib/sidebar-state";

export {
  FRIENDLY_AGENT_LABELS,
  friendlyAgentLabel,
  formatActorLabel,
  type ActorLike,
} from "./lib/actorLabel";

// Track 1 — reviewer-discipline label / dept-token maps + the new
// `ReviewerDisciplineBadge` (sibling to the loose-string
// `DisciplineBadge` in plan-review). The `PlanReviewDiscipline`
// enum here is a SCAFFOLD until CT lands the regenerated zod
// schemas; commit 6 swaps to `import { PlanReviewDiscipline } from
// "@workspace/api-zod"`.
export {
  PLAN_REVIEW_DISCIPLINES,
  PLAN_REVIEW_DISCIPLINE_LABELS,
  PLAN_REVIEW_DISCIPLINE_DEPT_TOKEN,
  isPlanReviewDiscipline,
  type PlanReviewDiscipline,
} from "./lib/planReviewDiscipline";
export { ReviewerDisciplineBadge } from "./components/ReviewerDisciplineBadge";
export type { ReviewerDisciplineBadgeProps } from "./components/ReviewerDisciplineBadge";

// Track 1 — single canonical hook + chip-bar primitive used by the
// Inbox / FindingsTab / CannedFindings / OutstandingRequests
// surfaces.
export {
  useReviewerDisciplineFilter,
  type UseReviewerDisciplineFilter,
} from "./lib/useReviewerDisciplineFilter";
export { DisciplineFilterChipBar } from "./components/DisciplineFilterChipBar";
export type { DisciplineFilterChipBarProps } from "./components/DisciplineFilterChipBar";

// Track 1 — minimal Hovercard primitive (CSS-only positioning,
// hover + focus a11y, 200ms enter/exit). Used by the Inbox triage
// strip's applicant-history pill; reusable for Tracks 4/5/7.
export { Hovercard } from "./components/Hovercard";
export type { HovercardProps, HovercardPlacement } from "./components/Hovercard";

// Track 1 — AIBadge supersedes the older FindingAuthorTag. Same
// rendering convention reused on the FindingsTab row, the
// FindingDrillIn PROVENANCE block, and the comment-letter draft
// (aggregate variant for the document-level provenance line).
export { AIBadge } from "./components/AIBadge";
export type { AIBadgeProps, AIBadgeVariant } from "./components/AIBadge";

// Canva Connect — client materials deliverables (stub phase).
export { CanvaConnectionBanner } from "./components/CanvaConnectionBanner";
export { CanvaAssetPicker } from "./components/CanvaAssetPicker";
export { CanvaTemplateGrid } from "./components/CanvaTemplateGrid";
export { CanvaPushProgress } from "./components/CanvaPushProgress";
export {
  createMockCanvaIntegrationService,
  mockCanvaIntegrationService,
} from "./canva/mockCanvaIntegrationService";
export type {
  CanvaIntegrationService,
  CanvaConnectionStatus,
  CanvaSelectableAsset,
  CanvaBrandTemplate,
  CanvaTemplateSlot,
  CanvaPushJob,
  CanvaDesignPush,
  CanvaPushRequest,
} from "./canva/types";

// Floor plan → 3D visualization (stub phase).
export { FloorPlanSourcePicker } from "./components/FloorPlanSourcePicker";
export { FloorPlanFormatBadges } from "./components/FloorPlanFormatBadges";
export { FloorPlanVizControls } from "./components/FloorPlanVizControls";
export { FloorPlanVizProgress } from "./components/FloorPlanVizProgress";
export { FloorPlanBeforeAfterHero } from "./components/FloorPlanBeforeAfterHero";
export { FloorPlanVizHistory } from "./components/FloorPlanVizHistory";
export { FloorPlanVizWorkspace } from "./components/FloorPlanVizWorkspace";
export {
  createMockFloorPlanVizService,
  mockFloorPlanVizService,
  registerMockFloorPlanSource,
} from "./floor-plan-viz/mockFloorPlanVizService";
export { createApiFloorPlanVizService } from "./floor-plan-viz/apiFloorPlanVizService";
export {
  floorPlanSheetSourceId,
  floorPlanUploadSourceId,
} from "./floor-plan-viz/sourceIds";
export {
  FLOOR_PLAN_PRESET_META,
  type FloorPlanVizService,
  type FloorPlanVizSource,
  type FloorPlanVizJob,
  type FloorPlanVizPreset,
  type FloorPlanVizJobStatus,
} from "./floor-plan-viz/types";
