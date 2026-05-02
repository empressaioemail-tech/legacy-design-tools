/**
 * Implicit-resolve hook for the reviewer-request surface — Wave 2
 * Sprint D / V1-2.
 *
 * The reviewer-request lifecycle is:
 *
 *   pending  →  dismissed   (architect explicitly rejects)
 *   pending  →  resolved    (architect runs the underlying domain
 *                            action — refresh briefing-source, refresh
 *                            bim-model, regenerate briefing — which
 *                            emits its own atom-history event, and
 *                            this helper flips the matching pending
 *                            request rows onto that event id)
 *
 * The hook is wired into the three domain actions' emit sites:
 *
 *   - `briefing-source.refreshed` (added to `routes/generateLayers.ts`
 *     in V1-2 — the forceRefresh path now emits `.refreshed` instead
 *     of `.fetched`; first-pull still emits `.fetched`)
 *   - `bim-model.refreshed`       (`routes/bimModels.ts`)
 *   - `parcel-briefing.regenerated` (`routes/parcelBriefings.ts`)
 *
 * Each emit site calls
 * {@link resolveMatchingReviewerRequests} after the atom-history
 * event lands, passing the freshly-emitted event's id and the target
 * tuple. The helper:
 *   1. SELECTs every `pending` reviewer-request whose
 *      `(target_entity_type, target_entity_id)` matches the action's
 *      target.
 *   2. UPDATEs each to `status = 'resolved'`,
 *      `resolved_at = now()`, `triggered_action_event_id = <id>`.
 *   3. Logs the resolution (request id, action event id, kind) for
 *      audit-trail visibility — operators tailing the api-server log
 *      can see "request X resolved by action Y" without joining
 *      tables.
 *
 * Best-effort by the same contract as the engagementEvents /
 * reviewerAnnotations emit helpers: a transient DB error or query
 * failure is caught + logged and does NOT fail the in-flight HTTP
 * request. The row write is the source of truth for the action; the
 * implicit-resolve is observability that closes the reviewer's loop.
 *
 * Why match on `(target_entity_type, target_entity_id)` and not on
 * `request_kind`: the kind→target-type mapping is 1:1 in V1-2 (per
 * `REVIEWER_REQUEST_KIND_TO_TARGET_TYPE` in
 * `atoms/reviewer-request.atom.ts`), so any pending request against a
 * given target tuple is unambiguously the one this action satisfies.
 * If a future kind lands that targets the same atom type with a
 * different action, this helper grows a `kind?` filter.
 */

import { and, eq } from "drizzle-orm";
import { db, reviewerRequests } from "@workspace/db";
import type { Logger } from "pino";

export interface ResolveMatchingReviewerRequestsParams {
  /**
   * The atom type the domain action operated on. One of
   * `REVIEWER_REQUEST_TARGET_TYPES` (`briefing-source` / `bim-model`
   * / `parcel-briefing`); the column is `text` so a typo here
   * silently produces a no-op rather than a 500. Callers should
   * import the literal from the schema barrel to avoid drift.
   */
  targetEntityType: string;
  /**
   * The atom id the domain action operated on. Composite-key atoms
   * (e.g. `briefing-source:{briefingId}:{overlayId}:{snapshotDate}`)
   * pass the full canonical id verbatim — the column itself does not
   * parse the structure.
   */
  targetEntityId: string;
  /**
   * The atom-history event id the domain action just emitted (the
   * `id` returned by `EventAnchoringService.appendEvent`). Stamped on
   * the resolved row's `triggered_action_event_id` so a downstream
   * audit can join the request row back to the action that closed it.
   */
  triggeredActionEventId: string;
  /**
   * Per-request logger — pino's `req.log` is preferred so the
   * resolution messages share the request's correlation id. Falls
   * back to the api-server's root `logger` at the call site.
   */
  log: Logger;
}

/**
 * Best-effort: flip every pending reviewer-request whose target tuple
 * matches the action onto `resolved` and stamp the action event id.
 * Returns the count of rows resolved (0 when none were pending).
 *
 * Never throws — all failure modes are caught + logged. The caller
 * must not gate the HTTP response on the return value.
 */
export async function resolveMatchingReviewerRequests(
  params: ResolveMatchingReviewerRequestsParams,
): Promise<number> {
  const { targetEntityType, targetEntityId, triggeredActionEventId, log } =
    params;
  try {
    const updated = await db
      .update(reviewerRequests)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        triggeredActionEventId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reviewerRequests.targetEntityType, targetEntityType),
          eq(reviewerRequests.targetEntityId, targetEntityId),
          eq(reviewerRequests.status, "pending"),
        ),
      )
      .returning({
        id: reviewerRequests.id,
        engagementId: reviewerRequests.engagementId,
        requestKind: reviewerRequests.requestKind,
      });
    if (updated.length > 0) {
      log.info(
        {
          targetEntityType,
          targetEntityId,
          triggeredActionEventId,
          resolvedCount: updated.length,
          resolvedRequests: updated.map((r) => ({
            id: r.id,
            engagementId: r.engagementId,
            requestKind: r.requestKind,
          })),
        },
        "implicit-resolve: pending reviewer-request(s) closed by domain action",
      );
    }
    return updated.length;
  } catch (err) {
    log.warn(
      {
        err,
        targetEntityType,
        targetEntityId,
        triggeredActionEventId,
      },
      "implicit-resolve: reviewer-request UPDATE failed — domain action kept",
    );
    return 0;
  }
}
