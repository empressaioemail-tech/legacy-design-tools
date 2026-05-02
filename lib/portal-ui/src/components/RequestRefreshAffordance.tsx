import { useState } from "react";
import {
  type ReviewerRequestKind,
  type ReviewerRequestTargetType,
  type ReviewerRequest,
} from "@workspace/api-client-react";
import { RequestRefreshDialog } from "./RequestRefreshDialog";

/**
 * Wave 2 Sprint D / V1-2 — small inline button surfacing the
 * reviewer-side "Request refresh" flow on a stale row.
 *
 * Mirrors the architect's "Re-run this layer" action ergonomics
 * (Task #255) — same button shape, same neighborhood inside
 * `BriefingSourceRow`, different POST endpoint. The architect
 * action mutates directly; the reviewer action only files an ask.
 *
 * Caller owns the gate — render this component only when
 * `freshness.verdict.isStale === true` AND `audience === "internal"`.
 * The component itself does not check audience or freshness so the
 * gate stays close to the row's data and the e2e tests can drive
 * the gate explicitly.
 *
 * Three call shapes (one per `requestKind`):
 *   - `refresh-briefing-source` — reviewer-side mirror of "Re-run
 *     this layer". `targetEntityId` is the briefing-source row UUID.
 *   - `refresh-bim-model` — `targetEntityId` is the bim-model row UUID.
 *   - `regenerate-briefing` — `targetEntityId` is the engagement id
 *     (the parcel-briefing atom anchors atom-history events on
 *     engagementId; the reviewer-request must match for the
 *     implicit-resolve hook to fire).
 *
 * Task #429 — when the parent passes `pending={true}` (i.e. the
 * per-engagement reviewer-requests list already carries a `pending`
 * row matching this `(requestKind, targetEntityId)` pair) the
 * button disables itself and re-labels to "Refresh requested".
 * This prevents the reviewer from filing a duplicate while the
 * architect has the open ask in front of them. The pending lookup
 * lives at the parent so multiple call sites against the same
 * engagement share one query (helper hook
 * `useReviewerRequestIsPending` in `lib/reviewerRequestPending.ts`).
 */
export interface RequestRefreshAffordanceProps {
  engagementId: string;
  requestKind: ReviewerRequestKind;
  targetEntityType: ReviewerRequestTargetType;
  targetEntityId: string;
  /**
   * Short label shown inside the dialog body so the reviewer sees
   * what they're filing against (e.g. layer kind, model name).
   */
  targetLabel: string;
  /**
   * Optional — fires after a successful create. Parent uses this
   * to flash a transient "Refresh requested" pill on the row,
   * mirroring the architect-side "Refreshed just now" pill.
   */
  onCreated?: (request: ReviewerRequest) => void;
  /**
   * Task #429 — when `true`, the engagement already has a pending
   * reviewer-request matching `(requestKind, targetEntityId)`. The
   * button renders disabled with a "Refresh requested" label and a
   * `data-pending="true"` attribute so e2e tests and CSS can pin
   * the bound state. Defaults to `false` so the architect-side and
   * other callers that don't bind to the list see the existing
   * one-click "Request refresh" behavior.
   */
  pending?: boolean;
}

export function RequestRefreshAffordance({
  engagementId,
  requestKind,
  targetEntityType,
  targetEntityId,
  targetLabel,
  onCreated,
  pending = false,
}: RequestRefreshAffordanceProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sc-btn-ghost"
        onClick={() => {
          if (pending) return;
          setOpen(true);
        }}
        disabled={pending}
        aria-disabled={pending || undefined}
        data-testid={`request-refresh-affordance-${targetEntityId}`}
        data-request-kind={requestKind}
        data-pending={pending ? "true" : undefined}
        title={
          pending
            ? "A refresh request is already pending for this target. The architect will resolve or dismiss it."
            : undefined
        }
        style={{
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 4,
          alignSelf: "flex-start",
          opacity: pending ? 0.6 : 1,
          cursor: pending ? "not-allowed" : undefined,
        }}
      >
        {pending ? "Refresh requested" : "Request refresh"}
      </button>
      <RequestRefreshDialog
        engagementId={engagementId}
        requestKind={requestKind}
        targetEntityType={targetEntityType}
        targetEntityId={targetEntityId}
        targetLabel={targetLabel}
        isOpen={open && !pending}
        onClose={() => setOpen(false)}
        onCreated={(req) => {
          onCreated?.(req);
        }}
      />
    </>
  );
}
