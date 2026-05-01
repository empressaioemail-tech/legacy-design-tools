import type { ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { BimModelTab } from "./BimModelTab";
import type { EngagementSubmissionSummary } from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";

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
}

/**
 * Plan-review's submission detail modal (Wave 2 Sprint B / Task
 * #306). Houses the new "BIM Model" tab that surfaces the bim-model
 * + briefing-divergences feedback loop to the reviewer audience.
 *
 * The modal is structured around Radix Tabs so Sprint A's
 * "Engagement Context" tab can land alongside the BIM Model tab in
 * a follow-up commit without restructuring the modal shell. The
 * BIM Model tab is the only tab shipped here so the tab strip
 * still renders (giving Sprint A a stable insertion point) but
 * defaults to BIM Model since it's the only choice.
 *
 * Modal chrome uses the existing shadcn Dialog primitive (already
 * in plan-review for SubmitToJurisdictionDialog and other surfaces)
 * for keyboard / focus / backdrop semantics. Sized wider than the
 * default Dialog max-width so the divergences table doesn't wrap
 * awkwardly.
 */
export function SubmissionDetailModal({
  submission,
  engagementId,
  onClose,
}: SubmissionDetailModalProps) {
  const isOpen = submission !== null;

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
            defaultValue="bim-model"
            data-testid="submission-detail-modal-tabs"
          >
            <TabsList data-testid="submission-detail-modal-tabs-list">
              {/*
               * BIM Model is Sprint B's tab. Sprint A's "Engagement
               * Context" tab will land alongside it as a sibling
               * <TabsTrigger> + <TabsContent> pair without
               * restructuring this modal — the wrapping <Tabs>
               * already accommodates additional values.
               */}
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
            </TabsList>
            <TabsContent
              value="bim-model"
              data-testid="submission-detail-modal-bim-model-content"
            >
              <BimModelTab engagementId={engagementId} />
            </TabsContent>
            <TabsContent
              value="engagement-context"
              data-testid="submission-detail-modal-engagement-context-pane"
            >
              {/*
               * Sprint A placeholder: the briefing snapshot / parcel
               * context view will land here in a follow-up. Rendered
               * today so the Tabs shell ships with both panes wired
               * (and so reviewers see *something* explanatory rather
               * than an inert tab).
               */}
              <div
                className="sc-body"
                style={{
                  padding: 16,
                  fontSize: 13,
                  color: "var(--text-muted)",
                }}
              >
                The engagement-context view (briefing snapshot, parcel
                info) is coming in a follow-up.
              </div>
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
