/**
 * SubmissionDetailModal — Plan Review's per-submission detail surface.
 *
 * Houses four tabs, surfacing distinct slices of the reviewer
 * workflow:
 *
 *   - `note` (default — Wave 2 Sprint A / Task #305) reproduces the
 *     inline row's data (jurisdiction, status, submitted/responded
 *     timestamps, the architect's outbound note, the reviewer's
 *     reply) in a tighter read-only layout. Default tab so opening
 *     the modal preserves the previous one-click read affordance.
 *   - `engagement-context` (Wave 2 Sprint A / Tasks #305 + #319)
 *     stacks two read-only surfaces:
 *       1. {@link EngagementContextTab} (Task #319) — parcel info
 *          (jurisdiction, address, project type, zoning code, lot
 *          area) + briefing snapshot (Section A executive summary +
 *          generation provenance + the Task #348 "View full
 *          briefing" deep-link back into the engagement page).
 *       2. {@link EngagementContextPanel} (Task #305) from
 *          `@workspace/portal-ui` — the richer architect briefing
 *          snapshot (A–G prior narrative, tier-grouped briefing
 *          sources, recent generation runs) shared with design-tools.
 *          Reviewers no longer have to bounce across to design-tools
 *          for the briefing context.
 *   - `findings` (AIR-2 / Task #310) — auto-generated reviewer
 *     findings with drill-in + accept/reject/override.
 *   - `bim-model` (Wave 2 Sprint B / Task #306) — bim-model +
 *     briefing-divergences feedback loop.
 *
 * The modal supports both *uncontrolled* and *controlled* modes:
 *
 *   - Uncontrolled: callers omit the `tab` / `selectedFindingId` /
 *     `onTabChange` / `onSelectFinding` props and the modal manages
 *     its own tab state, defaulting to `note` (Task #305 spec).
 *   - Controlled (AIR-2 / Task #310): callers thread the URL-derived
 *     tab + drill-in selection through props. This is the path
 *     `EngagementDetail` uses so a paste-link can land directly on
 *     the right submission + tab + drill-in.
 *
 * URL params owned by this modal (when controlled):
 *   - `?submission=<id>` opens the modal
 *   - `?tab=note|findings|bim-model|engagement-context` switches tabs
 *   - `?finding=<atomId>` opens the Findings tab + drill-in panel
 *
 * Modal chrome uses the existing shadcn Dialog primitive (already
 * in plan-review for SubmitToJurisdictionDialog and other surfaces)
 * for keyboard / focus / backdrop semantics. Sized wider than the
 * default Dialog max-width so the divergences table doesn't wrap
 * awkwardly.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  EngagementContextPanel,
  RenderGallery,
  ReviewerComment,
} from "@workspace/portal-ui";
import {
  BriefingPriorNarrativeDiff,
  BriefingPriorSnapshotHeader,
} from "@workspace/briefing-prior-snapshot";
import type {
  EngagementSubmissionSummary,
  SubmissionStatus,
} from "@workspace/api-client-react";
import { BimModelTab } from "./BimModelTab";
import { DecisionTab } from "./DecisionTab";
import { EngagementContextTab } from "./EngagementContextTab";
import { relativeTime } from "../lib/relativeTime";
import { FindingsTab } from "./findings/FindingsTab";
import { PresenceChips } from "./PresenceChips";
import { useSubmissionLiveEvents } from "../lib/useSubmissionLiveEvents";
import {
  useListSubmissionFindings,
  useListSubmissionFindingsGenerationRuns,
  type FindingRun,
} from "../lib/findingsApi";
import type { SubmissionDetailTab } from "../lib/findingUrl";

export interface SubmissionDetailModalProps {
  /**
   * Submission to detail. When `null` the modal is closed and
   * renders nothing — the parent owns selection state.
   */
  submission: EngagementSubmissionSummary | null;
  /**
   * Engagement that owns the submission. Forwarded to the BIM Model
   * tab's bim-model + divergences queries (the divergence audit
   * trail is engagement-scoped, not submission-scoped) and to the
   * Engagement Context tab's parcel-briefing / source / runs queries.
   */
  engagementId: string;
  onClose: () => void;
  /**
   * Controlled tab + drill-in props (AIR-2 / Task #310). When
   * omitted, the modal manages its own tab state internally and
   * defaults to the Note tab (Task #305 spec). When provided, the
   * parent fully controls the active tab and the selected finding,
   * and the modal becomes a thin presentation layer.
   */
  tab?: SubmissionDetailTab;
  selectedFindingId?: string | null;
  onTabChange?: (tab: SubmissionDetailTab) => void;
  onSelectFinding?: (id: string | null) => void;
  /**
   * Wave 2 Sprint D / V1-2 — caller's session audience. Forwarded
   * to {@link EngagementContextPanel} so `BriefingSourceRow` can
   * render the reviewer-side `RequestRefreshAffordance` only for
   * `"internal"` callers. Defaults to `"user"` so existing tests
   * and any non-reviewer-audience consumer keep current behavior.
   */
  audience?: "internal" | "user" | "ai";
  /**
   * Optional callback fired when a sibling row in the Decision tab's
   * revision history is opened. The parent (`EngagementDetail`) wires
   * this to its own modal-state setter so clicking "Open this
   * submission" actually swaps the modal over to the chosen revision
   * — the controlled-modal architecture means a URL-only deep-link
   * would change `?submission=` without flipping `openSubmissionId`.
   * When omitted, the history list falls back to a plain wouter
   * `<Link>` for non-controlled callers / tests.
   */
  onOpenSubmission?: (submissionId: string) => void;
  /** Optional Communicate-button handler. Disabled when omitted. */
  onCommunicate?: () => void;
  /**
   * Optional Decide-button handler. When omitted, the button falls
   * back to switching the modal to the existing Decision tab.
   */
  onDecide?: () => void;
  /**
   * Optional last comment-letter timestamp for the Communicate
   * status pill. When omitted, the pill renders "Never sent".
   */
  lastCommunicatedAt?: string | null;
}

const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

const RUN_STATE_LABELS: Record<FindingRun["state"], string> = {
  pending: "Running",
  completed: "Completed",
  failed: "Failed",
};

export function SubmissionDetailModal({
  submission,
  engagementId,
  onClose,
  tab,
  selectedFindingId = null,
  onTabChange,
  onSelectFinding,
  audience = "user",
  onOpenSubmission,
  onCommunicate,
  onDecide,
  lastCommunicatedAt = null,
}: SubmissionDetailModalProps) {
  const isOpen = submission !== null;

  // PLR-9 — open the live SSE channel while the modal is open and
  // the caller is reviewer-audience. Drives the presence chips in
  // the header AND invalidates the findings list query on
  // finding.{added,accepted,rejected,overridden} so multiple
  // reviewers see each other's accepts/rejects without a refetch.
  const { presence, connected } = useSubmissionLiveEvents(
    submission?.id ?? null,
    isOpen && audience === "internal",
  );

  // Internal tab state for uncontrolled mode. Defaults to the Note
  // tab per Task #305 spec — preserves the one-click read affordance
  // the modal had before the briefing-context + findings tabs
  // landed. The AIR-2 controlled path overrides this via the `tab`
  // prop so URL deep-links still land on whichever tab the link
  // names.
  const [internalTab, setInternalTab] =
    useState<SubmissionDetailTab>("note");
  const isControlled = tab !== undefined;
  const activeTab = isControlled ? tab : internalTab;

  // Task #343 — cross-tab "Show in 3D viewer" jump. The Findings
  // drill-in fires `onShowInViewer(elementRef)`; we switch to the
  // BIM Model tab and forward a `{ ref, nonce }` token so the
  // materializable-elements list can scroll to + highlight the
  // matching row. State is intentionally modal-local rather than
  // URL-synced — the highlight is a transient navigation hint, not
  // a deep-linkable selection.
  //
  // Task #371 — using a monotonically-increasing `nonce` lets a
  // re-click on the SAME finding re-trigger the highlight effect
  // even though `ref` is unchanged. Previously we relied on a
  // wall-clock 2.5s timer to clear the ref so the next click could
  // re-fire; the token approach removes that brittle timing race.
  //
  // The nonce counter is held in a ref so it climbs monotonically
  // across the modal's whole lifetime — even when the highlight is
  // cleared (on tab leave or modal close) and later re-set, the
  // next nonce is still strictly greater than the previous one.
  // That guarantees BimModelTab observes a fresh value on every
  // re-fire, regardless of intervening clears.
  const [highlightToken, setHighlightToken] = useState<{
    ref: string;
    nonce: number;
  } | null>(null);
  const nextHighlightNonceRef = useRef(0);

  // Clear the highlight whenever the reviewer leaves the BIM Model
  // tab so a later return to that tab doesn't surface a stale
  // highlight from a finding they've since closed.
  useEffect(() => {
    if (activeTab !== "bim-model" && highlightToken !== null) {
      setHighlightToken(null);
    }
  }, [activeTab, highlightToken]);

  // Reset whenever the modal closes / opens against a different
  // submission so a re-open lands on a clean BIM Model tab.
  useEffect(() => {
    if (!isOpen) setHighlightToken(null);
  }, [isOpen]);

  const setActiveTab = (next: SubmissionDetailTab) => {
    if (isControlled) {
      onTabChange?.(next);
    } else {
      setInternalTab(next);
    }
  };

  const handleReview = () => {
    setActiveTab("findings");
    if (typeof window !== "undefined") {
      // Defer to rAF so the tab-switch render commits before the
      // lookup; the Run-AI button lives inside FindingsRunsPanel.
      window.requestAnimationFrame(() => {
        const node = document.querySelector<HTMLElement>(
          '[data-testid="findings-runs-generate"]',
        );
        if (node) {
          node.scrollIntoView({ behavior: "smooth", block: "center" });
          node.focus();
        }
      });
    }
  };

  const handleDecide = onDecide ?? (() => setActiveTab("decision"));

  const handleShowInViewer = (elementRef: string) => {
    nextHighlightNonceRef.current += 1;
    setHighlightToken({
      ref: elementRef,
      nonce: nextHighlightNonceRef.current,
    });
    if (isControlled) {
      onTabChange?.("bim-model");
    } else {
      setInternalTab("bim-model");
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        data-testid="submission-detail-modal"
        className="max-w-3xl"
        style={{
          maxHeight: "90vh",
          overflow: "auto",
        }}
      >
        <DialogHeader>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <DialogTitle data-testid="submission-detail-modal-title">
              Submission detail
            </DialogTitle>
            <PresenceChips presence={presence} connected={connected} />
          </div>
          {submission && (
            <DialogDescription data-testid="submission-detail-modal-subtitle">
              <SubmissionSummaryLine submission={submission} />
            </DialogDescription>
          )}
        </DialogHeader>

        {submission && (
          <SubmissionActionHeader
            submission={submission}
            onReview={handleReview}
            onCommunicate={onCommunicate}
            onDecide={handleDecide}
            decideHandlerProvided={onDecide != null}
            lastCommunicatedAt={lastCommunicatedAt}
          />
        )}

        {submission && (
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as SubmissionDetailTab)}
            data-testid="submission-detail-modal-tabs"
          >
            <TabsList data-testid="submission-detail-modal-tabs-list">
              {/*
               * Tab order: Note (default — preserves the previous
               * one-click read affordance), Engagement Context (the
               * read-only briefing snapshot lifted from design-tools),
               * Findings (AIR-2 reviewer findings drill-in), BIM Model
               * (Sprint B's bim-model + divergences feedback loop).
               */}
              <TabsTrigger
                value="note"
                data-testid="submission-detail-modal-tab-note"
              >
                Note
              </TabsTrigger>
              <TabsTrigger
                value="engagement-context"
                data-testid="submission-detail-modal-tab-engagement-context"
              >
                Engagement Context
              </TabsTrigger>
              <TabsTrigger
                value="findings"
                data-testid="submission-tab-findings"
              >
                Findings
              </TabsTrigger>
              <TabsTrigger
                value="renders"
                data-testid="submission-detail-modal-tab-renders"
              >
                Renders
              </TabsTrigger>
              <TabsTrigger
                value="decision"
                data-testid="submission-detail-modal-tab-decision"
              >
                Decision
              </TabsTrigger>
              <TabsTrigger
                value="bim-model"
                data-testid="submission-detail-modal-tab-bim-model"
              >
                BIM Model
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="note"
              data-testid="submission-detail-modal-note-content"
            >
              <NoteTabContent submission={submission} />
            </TabsContent>
            <TabsContent
              value="engagement-context"
              data-testid="submission-detail-modal-engagement-context-pane"
            >
              {/*
               * Stack BOTH engagement-context surfaces inside the
               * same pane — neither side is a strict superset of the
               * other:
               *
               *   - `EngagementContextTab` (Task #319) brings the
               *     parcel-info card (jurisdiction / address /
               *     project type / zoning / lot area), a tight
               *     Section A executive-summary card, and the Task
               *     #348 "View full briefing" deep-link.
               *   - `EngagementContextPanel` (Task #305) brings the
               *     richer A–G prior-narrative disclosure,
               *     tier-grouped briefing sources, and the
               *     recent-runs panel from `@workspace/portal-ui`.
               */}
              <EngagementContextTab
                engagementId={engagementId}
                onNavigateToBriefing={onClose}
              />
              <EngagementContextPanel
                engagementId={engagementId}
                audience={audience}
                renderPriorSnapshotHeader={({
                  runGenerationId,
                  priorNarrative,
                }) => (
                  <BriefingPriorSnapshotHeader
                    runGenerationId={runGenerationId}
                    priorNarrative={priorNarrative}
                    formatGeneratedAt={(raw: string) => ({
                      text: relativeTime(raw),
                      title: new Date(raw).toLocaleString(),
                    })}
                  />
                )}
                renderPriorNarrativeDiff={({
                  runGenerationId,
                  priorNarrative,
                  currentNarrative,
                }) => (
                  <BriefingPriorNarrativeDiff
                    runGenerationId={runGenerationId}
                    priorNarrative={priorNarrative}
                    currentNarrative={currentNarrative}
                  />
                )}
              />
            </TabsContent>
            <TabsContent
              value="findings"
              data-testid="submission-tab-content-findings"
              style={{
                display: "flex",
                flexDirection: "column",
                padding: 0,
              }}
            >
              {/* The Findings tab manages its own padding so the
                  drill-in panel can dock to the right edge of the
                  modal without the outer TabsContent padding pushing
                  it inboard. */}
              <FindingsTab
                submissionId={submission.id}
                selectedFindingId={selectedFindingId}
                onSelectFinding={onSelectFinding ?? (() => {})}
                onShowInViewer={handleShowInViewer}
                audience={audience}
              />
            </TabsContent>
            <TabsContent
              value="renders"
              data-testid="submission-detail-modal-renders-content"
            >
              {/*
               * Reviewer-side renders pane (Task #428). Reuses
               * `RenderGallery` from portal-ui with `canCancel={false}`
               * so the reviewer cannot cancel an architect's in-flight
               * job (the route would 403 anyway). Empty state copy is
               * tuned for the reviewer audience: they don't kick off
               * renders themselves, so the architect-side "Generate
               * your first render" CTA wouldn't make sense here.
               */}
              <div style={{ padding: 16 }}>
                <RenderGallery
                  engagementId={engagementId}
                  canCancel={false}
                  openPreviewInNewTab
                  emptyStateHint="The architect hasn't produced any renders for this engagement yet."
                />
              </div>
            </TabsContent>
            <TabsContent
              value="decision"
              data-testid="submission-detail-modal-decision-content"
            >
              <DecisionTab
                submission={submission}
                engagementId={engagementId}
                audience={audience}
                onOpenSubmission={onOpenSubmission}
              />
            </TabsContent>
            <TabsContent
              value="bim-model"
              data-testid="submission-detail-modal-bim-model-content"
            >
              <BimModelTab
                engagementId={engagementId}
                highlightToken={highlightToken}
                audience={audience}
              />
            </TabsContent>
          </Tabs>
        )}
        {/*
         * Close affordance is the built-in `DialogPrimitive.Close`
         * inside `DialogContent` (the shadcn primitive renders the
         * X-icon button at top-right). We intentionally do not stack
         * a second close button here — the built-in one fires
         * `onOpenChange(false)` which routes through our wrapper's
         * `onClose` callback.
         */}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Unified Review / Communicate / Decide button surface that sits
 * above the modal's tabs. Each button shows a status pill driven
 * off the existing findings / runs / submission-status data.
 */
function SubmissionActionHeader({
  submission,
  onReview,
  onCommunicate,
  onDecide,
  decideHandlerProvided,
  lastCommunicatedAt,
}: {
  submission: EngagementSubmissionSummary;
  onReview: () => void;
  onCommunicate?: () => void;
  onDecide: () => void;
  decideHandlerProvided: boolean;
  lastCommunicatedAt: string | null;
}) {
  const findingsQuery = useListSubmissionFindings(submission.id);
  const runsQuery = useListSubmissionFindingsGenerationRuns(submission.id);
  const findingsCount = findingsQuery.data?.length ?? 0;
  const latestRun = runsQuery.data?.runs?.[0] ?? null;
  const findingsLabel = findingsCount === 1 ? "1 finding" : `${findingsCount} findings`;
  const reviewPill = latestRun
    ? `${findingsLabel} · ${RUN_STATE_LABELS[latestRun.state]}`
    : `${findingsLabel} · Not yet run`;

  const communicatePill = lastCommunicatedAt
    ? `Sent ${relativeTime(lastCommunicatedAt)}`
    : "Never sent";

  const decidePill =
    SUBMISSION_STATUS_LABELS[submission.status] ?? submission.status;

  const communicateDisabled = onCommunicate == null;
  const decideTitle = decideHandlerProvided
    ? "Record verdict"
    : "Open Decision tab";

  return (
    <div
      data-testid="submission-action-header"
      style={{
        display: "flex",
        gap: 8,
        padding: "8px 0",
        borderBottom: "1px solid var(--border-subtle)",
        marginBottom: 4,
      }}
    >
      <ActionHeaderButton
        testId="submission-action-review"
        label="Review"
        statusLabel={reviewPill}
        statusTestId="submission-action-review-status"
        onClick={onReview}
        title="Jump to AI compliance findings"
      />
      <ActionHeaderButton
        testId="submission-action-communicate"
        label="Communicate"
        statusLabel={communicatePill}
        statusTestId="submission-action-communicate-status"
        onClick={onCommunicate ?? (() => {})}
        disabled={communicateDisabled}
        title="Compose comment letter"
      />
      <ActionHeaderButton
        testId="submission-action-decide"
        label="Decide"
        statusLabel={decidePill}
        statusTestId="submission-action-decide-status"
        onClick={onDecide}
        title={decideTitle}
      />
    </div>
  );
}

function ActionHeaderButton({
  testId,
  label,
  statusLabel,
  statusTestId,
  onClick,
  disabled,
  title,
}: {
  testId: string;
  label: string;
  statusLabel: string;
  statusTestId: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 2,
        padding: "8px 12px",
        border: "1px solid var(--border-default)",
        borderRadius: 6,
        background: disabled
          ? "var(--surface-1, transparent)"
          : "var(--surface-1, transparent)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        textAlign: "left",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
        {label}
      </span>
      <span
        data-testid={statusTestId}
        style={{ fontSize: 11, color: "var(--text-secondary)" }}
      >
        {statusLabel}
      </span>
    </button>
  );
}

function SubmissionSummaryLine({
  submission,
}: {
  submission: EngagementSubmissionSummary;
}): ReactNode {
  const jurisdiction =
    submission.jurisdiction ?? "Jurisdiction not recorded";
  const absolute = new Date(submission.submittedAt).toLocaleString();
  return (
    <span title={absolute}>
      Submitted to {jurisdiction} · {relativeTime(submission.submittedAt)}
    </span>
  );
}

/**
 * Read-only reproduction of the row's note + reviewer reply data in
 * a tighter layout. The Note tab is the default so opening the
 * modal mirrors the previous "click a row to read the note"
 * affordance — reviewers who only want the note never pay the cost
 * of mounting the briefing panel or BIM model tab.
 */
function NoteTabContent({
  submission,
}: {
  submission: EngagementSubmissionSummary;
}) {
  const hasResponse =
    submission.status !== "pending" && submission.respondedAt != null;
  return (
    <div
      data-testid="submission-detail-note-pane"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: 16,
      }}
    >
      <section
        data-testid="submission-detail-meta"
        style={{
          display: "grid",
          gridTemplateColumns: "max-content 1fr",
          rowGap: 6,
          columnGap: 12,
          fontSize: 13,
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>Jurisdiction</span>
        <span style={{ color: "var(--text-primary)" }}>
          {submission.jurisdiction ?? "Not recorded"}
        </span>
        <span style={{ color: "var(--text-muted)" }}>Status</span>
        <span style={{ color: "var(--text-primary)" }}>
          {SUBMISSION_STATUS_LABELS[submission.status] ?? submission.status}
        </span>
        <span style={{ color: "var(--text-muted)" }}>Submitted</span>
        <span
          style={{ color: "var(--text-primary)" }}
          title={new Date(submission.submittedAt).toLocaleString()}
        >
          {relativeTime(submission.submittedAt)}
        </span>
        {hasResponse && (
          <>
            <span style={{ color: "var(--text-muted)" }}>Responded</span>
            <span
              style={{ color: "var(--text-primary)" }}
              title={new Date(submission.respondedAt!).toLocaleString()}
            >
              {relativeTime(submission.respondedAt)}
            </span>
          </>
        )}
      </section>

      {submission.reviewerComment && (
        <section data-testid="submission-detail-reviewer-comment">
          <div
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--text-muted)",
              marginBottom: 4,
            }}
          >
            Reviewer comment
          </div>
          <ReviewerComment
            submissionId={submission.id}
            comment={submission.reviewerComment}
          />
        </section>
      )}

      <section data-testid="submission-detail-note">
        <div
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            color: "var(--text-muted)",
            marginBottom: 4,
          }}
        >
          Submission note
        </div>
        {submission.note ? (
          <div
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 13,
              color: "var(--text-primary)",
              lineHeight: 1.5,
            }}
          >
            {submission.note}
          </div>
        ) : (
          <div
            data-testid="submission-detail-no-note"
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              fontStyle: "italic",
            }}
          >
            No note was attached to this submission.
          </div>
        )}
      </section>
    </div>
  );
}
