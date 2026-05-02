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
}

export function RequestRefreshAffordance({
  engagementId,
  requestKind,
  targetEntityType,
  targetEntityId,
  targetLabel,
  onCreated,
}: RequestRefreshAffordanceProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="sc-btn-ghost"
        onClick={() => setOpen(true)}
        data-testid={`request-refresh-affordance-${targetEntityId}`}
        data-request-kind={requestKind}
        style={{
          fontSize: 11,
          padding: "2px 8px",
          borderRadius: 4,
          alignSelf: "flex-start",
        }}
      >
        Request refresh
      </button>
      <RequestRefreshDialog
        engagementId={engagementId}
        requestKind={requestKind}
        targetEntityType={targetEntityType}
        targetEntityId={targetEntityId}
        targetLabel={targetLabel}
        isOpen={open}
        onClose={() => setOpen(false)}
        onCreated={(req) => {
          onCreated?.(req);
        }}
      />
    </>
  );
}
