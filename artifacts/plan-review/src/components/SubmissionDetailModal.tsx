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
import { useEffect, useState, type ReactNode } from "react";
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
  ReviewerComment,
} from "@workspace/portal-ui";
import { BriefingPriorSnapshotHeader } from "@workspace/briefing-prior-snapshot";
import type {
  EngagementSubmissionSummary,
  SubmissionStatus,
} from "@workspace/api-client-react";
import { BimModelTab } from "./BimModelTab";
import { EngagementContextTab } from "./EngagementContextTab";
import { relativeTime } from "../lib/relativeTime";
import { FindingsTab } from "./findings/FindingsTab";
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
}

const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  pending: "Pending",
  approved: "Approved",
  corrections_requested: "Corrections requested",
  rejected: "Rejected",
};

export function SubmissionDetailModal({
  submission,
  engagementId,
  onClose,
  tab,
  selectedFindingId = null,
  onTabChange,
  onSelectFinding,
}: SubmissionDetailModalProps) {
  const isOpen = submission !== null;

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
  // BIM Model tab and forward the elementRef so the
  // materializable-elements list can scroll to + visually pulse the
  // matching row. State is intentionally modal-local rather than
  // URL-synced — the highlight is a transient navigation hint, not
  // a deep-linkable selection.
  const [highlightedElementRef, setHighlightedElementRef] = useState<
    string | null
  >(null);

  // Clear the highlight whenever the reviewer leaves the BIM Model
  // tab so a later return to that tab doesn't surface a stale pulse
  // from a finding they've since closed.
  useEffect(() => {
    if (activeTab !== "bim-model" && highlightedElementRef !== null) {
      setHighlightedElementRef(null);
    }
  }, [activeTab, highlightedElementRef]);

  // Reset whenever the modal closes / opens against a different
  // submission so a re-open lands on a clean BIM Model tab.
  useEffect(() => {
    if (!isOpen) setHighlightedElementRef(null);
  }, [isOpen]);

  const handleShowInViewer = (elementRef: string) => {
    setHighlightedElementRef(elementRef);
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
          <DialogTitle data-testid="submission-detail-modal-title">
            Submission detail
          </DialogTitle>
          {submission && (
            <DialogDescription data-testid="submission-detail-modal-subtitle">
              <SubmissionSummaryLine submission={submission} />
            </DialogDescription>
          )}
        </DialogHeader>

        {submission && (
          <Tabs
            value={activeTab}
            onValueChange={(v) => {
              const next = v as SubmissionDetailTab;
              if (isControlled) {
                onTabChange?.(next);
              } else {
                setInternalTab(next);
              }
            }}
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
              />
            </TabsContent>
            <TabsContent
              value="bim-model"
              data-testid="submission-detail-modal-bim-model-content"
            >
              <BimModelTab
                engagementId={engagementId}
                highlightElementRef={highlightedElementRef}
                onHighlightConsumed={() => setHighlightedElementRef(null)}
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
