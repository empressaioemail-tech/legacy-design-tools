import { useEffect, useMemo, useRef, useState } from "react";
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
 * Architect-side queue of pending reviewer-requests filed against an
 * engagement. Hidden when there are zero pending requests (and no
 * transient confirmation pill in flight). Surfaces a "Request
 * dismissed" pill after a user dismiss and a "Resolved by your
 * refresh" pill when the polled list shrinks because the backend
 * implicit-resolved a request.
 */
export interface ReviewerRequestsStripProps {
  engagementId: string;
}

const REQUEST_KIND_LABEL: Record<ReviewerRequestKind, string> = {
  "refresh-briefing-source": "Refresh briefing source",
  "refresh-bim-model": "Refresh BIM model",
  "regenerate-briefing": "Regenerate briefing",
};

const PILL_VISIBLE_MS = 5000;
// How long an architect-driven dismiss is remembered for the
// implicit-resolve diff. Comfortably longer than PILL_VISIBLE_MS so a
// slow server confirmation can't race the diff into a false-positive
// "resolved by your refresh" pill.
const RECENT_DISMISS_MEMORY_MS = 15_000;

type StripPill =
  | { kind: "dismissed"; at: number }
  | { kind: "implicit-resolved"; count: number; at: number };

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
  const [pill, setPill] = useState<StripPill | null>(null);

  // IDs the architect just dismissed (id → timestamp). Set inside
  // the dialog's onMutate via `markUserDismissed` BEFORE the
  // optimistic cache write so the diff effect, which runs on the
  // next render, sees the mark.
  const recentlyDismissedRef = useRef<Map<string, number>>(new Map());
  const previousIdsRef = useRef<Set<string> | null>(null);

  const requests = query.data?.requests ?? [];

  const currentIds = useMemo(
    () => new Set(requests.map((r) => r.id)),
    [requests],
  );

  // Detect backend implicit-resolves: rows that vanished from the
  // pending list without an in-strip user dismiss were closed by the
  // route's implicit-resolve hook.
  useEffect(() => {
    if (query.isLoading) return;
    const prev = previousIdsRef.current;
    if (prev === null) {
      previousIdsRef.current = currentIds;
      return;
    }
    const removed: string[] = [];
    for (const id of prev) {
      if (!currentIds.has(id)) removed.push(id);
    }
    previousIdsRef.current = currentIds;
    if (removed.length === 0) return;

    const now = Date.now();
    const fresh = new Map<string, number>();
    for (const [id, ts] of recentlyDismissedRef.current) {
      if (now - ts < RECENT_DISMISS_MEMORY_MS) fresh.set(id, ts);
    }
    recentlyDismissedRef.current = fresh;

    const externallyResolved = removed.filter((id) => !fresh.has(id));
    if (externallyResolved.length === 0) return;

    setPill({
      kind: "implicit-resolved",
      count: externallyResolved.length,
      at: now,
    });
  }, [currentIds, query.isLoading]);

  useEffect(() => {
    if (!pill) return;
    const remaining = Math.max(0, PILL_VISIBLE_MS - (Date.now() - pill.at));
    const timer = window.setTimeout(() => {
      setPill((current) => (current === pill ? null : current));
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [pill]);

  const markUserDismissed = (req: ReviewerRequest) => {
    recentlyDismissedRef.current.set(req.id, Date.now());
  };

  const handleDismissed = (_req: ReviewerRequest) => {
    setPill({ kind: "dismissed", at: Date.now() });
  };

  // Stay mounted while a pill is visible OR a dismiss dialog is
  // open. Keeping the dialog mounted matters for last-row optimistic
  // dismisses: `requests` goes empty between onMutate and onSuccess,
  // and unmounting the dialog mid-flight would strand a server error
  // with no inline surface to render to.
  if (
    !query.isLoading &&
    requests.length === 0 &&
    !pill &&
    !dismissTarget
  ) {
    return null;
  }

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
          gap: 8,
        }}
      >
        <span className="sc-label" style={{ letterSpacing: 0.5 }}>
          REVIEWER REQUESTS
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          {pill && (
            <span
              data-testid={`reviewer-requests-strip-pill-${pill.kind}`}
              role="status"
              aria-live="polite"
              className="sc-meta"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                borderRadius: 999,
                background:
                  pill.kind === "dismissed"
                    ? "var(--bg-input)"
                    : "rgba(34,197,94,0.15)",
                color:
                  pill.kind === "dismissed"
                    ? "var(--text-secondary)"
                    : "#16a34a",
                border: "1px solid var(--border-subtle)",
                whiteSpace: "nowrap",
              }}
            >
              {pill.kind === "dismissed"
                ? "Request dismissed"
                : pill.count === 1
                  ? "1 request resolved by your refresh"
                  : `${pill.count} requests resolved by your refresh`}
            </span>
          )}
          <span
            className="sc-meta"
            data-testid="reviewer-requests-strip-count"
            style={{ color: "var(--text-muted)" }}
          >
            {query.isLoading ? "…" : `${requests.length} pending`}
          </span>
        </div>
      </div>

      {query.isLoading && requests.length === 0 ? (
        <div
          className="p-4 sc-body"
          style={{ color: "var(--text-muted)", fontSize: 12 }}
        >
          Loading reviewer requests…
        </div>
      ) : requests.length === 0 ? null : (
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
          onDismissStarted={markUserDismissed}
          onDismissed={handleDismissed}
        />
      )}
    </div>
  );
}
