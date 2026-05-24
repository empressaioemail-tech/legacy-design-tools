import {
  Fragment,
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
import { ClaudeChat } from "../components/ClaudeChat";
import { EngagementDetailsModal } from "../components/EngagementDetailsModal";
import { SheetGrid } from "../components/SheetGrid";
import { SubmissionDetailModal } from "../components/SubmissionDetailModal";
import {
  ReviewerRequestsStrip,
  ReviewerRequestsHistory,
} from "../components/ReviewerRequestsStrip";
import {
  BimModelViewport,
  KpiTile,
  StatusPill,
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
  countUnaddressedFindings,
  useSidebarState,
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
import { relativeTime } from "../lib/relativeTime";
import type { BackfillFilter } from "../lib/submissionBackfill";
import { SiteTab } from "../components/engagement-detail/SiteTab";
import { SettingsTab } from "../components/engagement-detail/SettingsTab";
import { SiteContextTab } from "../components/engagement-detail/SiteContextTab";
import { SubmissionsTab } from "../components/engagement-detail/SubmissionsTab";
import { RendersTab } from "../components/engagement-detail/RendersTab";
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

const TAB_GROUP_LABELS: Record<string, string> = {
  model: "Model & Source",
  site: "Site",
  review: "Review",
  deliverables: "Deliverables",
  config: "Config",
};

function TabBar({
  active,
  onChange,
  findingsBadgeCount,
}: {
  active: TabId;
  onChange: (id: TabId) => void;
  /**
   * Number of unaddressed findings on the most-recent submission
   * (Task #421 / V1-1 / V1-7). Rendered as a small badge on the
   * "Findings" tab so an architect can spot blocker / concern work
   * without having to open the tab. `undefined` while the badge
   * fetch is loading or the engagement has no submissions yet —
   * we render the tab with no badge in that case.
   */
  findingsBadgeCount?: number | undefined;
}) {
  // The thirteen tabs the architect uses on an engagement bucket into
  // the five workflow segments locked in the IA decision (Option A,
  // workflow-grouped): model intake, site context, the review/findings
  // loop, deliverable packaging, and configuration. Each cluster is
  // labelled with a small overline so the 5-workflow IA reads at a
  // glance instead of dissolving into one long thirteen-tab strip
  // (QA-01 / WSB.1).
  //
  // The tabstrip implements the WAI-ARIA Tabs pattern: role=tablist on
  // the container, role=tab + aria-selected on each trigger, roving
  // tabindex (active tab is the only one in the natural tab order),
  // and arrow-key navigation with Home/End wrap. Activation is
  // automatic on focus change — matches the rest of the design system
  // and avoids requiring Enter for what is purely a view-selection
  // affordance.
  const tabs: Array<{ id: TabId; label: string; group: string }> = [
    { id: "snapshots", label: "Snapshots", group: "model" },
    { id: "sheets", label: "Sheets", group: "model" },
    { id: "model-3d", label: "3D model", group: "model" },
    { id: "site", label: "Site", group: "site" },
    { id: "site-context", label: "Site context", group: "site" },
    { id: "submissions", label: "Submissions", group: "review" },
    { id: "findings", label: "Findings", group: "review" },
    { id: "response-tasks", label: "Response tasks", group: "review" },
    {
      id: "deliverable-letters",
      label: "Deliverable letters",
      group: "deliverables",
    },
    { id: "detail-callouts", label: "Detail callouts", group: "deliverables" },
    { id: "product-specs", label: "Product specs", group: "deliverables" },
    { id: "renders", label: "Renders", group: "deliverables" },
    { id: "settings", label: "Settings", group: "config" },
  ];

  // Bucket consecutive same-group tabs so each cluster can render
  // beneath its own overline label without losing the flat keyboard
  // tabindex order.
  const groups: Array<{
    key: string;
    label: string;
    tabs: Array<{ id: TabId; label: string; group: string }>;
  }> = [];
  for (const t of tabs) {
    const last = groups[groups.length - 1];
    if (last && last.key === t.group) {
      last.tabs.push(t);
    } else {
      groups.push({
        key: t.group,
        label: TAB_GROUP_LABELS[t.group] ?? t.group,
        tabs: [t],
      });
    }
  }

  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIdx = Math.max(
    0,
    tabs.findIndex((t) => t.id === active),
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next = activeIdx;
    if (e.key === "ArrowRight") next = (activeIdx + 1) % tabs.length;
    else if (e.key === "ArrowLeft")
      next = (activeIdx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].id);
    // Defer focus to next paint so the re-rendered button is mounted
    // with the correct tabindex before we ask it to receive focus.
    requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };

  return (
    <div
      role="tablist"
      aria-label="Engagement workflow"
      onKeyDown={handleKeyDown}
      className="sc-scroll"
      style={{
        display: "flex",
        gap: 10,
        borderBottom: "1px solid var(--border-default)",
        overflowX: "auto",
      }}
    >
      {groups.map((g, gi) => (
        <Fragment key={g.key}>
          {gi > 0 && (
            <div
              aria-hidden="true"
              style={{
                alignSelf: "stretch",
                flexShrink: 0,
                width: 1,
                background: "var(--border-default)",
                marginTop: 14,
              }}
            />
          )}
          <div
            role="presentation"
            style={{
              display: "flex",
              flexDirection: "column",
              flexShrink: 0,
            }}
            data-testid={`engagement-tab-group-${g.key}`}
          >
            <div
              className="sc-label"
              aria-hidden="true"
              style={{
                fontSize: 9,
                opacity: 0.55,
                padding: "2px 10px 0",
                letterSpacing: "0.10em",
              }}
            >
              {g.label}
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {g.tabs.map((t) => {
                const idx = tabs.indexOf(t);
                const isActive = active === t.id;
                const showBadge =
                  t.id === "findings" &&
                  typeof findingsBadgeCount === "number" &&
                  findingsBadgeCount > 0;
                return (
                  <button
                    key={t.id}
                    ref={(el) => {
                      tabRefs.current[idx] = el;
                    }}
                    type="button"
                    role="tab"
                    id={`engagement-tab-trigger-${t.id}`}
                    aria-selected={isActive}
                    aria-controls={`engagement-tabpanel-${t.id}`}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => onChange(t.id)}
                    className="sc-tab sc-tab-trigger"
                    data-active={isActive ? "true" : "false"}
                    data-testid={`engagement-tab-${t.id}`}
                    style={{
                      flexShrink: 0,
                      padding: "6px 10px 8px",
                      background: "transparent",
                      border: "none",
                      borderBottom: isActive
                        ? "2px solid var(--cyan)"
                        : "2px solid transparent",
                      color: isActive
                        ? "var(--text-primary)"
                        : "var(--text-secondary)",
                      cursor: "pointer",
                      transition:
                        "color 0.12s, border-color 0.12s, box-shadow 0.12s",
                      marginBottom: -1,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {t.label}
                    {showBadge && (
                      <span
                        data-testid="engagement-tab-findings-badge"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          minWidth: 16,
                          height: 16,
                          padding: "0 5px",
                          borderRadius: 8,
                          background: "rgba(239, 68, 68, 0.18)",
                          color: "#ef4444",
                          fontSize: 10,
                          fontWeight: 600,
                          lineHeight: 1,
                        }}
                      >
                        {findingsBadgeCount}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </Fragment>
      ))}
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
  const [showBuildingOverlay, setShowBuildingOverlay] = useState(false);
  // Finding-citation drill-in lands on Snapshots so the new BIM
  // viewer can highlight the matched element. The Site Context tab
  // still subscribes to `selectedElementRef` if the user navigates
  // there manually.
  const handleElementRefClick = (elementRef: string): void => {
    setSelectedElementRef(elementRef);
    setTab("snapshots");
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
      setTab("detail-callouts");
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
      <AppShell title="Loading…">
        <div className="sc-prose opacity-60">Loading engagement…</div>
      </AppShell>
    );
  }

  const snapshots = engagement.snapshots ?? [];
  const hasSnapshots = snapshots.length > 0;
  const captured = snapshotDetail
    ? `from snapshot ${relativeTime(snapshotDetail.receivedAt)}`
    : undefined;

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

  // BIM model viewer panel — shared by the Snapshots tab (where WSB.3
  // moves it up beside the snapshot timeline) and the dedicated
  // "3D model" tab (WSB.1). Tabs render conditionally so only one
  // instance ever mounts. Keeps `data-testid="snapshots-bim-viewer"`
  // so the finding-citation deep-link regression test still resolves.
  const bimModelPanel = (
    <div
      className="sc-card flex flex-col h-full"
      data-testid="snapshots-bim-viewer"
      style={{ minHeight: 420 }}
    >
      <div className="sc-card-header sc-row-sb">
        <span className="sc-label">BIM MODEL</span>
        <span className="sc-meta">
          {bimElements.length}{" "}
          {bimElements.length === 1 ? "element" : "elements"}
        </span>
      </div>
      <div
        className="flex-1"
        style={{
          borderTop: "1px solid var(--border-default)",
          padding: 8,
          display: "flex",
          minHeight: 0,
        }}
      >
        {bimModelQuery.isLoading ? (
          <div className="sc-prose opacity-60 m-auto">Loading BIM model…</div>
        ) : bimElements.length === 0 ? (
          <div className="sc-prose opacity-70 m-auto text-center">
            No BIM elements yet. Push this engagement&apos;s briefing to Revit
            to populate the 3D viewer.
          </div>
        ) : (
          <BimModelViewport
            elements={bimElements}
            selectedElementRef={selectedElementRef ?? null}
          />
        )}
      </div>
    </div>
  );

  return (
    <AppShell
      title={engagement.name}
      rightPanel={
        <ClaudeChat
          engagementId={id}
          hasSnapshots={hasSnapshots}
          snapshots={snapshots}
          activeTab={tab}
        />
      }
    >
      <div className="flex flex-col gap-5 h-full">
        {lastSubmission && (
          <SubmissionRecordedBanner
            submittedAt={lastSubmission.receipt.submittedAt}
            jurisdiction={lastSubmission.jurisdiction}
            onDismiss={() => setLastSubmission(null)}
          />
        )}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h2 className="text-[22px] m-0">{engagement.name}</h2>
              <StatusPill status={engagement.status} />
            </div>
            <div className="sc-meta opacity-70">
              {engagement.address ?? "No address set"}
              {engagement.jurisdiction ? ` · ${engagement.jurisdiction}` : ""}
            </div>
          </div>
          <div className="flex items-center gap-3">
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

        <TabBar
          active={tab}
          onChange={setTab}
          findingsBadgeCount={findingsBadgeCount}
        />

        <TabPanel id="snapshots" active={tab}>
            <div className="grid grid-cols-4 gap-3">
              <KpiTile
                label="SHEETS"
                value={snapshotDetail?.sheetCount}
                footnote={captured}
                testId="engagement-kpi-sheets"
              />
              <KpiTile
                label="ROOMS"
                value={snapshotDetail?.roomCount}
                footnote={captured}
                testId="engagement-kpi-rooms"
              />
              <KpiTile
                label="LEVELS"
                value={snapshotDetail?.levelCount}
                footnote={captured}
                testId="engagement-kpi-levels"
              />
              <KpiTile
                label="WALLS"
                value={snapshotDetail?.wallCount}
                footnote={captured}
                testId="engagement-kpi-walls"
              />
            </div>

            <div className="grid lg:grid-cols-3 gap-4 flex-1 min-h-0">
              <div className="sc-card flex flex-col col-span-1 min-h-0">
                <div className="sc-card-header sc-row-sb">
                  <span className="sc-label">SNAPSHOTS</span>
                  <span className="sc-meta">{snapshots.length}</span>
                </div>
                <div
                  className="flex-1 overflow-y-auto sc-scroll"
                  data-testid="engagement-snapshot-timeline"
                >
                  {!hasSnapshots ? (
                    <div className="p-4 sc-body text-center opacity-70">
                      No snapshots yet. Send one from Revit.
                    </div>
                  ) : (
                    snapshots.map((s) => {
                      const isSelected = s.id === selectedSnapshotId;
                      return (
                        <div
                          key={s.id}
                          data-testid={`snapshot-row-${s.id}`}
                          data-selected={isSelected ? "true" : "false"}
                          className={`sc-card-row sc-card-clickable flex flex-col ${
                            isSelected ? "sc-accent-cyan" : ""
                          }`}
                          style={{
                            background: isSelected
                              ? "var(--bg-highlight)"
                              : undefined,
                          }}
                          onClick={() => selectSnapshot(id, s.id)}
                        >
                          <div className="sc-medium">
                            {relativeTime(s.receivedAt)}
                          </div>
                          <div className="sc-meta mt-1">
                            {s.sheetCount ?? "—"}sh · {s.roomCount ?? "—"}rm ·{" "}
                            {s.levelCount ?? "—"}lv · {s.wallCount ?? "—"}w
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/*
                QA-12 / WSB.3 — the BIM model is promoted into the
                primary column beside the snapshot timeline instead of
                sitting at the bottom of the tab under the raw JSON.
              */}
              <div className="col-span-2 min-h-0">
                {!hasSnapshots && bimElements.length === 0 ? (
                  <div className="sc-card p-8 h-full flex items-center justify-center">
                    <div className="sc-prose text-center opacity-70">
                      No snapshots yet. Send one from Revit.
                    </div>
                  </div>
                ) : (
                  bimModelPanel
                )}
              </div>
            </div>

            {/*
              QA-12 / WSB.3 — raw snapshot JSON demoted to a secondary,
              collapsed-by-default card below the model. It stays
              available for debugging without dominating the tab.
            */}
            {hasSnapshots && (
              <div className="sc-card flex flex-col" data-testid="raw-json-card">
                <div className="sc-card-header sc-row-sb">
                  <span className="sc-label">RAW JSON</span>
                  <button
                    className="sc-btn-sm"
                    onClick={() => setJsonExpanded(!jsonExpanded)}
                  >
                    {jsonExpanded ? "Collapse" : "Expand"}
                  </button>
                </div>
                {jsonExpanded &&
                  (!snapshotDetail ? (
                    <div
                      className="p-4 sc-prose opacity-60"
                      style={{ borderTop: "1px solid var(--border-default)" }}
                    >
                      Loading snapshot…
                    </div>
                  ) : (
                    <div
                      className="flex-1 overflow-hidden"
                      style={{ borderTop: "1px solid var(--border-default)" }}
                    >
                      <pre
                        className="sc-mono-sm sc-scroll m-0"
                        style={{
                          background: "var(--bg-input)",
                          padding: 12,
                          maxHeight: 600,
                          overflow: "auto",
                          whiteSpace: "pre-wrap",
                          wordWrap: "break-word",
                        }}
                      >
                        {JSON.stringify(snapshotDetail.payload, null, 2)}
                      </pre>
                    </div>
                  ))}
              </div>
            )}
        </TabPanel>

        <TabPanel id="model-3d" active={tab} className="flex flex-col flex-1 min-h-0">
          {bimModelPanel}
        </TabPanel>

        <TabPanel id="sheets" active={tab}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                alignItems: "center",
                gap: 8,
              }}
            >
              <button
                type="button"
                className="sc-btn-ghost"
                data-testid="sheets-tab-view-in-3d"
                disabled={bimElements.length === 0}
                onClick={() => setTab("model-3d")}
                title={
                  bimElements.length === 0
                    ? "Push this engagement's briefing to Revit to enable the 3D viewer."
                    : "Open the dedicated 3D model tab."
                }
              >
                View in 3D
              </button>
            </div>
            <SheetGrid
              snapshotId={selectedSnapshotId}
              engagementId={id}
              onAskClaude={handleAskClaudeAboutSheet}
            />
          </div>
        </TabPanel>

        <TabPanel id="site" active={tab}>
          <SiteTab engagement={engagement} onAddAddress={openEdit} />
        </TabPanel>

        <TabPanel id="site-context" active={tab}>
          <SiteContextTab
            engagement={engagement}
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

        <TabPanel id="findings" active={tab}>
          <FindingsTab
            engagementId={engagement.id}
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
          <DetailCalloutSpecsTab
            engagementId={engagement.id}
            aiDraft={detailCalloutDraft}
            onAiDraftConsumed={() => setDetailCalloutDraft(null)}
          />
        </TabPanel>

        <TabPanel id="product-specs" active={tab}>
          <ProductSpecReferencesTab
            engagementId={engagement.id}
            aiDraft={productSpecDraft}
            onAiDraftConsumed={() => setProductSpecDraft(null)}
          />
        </TabPanel>

        <TabPanel id="renders" active={tab}>
          <RendersTab
            engagementId={engagement.id}
            defaultGlbUrl={defaultBimGlbUrl}
          />
        </TabPanel>

        <TabPanel id="settings" active={tab}>
          <SettingsTab engagement={engagement} onEdit={openEdit} />
        </TabPanel>
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
