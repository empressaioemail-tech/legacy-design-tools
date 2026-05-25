import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEngagement,
  useGetEngagementBimModel,
  useGetSnapshot,
  useListEngagementSubmissions,
  useListSubmissionFindings,
  useUpdateEngagement,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListEngagementsQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  getListResponseTasksQueryKey,
  getGetBriefingSourceGlbUrl,
  getGetMaterializableElementGlbUrl,
  type EngagementSubmissionSummary,
  type SheetSummary,
  type SubmissionReceipt,
} from "@workspace/api-client-react";
import { AppShell } from "../components/AppShell";
import { EngagementViewHeader } from "../components/engagement-detail/EngagementViewHeader";
import { EngagementDetailsModal } from "../components/EngagementDetailsModal";
import { SheetGrid } from "../components/SheetGrid";
import { SubmissionDetailModal } from "../components/SubmissionDetailModal";
import {
  ReviewerRequestsStrip,
  ReviewerRequestsHistory,
} from "../components/ReviewerRequestsStrip";
import {
  BimModelViewport,
  StatusPill,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
  countUnaddressedFindings,
  useSidebarState,
  type BimStudioCapture,
} from "@workspace/portal-ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useEngagementsStore, type SpecDraftEntry } from "../store/engagements";
import type { BackfillFilter } from "../lib/submissionBackfill";
import { SiteTab } from "../components/engagement-detail/SiteTab";
import { PropertyIntelTab } from "../components/engagement-detail/PropertyIntelTab";
import { SnapshotsTab } from "../components/engagement-detail/SnapshotsTab";
import { SettingsTab } from "../components/engagement-detail/SettingsTab";
import { SubmissionsTab } from "../components/engagement-detail/SubmissionsTab";
import { DesignToolsTab } from "../components/engagement-detail/DesignToolsTab";
import {
  floorPlanSourceIdForSheet,
  writeFloorPlanVizDeepLink,
  writeRenderModeToUrl,
} from "../components/engagement-detail/renderModeUrl";
import { TabHeader } from "../components/cockpit/TabChrome";
import { ClientMaterialsTab } from "../components/engagement-detail/ClientMaterialsTab";
import { PackagesTab } from "../components/engagement-detail/packages/PackagesTab";
import { packageTemplateForTab } from "../components/engagement-detail/engagementViews";
import { FindingsTab } from "../components/engagement-detail/FindingsTab";
import { ResponseTasksTab } from "../components/engagement-detail/ResponseTasksTab";
import { DeliverableLettersTab } from "../components/engagement-detail/DeliverableLettersTab";
import { DetailCalloutSpecsTab } from "../components/engagement-detail/DetailCalloutSpecsTab";
import { ProductSpecReferencesTab } from "../components/engagement-detail/ProductSpecReferencesTab";
import {
  readBackfillFilterFromUrl,
  readTabFromUrl,
  writeBackfillFilterToUrl,
  writeTabToUrl,
  type TabId,
} from "../components/engagement-detail/urlState";

/**
 * Wraps an engagement-detail tab's content with the ARIA tabpanel
 * semantics that pair with the WAI-ARIA tabs pattern on `TabBar`
 * above. Each panel gets a stable `id` (referenced by the tab
 * trigger's `aria-controls`) and an `aria-labelledby` pointing back
 * at the trigger. Inactive panels are hidden rather than unmounted
 * via `hidden`, while their children are gated on `isActive` so
 * sub-components don't keep running queries / state for unseen tabs.
 */
function TabPanel({
  id,
  active,
  children,
  className,
}: {
  id: TabId;
  active: TabId;
  children: React.ReactNode;
  className?: string;
}) {
  const isActive = id === active;
  return (
    <div
      role="tabpanel"
      id={`engagement-tabpanel-${id}`}
      aria-labelledby={`engagement-tab-trigger-${id}`}
      hidden={!isActive}
      tabIndex={0}
      className={className}
    >
      {isActive ? children : null}
    </div>
  );
}

export function EngagementDetail() {
  const params = useParams();
  const id = params.id as string;
  // Raw snapshot JSON is collapsed by default — it is a developer /
  // debug view, not the Snapshots tab's primary content (QA-12 / WSB.3).
  const [jsonExpanded, setJsonExpanded] = useState(false);
  // Initialize tab from `?tab=…` so deep links land on the right tab
  // without a flicker. Sync on every change via `setTabAndSyncUrl`
  // (defined below) — we deliberately do NOT subscribe to `popstate`,
  // matching DevAtoms.tsx's exploratory-page convention. If a future
  // sprint needs back-button-aware tabs, it can wrap this state in a
  // `useSyncExternalStore` against `popstate`.
  const [tab, setTabState] = useState<TabId>(() => readTabFromUrl());
  const [renderDeepLinkToken, setRenderDeepLinkToken] = useState(0);
  const [studioCapture, setStudioCapture] = useState<BimStudioCapture | null>(
    null,
  );
  const setTab = useCallback((next: TabId): void => {
    setTabState(next);
    writeTabToUrl(next);
  }, []);
  // Backfill filter (Task #124) for the engagement timeline of past
  // submissions. Lifted to the page so the URL param survives tab
  // switches and so the same setter pattern as `tab` keeps the URL
  // and React state in lock-step on every change.
  const [backfillFilter, setBackfillFilterState] = useState<BackfillFilter>(
    () => readBackfillFilterFromUrl(),
  );
  const setBackfillFilter = (next: BackfillFilter): void => {
    setBackfillFilterState(next);
    writeBackfillFilterToUrl(next);
  };
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"intake" | "edit">("edit");
  const [submitOpen, setSubmitOpen] = useState(false);
  // Last successful jurisdiction submission, surfaced as a non-blocking
  // confirmation banner above the engagement header. We keep the full
  // receipt (not just `submittedAt`) so a future "View on timeline"
  // affordance can deep-link by `submissionId` without another round trip.
  // The jurisdiction string is snapshotted alongside the receipt so the
  // banner copy reflects what the user actually submitted to even if a
  // background refetch updates `engagement.jurisdiction` between submit
  // and dismiss — mirroring the pattern Plan Review uses.
  const [lastSubmission, setLastSubmission] = useState<{
    receipt: SubmissionReceipt;
    jurisdiction: string | null;
  } | null>(null);
  // Currently-open submission detail modal (Task #84). `null` ==
  // closed; a string is the submission id whose ContextSummary the
  // modal should fetch. Lifted to the page so the same modal instance
  // serves the Submissions tab today and any other surface (chat
  // inline reference, banner deep-link) that wants to open the same
  // detail view tomorrow.
  const [openSubmissionId, setOpenSubmissionId] = useState<string | null>(
    null,
  );
  // Task #437 — CAD element ref deep-linked from a finding citation.
  // Lifted to the page so the click on the Findings tab can swing
  // over to the Site Context tab and the badge survives the tab
  // switch. Cleared from the viewer's own dismiss button so the
  // architect doesn't have to click back into Findings to drop the
  // selection.
  const [selectedElementRef, setSelectedElementRef] = useState<string | null>(
    null,
  );
  // Property Intel citation pills land on the Map tab's layer list;
  // lift the pending source id so SiteTab can flash the matching row.
  const [pendingBriefingSourceHighlight, setPendingBriefingSourceHighlight] =
    useState<string | null>(null);
  // WS-C (WSC.4) — AI-prepared spec drafts routed from the chat agent
  // to the L4 / L5 manual forms. EngagementDetail consumes the store
  // draft, switches to the matching tab, and hands it to the tab, which
  // opens its create dialog pre-filled for operator review.
  const [detailCalloutDraft, setDetailCalloutDraft] =
    useState<SpecDraftEntry | null>(null);
  const [productSpecDraft, setProductSpecDraft] =
    useState<SpecDraftEntry | null>(null);

  const bimModelQuery = useGetEngagementBimModel(id);

  // Archive / unarchive (QA-02 / WSB.2). PATCHes the engagement's
  // status; the engagements list filters archived projects out by
  // default, so this is how a project leaves / re-enters that list.
  const queryClient = useQueryClient();
  const archiveMutation = useUpdateEngagement({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({
          queryKey: getGetEngagementQueryKey(id),
        });
        await queryClient.invalidateQueries({
          queryKey: getListEngagementsQueryKey(),
        });
      },
    },
  });
  const bimModel = bimModelQuery.data?.bimModel ?? null;
  const bimElements = useMemo(() => bimModel?.elements ?? [], [bimModel]);
  // Resolve a GLB URL for the architect's BIM building. Architect-
  // uploaded meshes (`glbObjectPath` set) take priority and use the
  // element-id route; briefing-source-derived elements fall back to
  // the briefing-source route since the element route 404s when
  // `glbObjectPath` is null. Absolute URL so the server-side
  // capture browser the renders route invokes can reach it.
  const defaultBimGlbUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    const origin = window.location.origin;
    const ownMesh = bimElements.find(
      (el) => el.glbObjectPath !== null && el.glbObjectPath !== "",
    );
    if (ownMesh) {
      return `${origin}${getGetMaterializableElementGlbUrl(ownMesh.id)}`;
    }
    const sourceBacked = bimElements.find(
      (el) => el.briefingSourceId !== null && el.briefingSourceId !== "",
    );
    if (sourceBacked && sourceBacked.briefingSourceId) {
      return `${origin}${getGetBriefingSourceGlbUrl(sourceBacked.briefingSourceId)}`;
    }
    return null;
  }, [bimElements]);
  const [showBuildingOverlay, setShowBuildingOverlay] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return sessionStorage.getItem(`site-context:show-building:${id}`) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      sessionStorage.setItem(
        `site-context:show-building:${id}`,
        showBuildingOverlay ? "1" : "0",
      );
    } catch {
      // sessionStorage may be unavailable in private mode — ignore.
    }
  }, [id, showBuildingOverlay]);
  // Finding-citation drill-in lands on Snapshots so the BIM viewer can
  // highlight the matched element (full-screen affordance on that tab).
  const handleElementRefClick = (elementRef: string): void => {
    setSelectedElementRef(elementRef);
    setTab("snapshots");
  };
  const handleNavigateToMapFromBriefing = (sourceId: string): void => {
    setPendingBriefingSourceHighlight(sourceId);
    setTab("site");
  };
  // Auto-dismiss the banner after 8s so it stays out of the way once
  // the user has seen it. The dialog itself already closed on success,
  // so the banner is the only remaining post-submit affordance. Within
  // an 8s window the relative-time label is always "just now", so no
  // tick interval is needed to keep it fresh.
  useEffect(() => {
    if (!lastSubmission) return;
    const dismiss = window.setTimeout(() => {
      setLastSubmission(null);
    }, 8_000);
    return () => {
      window.clearTimeout(dismiss);
    };
  }, [lastSubmission]);

  const { data: engagement } = useGetEngagement(id, {
    query: {
      enabled: !!id,
      queryKey: getGetEngagementQueryKey(id),
      refetchInterval: 5000,
    },
  });

  const selectedSnapshotIdByEngagement = useEngagementsStore(
    (s) => s.selectedSnapshotIdByEngagement,
  );
  const selectSnapshot = useEngagementsStore((s) => s.selectSnapshot);
  const attachSheet = useEngagementsStore((s) => s.attachSheet);
  const setPendingChatInput = useEngagementsStore(
    (s) => s.setPendingChatInput,
  );
  const specDraftByEngagement = useEngagementsStore(
    (s) => s.specDraftByEngagement,
  );
  const consumeSpecDraft = useEngagementsStore((s) => s.consumeSpecDraft);
  const agentActionsByEngagement = useEngagementsStore(
    (s) => s.agentActionsByEngagement,
  );
  const chatStreaming = useEngagementsStore((s) => s.streaming);

  // WS-C (WSC.4) — when the chat agent stages a spec draft, route it to
  // the matching L4 / L5 tab and hand it to that tab for form pre-fill.
  useEffect(() => {
    if (!specDraftByEngagement[id]) return;
    const draft = consumeSpecDraft(id);
    if (!draft) return;
    if (draft.draftKind === "detail-callout-spec") {
      setDetailCalloutDraft(draft);
      setTab("product-specs");
    } else {
      setProductSpecDraft(draft);
      setTab("product-specs");
    }
  }, [specDraftByEngagement, id, consumeSpecDraft, setTab]);

  // WS-C (WSC.3) — when the chat agent writes response-tasks, refresh
  // the Response Tasks query so the tab reflects them, and once the turn
  // settles navigate the operator there (the chosen "results land in the
  // Response Tasks tab" behaviour). `lastAgentNavCount` is tracked per
  // engagement so switching engagements never fires a spurious nav.
  const lastAgentNavCount = useRef<Record<string, number>>({});
  useEffect(() => {
    const actions = agentActionsByEngagement[id] ?? [];
    if (actions.length === 0) return;
    // Any change to the action set (a fresh create, or a reverse
    // flipping an entry) refreshes the L1 list so the tab stays accurate.
    void queryClient.invalidateQueries({
      queryKey: getListResponseTasksQueryKey(id),
    });
    if (
      actions.length > (lastAgentNavCount.current[id] ?? 0) &&
      !chatStreaming
    ) {
      lastAgentNavCount.current[id] = actions.length;
      setTab("response-tasks");
    }
  }, [agentActionsByEngagement, id, chatStreaming, queryClient, setTab]);
  const rightCollapsed = useSidebarState((s) => s.rightCollapsed);
  const toggleRight = useSidebarState((s) => s.toggleRight);

  const handleAskClaudeAboutSheet = (sheet: SheetSummary) => {
    attachSheet(id, sheet);
    setPendingChatInput(
      id,
      `What is shown on sheet ${sheet.sheetNumber} (${sheet.sheetName})?`,
    );
    if (rightCollapsed) toggleRight();
  };

  const handleVisualizeFloorPlanFromSheet = (sheet: SheetSummary) => {
    writeFloorPlanVizDeepLink(floorPlanSourceIdForSheet(id, sheet.id));
    setRenderDeepLinkToken((t) => t + 1);
    setTab("renders");
  };

  const handleSendToStudio = useCallback(
    (capture: BimStudioCapture) => {
      setStudioCapture(capture);
      writeRenderModeToUrl("model");
      setRenderDeepLinkToken((t) => t + 1);
      setTab("renders");
    },
    [setTab],
  );

  const handleStudioCaptureConsumed = useCallback(() => {
    setStudioCapture(null);
  }, []);

  const explicitlySelected = selectedSnapshotIdByEngagement[id] ?? null;
  const defaultSelected = engagement?.snapshots?.[0]?.id ?? null;
  const selectedSnapshotId = explicitlySelected ?? defaultSelected;

  // Auto-pin most-recent on first load so manual selection sticks
  useEffect(() => {
    if (
      explicitlySelected === null &&
      defaultSelected &&
      !(id in selectedSnapshotIdByEngagement)
    ) {
      selectSnapshot(id, defaultSelected);
    }
  }, [
    id,
    defaultSelected,
    explicitlySelected,
    selectedSnapshotIdByEngagement,
    selectSnapshot,
  ]);

  // Intake mode: open modal automatically the first time we see an
  // engagement without an address, unless the user has dismissed it.
  // We use a ref so we don't keep re-opening it after the user closes
  // the modal (e.g. via Save in edit mode while the engagement query
  // hasn't refetched yet).
  const intakeStorageKey = useMemo(
    () => (id ? `engagement-intake-skipped:${id}` : ""),
    [id],
  );
  const intakeShownForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!engagement || !intakeStorageKey) return;
    if (engagement.address && engagement.address.trim().length > 0) return;
    if (intakeShownForRef.current === engagement.id) return;
    try {
      if (localStorage.getItem(intakeStorageKey)) return;
    } catch {
      /* ignore */
    }
    intakeShownForRef.current = engagement.id;
    setModalMode("intake");
    setModalOpen(true);
  }, [engagement, intakeStorageKey]);

  const { data: snapshotDetail } = useGetSnapshot(selectedSnapshotId ?? "", {
    query: {
      enabled: !!selectedSnapshotId,
      queryKey: getGetSnapshotQueryKey(selectedSnapshotId ?? ""),
    },
  });

  // Badge fetch for the Findings tab (Task #421 / V1-1 / V1-7).
  // The architect surface only highlights work on the most-recent
  // submission — older submissions still have findings, but the
  // queue an architect needs to triage day-to-day is the live one.
  // We resolve "most-recent" client-side so this stays correct
  // regardless of the listing endpoint's sort order on a given
  // refetch (the API already sorts newest-first today; the
  // client-side reduce keeps us robust to that contract evolving).
  const { data: submissionsForBadge } = useListEngagementSubmissions(id, {
    query: {
      enabled: !!id,
      queryKey: getListEngagementSubmissionsQueryKey(id),
    },
  });
  const latestSubmissionId = useMemo(() => {
    if (!submissionsForBadge || submissionsForBadge.length === 0) return null;
    return submissionsForBadge.reduce<EngagementSubmissionSummary>(
      (acc, s) =>
        Date.parse(s.submittedAt) > Date.parse(acc.submittedAt) ? s : acc,
      submissionsForBadge[0],
    ).id;
  }, [submissionsForBadge]);
  const { data: badgeFindings } = useListSubmissionFindings(
    latestSubmissionId ?? "",
    {
      query: {
        enabled: !!latestSubmissionId,
        queryKey: getListSubmissionFindingsQueryKey(latestSubmissionId ?? ""),
      },
    },
  );
  const findingsBadgeCount = badgeFindings
    ? countUnaddressedFindings(badgeFindings.findings)
    : undefined;

  if (!engagement) {
    return (
      <AppShell hidePageTitle title="Loading…">
        <div className="sc-prose opacity-60">Loading engagement…</div>
      </AppShell>
    );
  }

  const snapshots = engagement.snapshots ?? [];
  const hasSnapshots = snapshots.length > 0;

  const openEdit = () => {
    setModalMode("edit");
    setModalOpen(true);
  };

  const handleIntakeSkip = () => {
    try {
      localStorage.setItem(intakeStorageKey, "1");
    } catch {
      /* ignore */
    }
  };

  // Whenever the modal closes after intake mode (whether saved, skipped, or
  // dismissed), record that we've handled intake so a page refresh doesn't
  // re-prompt. The Skip button does this immediately; for Save & continue
  // we set the same key here so the prompt is always one-shot per browser.
  const handleModalClose = () => {
    if (modalMode === "intake") {
      try {
        localStorage.setItem(intakeStorageKey, "1");
      } catch {
        /* ignore */
      }
    }
    setModalOpen(false);
  };

  // BIM model viewer panel — Snapshots tab hero only (3D model segment removed).
  const bimViewportCentered = bimModelQuery.isLoading || bimElements.length === 0;

  const bimViewportBody =
    bimModelQuery.isLoading ? (
      <div className="sc-prose opacity-60">Loading BIM model…</div>
    ) : bimElements.length === 0 ? (
      <div className="sc-prose opacity-70 text-center px-6">
        No BIM elements yet. Push this engagement&apos;s briefing to Revit to
        populate the 3D viewer.
      </div>
    ) : (
      <BimModelViewport
        elements={bimElements}
        selectedElementRef={selectedElementRef ?? null}
        presentation="immersive"
        studioGlbUrl={defaultBimGlbUrl}
        onSendToStudio={handleSendToStudio}
      />
    );

  const bimHeroPanel = (
    <div
      className="snapshots-bim-hero-viewport"
      data-testid="snapshots-bim-viewer"
      data-centered={bimViewportCentered ? "true" : "false"}
    >
      {bimViewportBody}
    </div>
  );

  return (
    <AppShell hidePageTitle>
      <div className="cockpit-engagement-column flex flex-col flex-1 min-h-0 gap-4">
        {lastSubmission && (
          <SubmissionRecordedBanner
            submittedAt={lastSubmission.receipt.submittedAt}
            jurisdiction={lastSubmission.jurisdiction}
            onDismiss={() => setLastSubmission(null)}
          />
        )}
        <div className="cockpit-detail-header">
          <div className="cockpit-detail-header-title">
            <div className="cockpit-detail-header-name-row">
              <h2 className="cockpit-detail-header-name">{engagement.name}</h2>
              <StatusPill status={engagement.status} />
            </div>
            <div className="cockpit-detail-header-meta">
              {engagement.address ?? "No address set"}
              {engagement.jurisdiction ? ` · ${engagement.jurisdiction}` : ""}
            </div>
          </div>
          <div className="cockpit-detail-header-actions">
            <Link href="/" className="sc-btn-ghost">
              ← Projects
            </Link>
            <button className="sc-btn-ghost" onClick={openEdit}>
              Edit details
            </button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  className="sc-btn-ghost"
                  data-testid="engagement-archive-toggle"
                  disabled={archiveMutation.isPending}
                >
                  {archiveMutation.isPending
                    ? "Saving…"
                    : engagement.status === "archived"
                      ? "Unarchive"
                      : "Archive"}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {engagement.status === "archived"
                      ? "Unarchive this project?"
                      : "Archive this project?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {engagement.status === "archived"
                      ? "It will return to the active projects list and reappear in the sidebar shortcuts."
                      : "It will be hidden from the active projects list. You can find it again by enabling Show archived on the Projects page."}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel data-testid="engagement-archive-cancel">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="engagement-archive-confirm"
                    onClick={() =>
                      archiveMutation.mutate({
                        id,
                        data: {
                          status:
                            engagement.status === "archived"
                              ? "active"
                              : "archived",
                        },
                      })
                    }
                  >
                    {engagement.status === "archived"
                      ? "Unarchive"
                      : "Archive"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <button
              type="button"
              className="sc-btn-primary"
              onClick={() => setSubmitOpen(true)}
              data-testid="submit-jurisdiction-trigger"
            >
              Submit to jurisdiction
            </button>
          </div>
        </div>

        {/*
          Wave 2 Sprint D / V1-2 — architect-side queue of pending
          reviewer-requests on this engagement. Mounted above TabBar
          so the queue is visible regardless of which tab is active.
          The component is self-hiding when the queue is empty.
        */}
        <ReviewerRequestsStrip engagementId={id} />

        {/*
          Task #441 — collapsible "Resolved / Dismissed history"
          disclosure rendered directly under the pending strip so the
          architect can look back at requests that have already
          closed. Self-hides when there is no history to show.
        */}
        <ReviewerRequestsHistory engagementId={id} />

        <EngagementViewHeader
          activeTab={tab}
          onSelectTab={setTab}
          findingsBadgeCount={findingsBadgeCount}
        />

        <div className="cockpit-engagement-body flex flex-col flex-1 min-h-0">
        <TabPanel id="snapshots" active={tab} className="flex flex-col flex-1 min-h-0">
          <SnapshotsTab
            engagementId={id}
            snapshots={snapshots}
            hasSnapshots={hasSnapshots}
            snapshotDetail={snapshotDetail}
            selectedSnapshotId={selectedSnapshotId}
            onSelectSnapshot={(snapshotId) => selectSnapshot(id, snapshotId)}
            bimModelPanel={bimHeroPanel}
            bimElementCount={bimElements.length}
            jsonExpanded={jsonExpanded}
            setJsonExpanded={setJsonExpanded}
            onOpenSheets={() => setTab("sheets")}
          />
        </TabPanel>

        <TabPanel id="sheets" active={tab} className="flex flex-col gap-3">
          <TabHeader
            overline="Deliver"
            title="Sheets"
            subtitle="Sheet thumbnails from the active snapshot — attach to chat, visualize floor plans, or open full size."
            testId="sheets-tab-header"
            actions={
              <button
                type="button"
                className="sc-btn-ghost"
                data-testid="sheets-tab-view-in-3d"
                disabled={bimElements.length === 0}
                onClick={() => setTab("snapshots")}
                title={
                  bimElements.length === 0
                    ? "Push this engagement's briefing to Revit to enable the 3D viewer."
                    : "Open the BIM model on Snapshots (use Full screen 3D for immersive view)."
                }
              >
                View BIM model
              </button>
            }
          />
          <SheetGrid
            snapshotId={selectedSnapshotId}
            engagementId={id}
            onAskClaude={handleAskClaudeAboutSheet}
            onVisualizeFloorPlan={handleVisualizeFloorPlanFromSheet}
          />
        </TabPanel>

        <TabPanel id="site" active={tab} className="flex flex-col flex-1 min-h-0">
          <SiteTab
            engagement={engagement}
            onAddAddress={openEdit}
            onOpenPropertyIntel={setTab}
            selectedElementRef={selectedElementRef}
            onClearSelectedElement={() => setSelectedElementRef(null)}
            buildingGlbUrl={defaultBimGlbUrl}
            showBuilding={showBuildingOverlay}
            onToggleShowBuilding={setShowBuildingOverlay}
            bimModelLoading={bimModelQuery.isLoading}
            initialCanvasMode={
              tab === "site" && selectedElementRef ? "3d" : "map"
            }
            pendingBriefingSourceHighlight={pendingBriefingSourceHighlight}
            onPendingBriefingSourceHighlightConsumed={() =>
              setPendingBriefingSourceHighlight(null)
            }
          />
        </TabPanel>

        <TabPanel
          id="property-intel"
          active={tab}
          className="flex flex-col flex-1 min-h-0"
        >
          <PropertyIntelTab
            engagement={engagement}
            onNavigate={setTab}
            onNavigateToMapWithSource={handleNavigateToMapFromBriefing}
            selectedElementRef={selectedElementRef}
            onClearSelectedElement={() => setSelectedElementRef(null)}
            buildingGlbUrl={defaultBimGlbUrl}
            showBuilding={showBuildingOverlay}
            onToggleShowBuilding={setShowBuildingOverlay}
          />
        </TabPanel>

        <TabPanel id="submissions" active={tab}>
          <SubmissionsTab
            engagementId={engagement.id}
            backfillFilter={backfillFilter}
            onBackfillFilterChange={setBackfillFilter}
            onOpenSubmission={(sid) => setOpenSubmissionId(sid)}
          />
        </TabPanel>

        <TabPanel id="findings" active={tab} className="flex flex-col flex-1 min-h-0">
          <FindingsTab
            engagementId={engagement.id}
            engagementJurisdiction={engagement.jurisdiction}
            engagementCoverageStatus={
              (engagement as { coverageStatus?: string }).coverageStatus
            }
            initialSubmissionId={latestSubmissionId}
            onElementRefClick={handleElementRefClick}
          />
        </TabPanel>

        <TabPanel id="response-tasks" active={tab}>
          <ResponseTasksTab engagementId={engagement.id} />
        </TabPanel>

        <TabPanel id="deliverable-letters" active={tab}>
          <DeliverableLettersTab engagementId={engagement.id} />
        </TabPanel>

        <TabPanel id="detail-callouts" active={tab}>
          {/* QA-56 B — legacy deep link; same unified surface as product-specs */}
          <ProductSpecReferencesTab
            engagementId={engagement.id}
            aiDraft={productSpecDraft}
            onAiDraftConsumed={() => setProductSpecDraft(null)}
          />
          <div style={{ marginTop: 24 }}>
            <DetailCalloutSpecsTab
              engagementId={engagement.id}
              aiDraft={detailCalloutDraft}
              onAiDraftConsumed={() => setDetailCalloutDraft(null)}
            />
          </div>
        </TabPanel>

        <TabPanel id="product-specs" active={tab}>
          <ProductSpecReferencesTab
            engagementId={engagement.id}
            aiDraft={productSpecDraft}
            onAiDraftConsumed={() => setProductSpecDraft(null)}
          />
          <div style={{ marginTop: 24 }}>
            <DetailCalloutSpecsTab
              engagementId={engagement.id}
              aiDraft={detailCalloutDraft}
              onAiDraftConsumed={() => setDetailCalloutDraft(null)}
            />
          </div>
        </TabPanel>

        <TabPanel
          id="packages"
          active={
            tab === "publish-prep" || tab === "publish-launch"
              ? "packages"
              : tab
          }
          className="cockpit-engagement-tabpanel-scroll flex flex-col flex-1 min-h-0"
        >
          <PackagesTab
            engagement={engagement}
            snapshotId={selectedSnapshotId}
            onNavigate={setTab}
            initialTemplate={packageTemplateForTab(tab)}
          />
        </TabPanel>

        <TabPanel
          id="client-materials"
          active={tab}
          className="cockpit-engagement-tabpanel-scroll flex flex-col flex-1 min-h-0"
        >
          <ClientMaterialsTab engagement={engagement} onNavigate={setTab} />
        </TabPanel>

        <TabPanel id="renders" active={tab} className="flex flex-col flex-1 min-h-0">
          <DesignToolsTab
            engagementId={engagement.id}
            snapshotId={selectedSnapshotId}
            defaultGlbUrl={defaultBimGlbUrl}
            onOpenBimTab={() => setTab("snapshots")}
            onOpenClientMaterials={() => setTab("client-materials")}
            renderDeepLinkToken={renderDeepLinkToken}
            initialStudioCapture={studioCapture}
            onStudioCaptureConsumed={handleStudioCaptureConsumed}
          />
        </TabPanel>

        <TabPanel id="settings" active={tab}>
          <SettingsTab engagement={engagement} onEdit={openEdit} />
        </TabPanel>
        </div>
      </div>

      <EngagementDetailsModal
        engagement={engagement}
        isOpen={modalOpen}
        onClose={handleModalClose}
        mode={modalMode}
        onSkip={handleIntakeSkip}
      />

      <SubmitToJurisdictionDialog
        engagementId={engagement.id}
        engagementName={engagement.name}
        jurisdiction={engagement.jurisdiction}
        isOpen={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={(receipt) =>
          setLastSubmission({
            receipt,
            jurisdiction: engagement.jurisdiction,
          })
        }
      />

      <SubmissionDetailModal
        submissionId={openSubmissionId}
        engagementId={engagement.id}
        onClose={() => setOpenSubmissionId(null)}
      />
    </AppShell>
  );
}
