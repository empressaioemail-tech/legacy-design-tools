import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import {
  useGetEngagement,
  useGetEngagementBimModel,
  useGetSnapshot,
  useListEngagementSubmissions,
  useListSubmissionFindings,
  getGetEngagementQueryKey,
  getGetSnapshotQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
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
  SubmissionRecordedBanner,
  SubmitToJurisdictionDialog,
  countUnaddressedFindings,
  useSidebarState,
} from "@workspace/portal-ui";
import { useEngagementsStore } from "../store/engagements";
import { relativeTime } from "../lib/relativeTime";
import type { BackfillFilter } from "../lib/submissionBackfill";
import { StatusPill } from "../components/engagement-detail/StatusPill";
import { SiteTab } from "../components/engagement-detail/SiteTab";
import { SettingsTab } from "../components/engagement-detail/SettingsTab";
import { SiteContextTab } from "../components/engagement-detail/SiteContextTab";
import { SubmissionsTab } from "../components/engagement-detail/SubmissionsTab";
import { RendersTab } from "../components/engagement-detail/RendersTab";
import { FindingsTab } from "../components/engagement-detail/FindingsTab";
import { ResponseTasksTab } from "../components/engagement-detail/ResponseTasksTab";
import {
  readBackfillFilterFromUrl,
  readTabFromUrl,
  writeBackfillFilterToUrl,
  writeTabToUrl,
  type TabId,
} from "../components/engagement-detail/urlState";

function KpiTile({
  label,
  value,
  footnote,
}: {
  label: string;
  value: number | string | null | undefined;
  footnote?: string;
}) {
  // testid is keyed on a normalized lowercase label so e2e tests
  // (`engagement-snapshot-timeline.spec.ts`) can target individual
  // tiles without relying on visible text or DOM order.
  const testId = `engagement-kpi-${label.toLowerCase()}`;
  return (
    <div className="sc-card p-4" data-testid={testId}>
      <div className="sc-label">{label}</div>
      <div className="sc-kpi-md mt-2" data-testid={`${testId}-value`}>
        {value ?? "—"}
      </div>
      {footnote && <div className="sc-meta mt-1 opacity-70">{footnote}</div>}
    </div>
  );
}

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
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "snapshots", label: "Snapshots" },
    { id: "sheets", label: "Sheets" },
    { id: "site", label: "Site" },
    { id: "site-context", label: "Site context" },
    { id: "submissions", label: "Submissions" },
    { id: "findings", label: "Findings" },
    { id: "response-tasks", label: "Response tasks" },
    { id: "renders", label: "Renders" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid var(--border-default)",
      }}
    >
      {tabs.map((t) => {
        const isActive = active === t.id;
        const showBadge =
          t.id === "findings" &&
          typeof findingsBadgeCount === "number" &&
          findingsBadgeCount > 0;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className="sc-tab"
            data-testid={`engagement-tab-${t.id}`}
            style={{
              padding: "8px 14px",
              background: "transparent",
              border: "none",
              borderBottom: isActive
                ? "2px solid var(--cyan)"
                : "2px solid transparent",
              color: isActive
                ? "var(--text-primary)"
                : "var(--text-secondary)",
              fontFamily: "Inter, sans-serif",
              fontSize: 12,
              cursor: "pointer",
              transition: "color 0.12s, border-color 0.12s",
              marginBottom: -1,
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
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
  );
}

export function EngagementDetail() {
  const params = useParams();
  const id = params.id as string;
  const [jsonExpanded, setJsonExpanded] = useState(true);
  // Initialize tab from `?tab=…` so deep links land on the right tab
  // without a flicker. Sync on every change via `setTabAndSyncUrl`
  // (defined below) — we deliberately do NOT subscribe to `popstate`,
  // matching DevAtoms.tsx's exploratory-page convention. If a future
  // sprint needs back-button-aware tabs, it can wrap this state in a
  // `useSyncExternalStore` against `popstate`.
  const [tab, setTabState] = useState<TabId>(() => readTabFromUrl());
  const setTab = (next: TabId): void => {
    setTabState(next);
    writeTabToUrl(next);
  };
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

  const bimModelQuery = useGetEngagementBimModel(id);
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

  return (
    <AppShell
      title={engagement.name}
      rightPanel={
        <ClaudeChat
          engagementId={id}
          hasSnapshots={hasSnapshots}
          snapshots={snapshots}
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

        {tab === "snapshots" && (
          <>
            <div className="grid grid-cols-4 gap-3">
              <KpiTile
                label="SHEETS"
                value={snapshotDetail?.sheetCount}
                footnote={captured}
              />
              <KpiTile
                label="ROOMS"
                value={snapshotDetail?.roomCount}
                footnote={captured}
              />
              <KpiTile
                label="LEVELS"
                value={snapshotDetail?.levelCount}
                footnote={captured}
              />
              <KpiTile
                label="WALLS"
                value={snapshotDetail?.wallCount}
                footnote={captured}
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

              <div className="col-span-2 min-h-0">
                {!hasSnapshots ? (
                  <div className="sc-card p-8 h-full flex items-center justify-center">
                    <div className="sc-prose text-center opacity-70">
                      No snapshots yet. Send one from Revit.
                    </div>
                  </div>
                ) : !snapshotDetail ? (
                  <div className="sc-card p-8 h-full flex items-center justify-center">
                    <div className="sc-prose opacity-60">Loading snapshot…</div>
                  </div>
                ) : (
                  <div className="sc-card flex flex-col h-full">
                    <div className="sc-card-header sc-row-sb">
                      <span className="sc-label">RAW JSON</span>
                      <button
                        className="sc-btn-sm"
                        onClick={() => setJsonExpanded(!jsonExpanded)}
                      >
                        {jsonExpanded ? "Collapse" : "Expand"}
                      </button>
                    </div>
                    {jsonExpanded && (
                      <div
                        className="flex-1 overflow-hidden"
                        style={{
                          borderTop: "1px solid var(--border-default)",
                        }}
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
                    )}
                  </div>
                )}
              </div>
            </div>

            <div
              className="sc-card flex flex-col"
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
                  <div className="sc-prose opacity-60 m-auto">
                    Loading BIM model…
                  </div>
                ) : bimElements.length === 0 ? (
                  <div className="sc-prose opacity-70 m-auto text-center">
                    No BIM elements yet. Push this engagement&apos;s briefing
                    to Revit to populate the 3D viewer.
                  </div>
                ) : (
                  <BimModelViewport
                    elements={bimElements}
                    selectedElementRef={selectedElementRef ?? null}
                  />
                )}
              </div>
            </div>
          </>
        )}

        {tab === "sheets" && (
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
                onClick={() => setTab("snapshots")}
                title={
                  bimElements.length === 0
                    ? "Push this engagement's briefing to Revit to enable the 3D viewer."
                    : "Open the 3D BIM viewer on the Snapshots tab."
                }
              >
                View in 3D
              </button>
            </div>
            <SheetGrid
              snapshotId={selectedSnapshotId}
              onAskClaude={handleAskClaudeAboutSheet}
            />
          </div>
        )}

        {tab === "site" && (
          <SiteTab engagement={engagement} onAddAddress={openEdit} />
        )}

        {tab === "site-context" && (
          <SiteContextTab
            engagement={engagement}
            selectedElementRef={selectedElementRef}
            onClearSelectedElement={() => setSelectedElementRef(null)}
            buildingGlbUrl={defaultBimGlbUrl}
            showBuilding={showBuildingOverlay}
            onToggleShowBuilding={setShowBuildingOverlay}
          />
        )}

        {tab === "submissions" && (
          <SubmissionsTab
            engagementId={engagement.id}
            backfillFilter={backfillFilter}
            onBackfillFilterChange={setBackfillFilter}
            onOpenSubmission={(sid) => setOpenSubmissionId(sid)}
          />
        )}

        {tab === "findings" && (
          <FindingsTab
            engagementId={engagement.id}
            initialSubmissionId={latestSubmissionId}
            onElementRefClick={handleElementRefClick}
          />
        )}

        {tab === "response-tasks" && (
          <ResponseTasksTab engagementId={engagement.id} />
        )}

        {tab === "renders" && (
          <RendersTab
            engagementId={engagement.id}
            defaultGlbUrl={defaultBimGlbUrl}
          />
        )}

        {tab === "settings" && (
          <SettingsTab engagement={engagement} onEdit={openEdit} />
        )}
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
