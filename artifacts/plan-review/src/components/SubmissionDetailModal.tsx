/**
 * SubmissionDetailModal — Plan Review's per-submission detail surface.
 *
 * Houses four tabs, surfacing distinct slices of the reviewer
 * workflow:
 *
 *   - `bim-model` (Wave 2 Sprint B / Task #306) — bim-model +
 *     briefing-divergences feedback loop.
 *   - `engagement-context` (Task #319) — read-only briefing snapshot
 *     (Section A executive summary + generation provenance) and the
 *     parcel info (jurisdiction, address, project type, zoning code,
 *     lot area).
 *   - `note` (AIR-2 / Task #310) — minimal package-note view
 *     (jurisdiction, status, submitted-at, reviewer comment,
 *     submission note).
 *   - `findings` (AIR-2 / Task #310) — auto-generated reviewer
 *     findings with drill-in + accept/reject/override.
 *
 * The modal supports both *uncontrolled* and *controlled* modes:
 *
 *   - Uncontrolled (Sprint B / Task #306 default): callers omit the
 *     `tab` / `selectedFindingId` / `onTabChange` / `onSelectFinding`
 *     props and the modal manages its own tab state, defaulting to
 *     the BIM Model tab. This is what `SubmissionDetailModal.test`
 *     exercises today.
 *   - Controlled (AIR-2 / Task #310): callers thread the URL-derived
 *     tab + drill-in selection through props. This is the path
 *     `EngagementDetail` uses so a paste-link can land directly on
 *     the right submission + tab + drill-in.
 *
 * URL params owned by this modal (when controlled):
 *   - `?submission=<id>` opens the modal
 *   - `?tab=findings|bim-model|engagement-context` switches tabs
 *   - `?finding=<atomId>` opens the Findings tab + drill-in panel
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
import { BimModelTab } from "./BimModelTab";
import { EngagementContextTab } from "./EngagementContextTab";
import type { EngagementSubmissionSummary } from "@workspace/api-client-react";
import { ReviewerComment } from "@workspace/portal-ui";
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
   * tab's bim-model + divergences queries — the divergence audit
   * trail is engagement-scoped, not submission-scoped, so a single
   * submission detail surfaces the engagement's whole bim-model
   * history.
   */
  engagementId: string;
  onClose: () => void;
  /**
   * Controlled tab + drill-in props (AIR-2 / Task #310). When
   * omitted, the modal manages its own tab state internally and
   * defaults to BIM Model (Sprint B / Task #306). When provided,
   * the parent fully controls the active tab and the selected
   * finding, and the modal becomes a thin presentation layer.
   */
  tab?: SubmissionDetailTab;
  selectedFindingId?: string | null;
  onTabChange?: (tab: SubmissionDetailTab) => void;
  onSelectFinding?: (id: string | null) => void;
}

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

  // Internal tab state for uncontrolled mode. Defaults to the BIM
  // Model tab to preserve Sprint B / Task #306 behavior — the AIR-2
  // controlled path overrides this via the `tab` prop.
  const [internalTab, setInternalTab] =
    useState<SubmissionDetailTab>("bim-model");
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
              <TabsTrigger
                value="bim-model"
                data-testid="submission-detail-modal-tab-bim-model"
              >
                BIM Model
              </TabsTrigger>
              <TabsTrigger
                value="engagement-context"
                data-testid="submission-detail-modal-tab-engagement-context"
              >
                Engagement Context
              </TabsTrigger>
              <TabsTrigger value="note" data-testid="submission-tab-note">
                Note
              </TabsTrigger>
              <TabsTrigger
                value="findings"
                data-testid="submission-tab-findings"
              >
                Findings
              </TabsTrigger>
            </TabsList>
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
            <TabsContent
              value="engagement-context"
              data-testid="submission-detail-modal-engagement-context-pane"
            >
              {/*
               * Task #319 — Sprint A's "Engagement Context" tab. The
               * pane surfaces the briefing snapshot (Section A
               * executive summary + generation provenance) and the
               * parcel info (jurisdiction, address, project type,
               * zoning code, lot area) so the reviewer has the context
               * they need to frame the submission without bouncing to
               * the engagement page or the design-tools artifact.
               */}
              <EngagementContextTab
                engagementId={engagementId}
                onNavigateToBriefing={onClose}
              />
            </TabsContent>
            <TabsContent
              value="note"
              data-testid="submission-tab-content-note"
            >
              <NoteTabContent submission={submission} />
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

function NoteTabContent({
  submission,
}: {
  submission: EngagementSubmissionSummary;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 720,
      }}
    >
      <FieldRow label="Status" value={submission.status} />
      <FieldRow
        label="Jurisdiction"
        value={submission.jurisdiction ?? "Not recorded"}
      />
      <FieldRow
        label="Submitted at"
        value={new Date(submission.submittedAt).toLocaleString()}
      />
      {submission.respondedAt && (
        <FieldRow
          label="Responded at"
          value={new Date(submission.respondedAt).toLocaleString()}
        />
      )}
      {submission.reviewerComment && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="sc-label" style={{ fontSize: 11 }}>
            REVIEWER COMMENT
          </span>
          <ReviewerComment
            submissionId={submission.id}
            comment={submission.reviewerComment}
          />
        </div>
      )}
      {submission.note ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className="sc-label" style={{ fontSize: 11 }}>
            SUBMISSION NOTE
          </span>
          <div
            data-testid="submission-detail-note"
            style={{
              background: "var(--bg-default)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              padding: 10,
              fontSize: 13,
              whiteSpace: "pre-wrap",
              color: "var(--text-primary)",
            }}
          >
            {submission.note}
          </div>
        </div>
      ) : (
        <div
          className="sc-body opacity-60"
          data-testid="submission-detail-no-note"
          style={{ fontSize: 12 }}
        >
          No submission note recorded.
        </div>
      )}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        alignItems: "baseline",
      }}
    >
      <span
        className="sc-label"
        style={{ fontSize: 11, minWidth: 120, color: "var(--text-secondary)" }}
      >
        {label.toUpperCase()}
      </span>
      <span style={{ fontSize: 13, color: "var(--text-primary)" }}>
        {value}
      </span>
    </div>
  );
}
