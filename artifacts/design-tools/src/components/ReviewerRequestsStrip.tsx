import { useState } from "react";
import {
  useListEngagementReviewerRequests,
  getListEngagementReviewerRequestsQueryKey,
  type ReviewerRequest,
  type ReviewerRequestKind,
} from "@workspace/api-client-react";
import { formatActorLabel } from "@workspace/portal-ui";
import { relativeTime } from "../lib/relativeTime";
import { DismissReviewerRequestDialog } from "./DismissReviewerRequestDialog";

/**
 * Wave 2 Sprint D / V1-2 — architect-side queue of pending reviewer-
 * requests filed against an engagement.
 *
 * Mounted on `EngagementDetail.tsx` above the existing tab content
 * so the architect always sees the open queue regardless of which
 * tab is active. Hidden when the queue is empty (zero pending) so
 * an idle engagement doesn't carry empty visual weight.
 *
 * Resolution flow:
 *   - The architect clicks "Dismiss" → DismissReviewerRequestDialog
 *     captures a reason and POSTs `/reviewer-requests/:id/dismiss`.
 *   - The architect runs the underlying domain action (refresh
 *     briefing-source / refresh bim-model / regenerate briefing) on
 *     its own surface — the implicit-resolve hook in
 *     `lib/reviewerRequestResolution.ts` flips the matching pending
 *     request to `resolved` and the strip drops the row on the next
 *     query invalidation.
 *
 * Design choices:
 *   - "Pending only" filter is the only mode V1-2 ships. A future
 *     "Resolved" / "Dismissed" history disclosure can land later
 *     without changing the wire shape (the route already supports
 *     `?status=` filtering).
 *   - The strip queries with `refetchOnWindowFocus` enabled so an
 *     architect coming back to the tab after running an action sees
 *     the queue update without a manual reload — pairs with the
 *     route handler's invalidation hook (which fires on the
 *     architect's next click anyway, but the focus refetch tightens
 *     the loop for the "I just refreshed in another tab" case).
 *   - Mirror the design language of the existing
 *     `BriefingRecentRunsPanel` — single card, same chrome, per-row
 *     muted secondary text.
 *
 * Architect-only by route gate (the `useListEngagementReviewerRequests`
 * hook hits an architect-audience endpoint). The component itself is
 * audience-agnostic in design-tools — surfaces that mount it elsewhere
 * inherit the audience contract from the route.
 */
export interface ReviewerRequestsStripProps {
  engagementId: string;
}

const REQUEST_KIND_LABEL: Record<ReviewerRequestKind, string> = {
  "refresh-briefing-source": "Refresh briefing source",
  "refresh-bim-model": "Refresh BIM model",
  "regenerate-briefing": "Regenerate briefing",
};

export function ReviewerRequestsStrip({
  engagementId,
}: ReviewerRequestsStripProps) {
  const query = useListEngagementReviewerRequests(
    engagementId,
    { status: "pending" },
    {
      query: {
        queryKey: getListEngagementReviewerRequestsQueryKey(engagementId, {
          status: "pending",
        }),
        enabled: !!engagementId,
        refetchOnWindowFocus: true,
      },
    },
  );
  const [dismissTarget, setDismissTarget] = useState<ReviewerRequest | null>(
    null,
  );

  const requests = query.data?.requests ?? [];

  // Empty queue = render nothing. The architect's idle engagement
  // shouldn't carry a "0 pending" placeholder — the strip exists to
  // surface action items, and "no action items" is the normal case.
  if (!query.isLoading && requests.length === 0) return null;

  return (
    <div
      className="sc-card"
      data-testid="reviewer-requests-strip"
      data-engagement-id={engagementId}
      style={{
        marginBottom: 12,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        className="sc-card-header sc-row-sb"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span className="sc-label" style={{ letterSpacing: 0.5 }}>
          REVIEWER REQUESTS
        </span>
        <span
          className="sc-meta"
          data-testid="reviewer-requests-strip-count"
          style={{ color: "var(--text-muted)" }}
        >
          {query.isLoading ? "…" : `${requests.length} pending`}
        </span>
      </div>

      {query.isLoading && requests.length === 0 ? (
        <div
          className="p-4 sc-body"
          style={{ color: "var(--text-muted)", fontSize: 12 }}
        >
          Loading reviewer requests…
        </div>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {requests.map((req) => (
            <li
              key={req.id}
              data-testid={`reviewer-request-row-${req.id}`}
              data-request-kind={req.requestKind}
              style={{
                padding: 12,
                display: "flex",
                flexDirection: "column",
                gap: 6,
                borderTop: "1px solid var(--border-subtle)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {REQUEST_KIND_LABEL[req.requestKind]}
                  </span>
                  <span
                    className="sc-meta"
                    style={{ fontSize: 11, color: "var(--text-muted)" }}
                  >
                    Requested by{" "}
                    <strong style={{ color: "var(--text-secondary)" }}>
                      {formatActorLabel({
                        kind: req.requestedBy.kind,
                        id: req.requestedBy.id,
                        displayName: req.requestedBy.displayName ?? undefined,
                      })}
                    </strong>{" "}
                    · {relativeTime(req.requestedAt)}
                  </span>
                </div>
                <button
                  type="button"
                  className="sc-btn-ghost"
                  onClick={() => setDismissTarget(req)}
                  data-testid={`reviewer-request-dismiss-${req.id}`}
                  style={{
                    fontSize: 11,
                    padding: "2px 10px",
                    borderRadius: 4,
                  }}
                >
                  Dismiss
                </button>
              </div>
              <div
                className="sc-body"
                data-testid={`reviewer-request-reason-${req.id}`}
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                  paddingLeft: 2,
                }}
              >
                {req.reason}
              </div>
              <div
                className="sc-meta"
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                Target: {req.targetEntityType} · {req.targetEntityId}
              </div>
            </li>
          ))}
        </ul>
      )}

      {dismissTarget && (
        <DismissReviewerRequestDialog
          request={dismissTarget}
          isOpen={true}
          onClose={() => setDismissTarget(null)}
        />
      )}
    </div>
  );
}
