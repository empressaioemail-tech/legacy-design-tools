import {
  useListEngagementReviewerRequests,
  getListEngagementReviewerRequestsQueryKey,
  type ReviewerRequestKind,
} from "@workspace/api-client-react";

/**
 * Task #429 — shared per-engagement reviewer-requests pending-state
 * lookup.
 *
 * The three reviewer-side Request-Refresh affordances
 * (`refresh-briefing-source` on each `BriefingSourceRow`,
 * `refresh-bim-model` on the BIM model summary card,
 * `regenerate-briefing` on the briefing panel) all need to disable
 * themselves while a matching `pending` reviewer-request is on the
 * engagement. Filing a duplicate while the architect already has the
 * open ask in front of them adds noise without changing the
 * outcome — the architect either resolves the request implicitly
 * (by running the action) or dismisses it explicitly with a reason.
 *
 * Bind everything to ONE per-engagement query so multiple affordances
 * on the same page share the cache:
 *   - identical `queryKey` from `getListEngagementReviewerRequestsQueryKey`
 *     (with `?status=pending` filter) — react-query dedups in-flight
 *     fetches and serves cached data to follow-on consumers;
 *   - returns booleans rather than the row so individual affordances
 *     don't re-render when an unrelated row's reason changes.
 *
 * The query is gated on `enabled` so callers can keep the affordance
 * tree mounted (e.g. inside a stale-row branch) without firing the
 * fetch when the affordance itself is hidden by a different gate
 * (audience, freshness, etc.).
 */
export function useReviewerRequestIsPending(
  engagementId: string,
  requestKind: ReviewerRequestKind,
  targetEntityId: string,
  enabled: boolean = true,
): boolean {
  const params = { status: "pending" as const };
  const query = useListEngagementReviewerRequests(engagementId, params, {
    query: {
      queryKey: getListEngagementReviewerRequestsQueryKey(engagementId, params),
      enabled: enabled && !!engagementId,
    },
  });
  const requests = query.data?.requests ?? [];
  return requests.some(
    (r) =>
      r.requestKind === requestKind && r.targetEntityId === targetEntityId,
  );
}
