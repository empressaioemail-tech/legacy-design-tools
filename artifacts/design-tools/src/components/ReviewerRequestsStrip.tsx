import { useEffect, useMemo, useRef, useState } from "react";
import {
  useListEngagementReviewerRequests,
  getListEngagementReviewerRequestsQueryKey,
  type ReviewerRequest,
  type ReviewerRequestKind,
  type FindingActor,
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

/**
 * Architect-side disclosure of reviewer-requests that have already
 * closed (resolved by the underlying domain action OR dismissed by an
 * architect). Closes the gap from Task #423 — once a request leaves
 * the pending strip, this list is the only way for the architect to
 * look back at what the request said, who closed it, when, and the
 * dismissal reason. Collapsed by default and self-hides when there is
 * no history to show.
 */
export interface ReviewerRequestsHistoryProps {
  engagementId: string;
}

type HistoryItem = ReviewerRequest;

export function ReviewerRequestsHistory({
  engagementId,
}: ReviewerRequestsHistoryProps) {
  const dismissedQuery = useListEngagementReviewerRequests(
    engagementId,
    { status: "dismissed" },
    {
      query: {
        queryKey: getListEngagementReviewerRequestsQueryKey(engagementId, {
          status: "dismissed",
        }),
        enabled: !!engagementId,
        refetchOnWindowFocus: true,
      },
    },
  );
  const resolvedQuery = useListEngagementReviewerRequests(
    engagementId,
    { status: "resolved" },
    {
      query: {
        queryKey: getListEngagementReviewerRequestsQueryKey(engagementId, {
          status: "resolved",
        }),
        enabled: !!engagementId,
        refetchOnWindowFocus: true,
      },
    },
  );

  const [open, setOpen] = useState(false);

  const isLoading = dismissedQuery.isLoading || resolvedQuery.isLoading;

  const items = useMemo<HistoryItem[]>(() => {
    const merged: HistoryItem[] = [
      ...(dismissedQuery.data?.requests ?? []),
      ...(resolvedQuery.data?.requests ?? []),
    ];
    merged.sort((a, b) => {
      const aT = a.dismissedAt ?? a.resolvedAt ?? a.updatedAt;
      const bT = b.dismissedAt ?? b.resolvedAt ?? b.updatedAt;
      return new Date(bT).getTime() - new Date(aT).getTime();
    });
    return merged;
  }, [dismissedQuery.data, resolvedQuery.data]);

  // Self-hide when there is nothing to disclose. We still render
  // during the initial load so the architect sees the disclosure
  // affordance immediately on arrival rather than having it pop in
  // after the network settles.
  if (!isLoading && items.length === 0) return null;

  return (
    <div
      className="sc-card"
      data-testid="reviewer-requests-history"
      data-engagement-id={engagementId}
      style={{
        marginBottom: 12,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <button
        type="button"
        className="sc-card-header sc-row-sb"
        data-testid="reviewer-requests-history-toggle"
        aria-expanded={open}
        aria-controls={`reviewer-requests-history-panel-${engagementId}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "transparent",
          border: "none",
          width: "100%",
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: 12,
          color: "inherit",
        }}
      >
        <span className="sc-label" style={{ letterSpacing: 0.5 }}>
          RESOLVED / DISMISSED HISTORY
        </span>
        <span
          className="sc-meta"
          data-testid="reviewer-requests-history-count"
          style={{ color: "var(--text-muted)", display: "inline-flex", gap: 6 }}
        >
          <span>{isLoading ? "…" : `${items.length} closed`}</span>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        </span>
      </button>

      {open && (
        <div
          id={`reviewer-requests-history-panel-${engagementId}`}
          data-testid="reviewer-requests-history-panel"
        >
          {isLoading && items.length === 0 ? (
            <div
              className="p-4 sc-body"
              data-testid="reviewer-requests-history-loading"
              style={{
                color: "var(--text-muted)",
                fontSize: 12,
                padding: 12,
                borderTop: "1px solid var(--border-subtle)",
              }}
            >
              Loading history…
            </div>
          ) : (
            <ul
              data-testid="reviewer-requests-history-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {items.map((req) => {
                const isDismissed = req.status === "dismissed";
                const closedAt = isDismissed
                  ? req.dismissedAt
                  : req.resolvedAt;
                const closedActor: FindingActor | null = isDismissed
                  ? req.dismissedBy ?? null
                  : null;
                const closedByLabel = closedActor
                  ? formatActorLabel({
                      kind: closedActor.kind,
                      id: closedActor.id,
                      displayName: closedActor.displayName ?? undefined,
                    })
                  : "the underlying refresh action";
                return (
                  <li
                    key={req.id}
                    data-testid={`reviewer-request-history-row-${req.id}`}
                    data-status={req.status}
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
                        data-testid={`reviewer-request-history-status-${req.id}`}
                        className="sc-meta"
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 999,
                          background: isDismissed
                            ? "var(--bg-input)"
                            : "rgba(34,197,94,0.15)",
                          color: isDismissed
                            ? "var(--text-secondary)"
                            : "#16a34a",
                          border: "1px solid var(--border-subtle)",
                          textTransform: "capitalize",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {req.status}
                      </span>
                    </div>
                    <div
                      className="sc-meta"
                      data-testid={`reviewer-request-history-closed-${req.id}`}
                      style={{ fontSize: 11, color: "var(--text-muted)" }}
                    >
                      {isDismissed ? "Dismissed" : "Resolved"} by{" "}
                      <strong style={{ color: "var(--text-secondary)" }}>
                        {closedByLabel}
                      </strong>{" "}
                      · {relativeTime(closedAt)}
                    </div>
                    <div
                      className="sc-body"
                      data-testid={`reviewer-request-history-reason-${req.id}`}
                      style={{
                        fontSize: 12,
                        color: "var(--text-secondary)",
                        whiteSpace: "pre-wrap",
                        paddingLeft: 2,
                      }}
                    >
                      {req.reason}
                    </div>
                    {isDismissed && req.dismissalReason && (
                      <div
                        data-testid={`reviewer-request-history-dismissal-reason-${req.id}`}
                        className="sc-meta"
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          fontStyle: "italic",
                        }}
                      >
                        Dismissal reason: {req.dismissalReason}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
