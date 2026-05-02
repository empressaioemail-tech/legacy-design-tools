/**
 * The `reviewer-request` atom registration — Wave 2 Sprint D / V1-2.
 *
 * A *reviewer request* is a free-text ask filed by a reviewer
 * (`audience: "internal"`) against a single target atom on an
 * engagement. The architect either acts on the request — running the
 * existing domain action (refresh briefing-source / refresh bim-model
 * / regenerate briefing), which closes the request implicitly via the
 * post-action hook in `lib/reviewerRequestResolution.ts` — or
 * dismisses it with a reason.
 *
 * Identity is the row UUID. Append-mostly — once `status` flips off
 * `pending` (to `dismissed` or `resolved`) the route layer treats the
 * row as frozen. The dismissal-reason / resolved-at / triggered-action
 * columns are populated at the transition and never re-edited.
 *
 * Composition:
 *   - `engagement`        (1, dataKey: engagement)             — parent
 *   - `briefing-source`   (1, dataKey: briefingSource, optional target)
 *   - `bim-model`         (1, dataKey: bimModel, optional target)
 *   - `parcel-briefing`   (1, dataKey: parcelBriefing, optional target)
 *
 * Only the target edge matching `targetEntityType` is populated at
 * `contextSummary` time; the others are declared so the registry
 * validator sees the full target vocabulary up front. Mirrors the
 * reviewer-annotation precedent.
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "compact"`
 * — requests appear as line items inside the architect's
 * ReviewerRequestsStrip.
 *
 * Event types — six per V1-2 minimum cut. Three `*.requested` (one
 * per kind, emitted at create) plus three `*.dismissed` (emitted when
 * an architect dismisses with reason). `*.honored` events are
 * deliberately NOT modelled — the architect's existing domain action
 * (e.g. `briefing-source.refreshed`) is the resolution signal, hooked
 * by `lib/reviewerRequestResolution.ts` to flip `status` and stamp
 * `triggered_action_event_id`.
 */

import { eq } from "drizzle-orm";
import {
  reviewerRequests,
  REVIEWER_REQUEST_TARGET_TYPES,
  type ReviewerRequestKind,
  type ReviewerRequestStatus,
  type ReviewerRequestTargetType,
  type ReviewerRequestActor,
} from "@workspace/db";
import {
  type AtomComposition,
  type AtomRegistration,
  type ContextSummary,
  type EventAnchoringService,
  type KeyMetric,
} from "@workspace/empressa-atom";
import type { db as ProdDb } from "@workspace/db";

/** Hard cap on the prose summary. */
export const REVIEWER_REQUEST_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes. */
export const REVIEWER_REQUEST_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type ReviewerRequestSupportedModes =
  typeof REVIEWER_REQUEST_SUPPORTED_MODES;

/**
 * Single source of truth for reviewer-request event types.
 *
 * Six entries per the V1-2 minimum cut. Three `*.requested` + three
 * `*.dismissed`. The matching atom-history events are appended by
 * the route layer in `routes/reviewerRequests.ts` at create / dismiss
 * time. Resolution does NOT emit a `reviewer-request.*` event — the
 * underlying domain action's existing event (e.g.
 * `briefing-source.refreshed`) is the resolution signal, and the row
 * itself records the closure via `status = "resolved"` +
 * `triggered_action_event_id`.
 */
export const REVIEWER_REQUEST_EVENT_TYPES = [
  "reviewer-request.refresh-briefing-source.requested",
  "reviewer-request.refresh-bim-model.requested",
  "reviewer-request.regenerate-briefing.requested",
  "reviewer-request.refresh-briefing-source.dismissed",
  "reviewer-request.refresh-bim-model.dismissed",
  "reviewer-request.regenerate-briefing.dismissed",
] as const;

export type ReviewerRequestEventType =
  (typeof REVIEWER_REQUEST_EVENT_TYPES)[number];

/**
 * Map a `targetEntityType` to its composition `dataKey`. Centralized
 * so the route layer (when it hand-rolls a wire envelope) and the
 * atom (when it surfaces the same edge under `relatedAtoms`) stay in
 * sync. Mirrors the `REVIEWER_ANNOTATION_TARGET_DATA_KEYS` precedent.
 */
export const REVIEWER_REQUEST_TARGET_DATA_KEYS: Record<
  ReviewerRequestTargetType,
  string
> = {
  "briefing-source": "briefingSource",
  "bim-model": "bimModel",
  "parcel-briefing": "parcelBriefing",
};

/**
 * Map a `requestKind` to the `targetEntityType` it operates on. The
 * route layer enforces the pairing at validate-time so a malformed
 * `(kind, targetEntityType)` combination cannot reach the row; this
 * map is the single source-of-truth shared by the route validator,
 * the implicit-resolve helper, and the atom itself.
 */
export const REVIEWER_REQUEST_KIND_TO_TARGET_TYPE: Record<
  ReviewerRequestKind,
  ReviewerRequestTargetType
> = {
  "refresh-briefing-source": "briefing-source",
  "refresh-bim-model": "bim-model",
  "regenerate-briefing": "parcel-briefing",
};

/**
 * Typed payload returned by `reviewer-request`'s `contextSummary.typed`.
 * Subset of the row shape that's safe to surface to the chat layer
 * — no internal-only columns (the row only has internal-only columns
 * if a future migration adds them; today every column is wire-safe).
 */
export interface ReviewerRequestTypedPayload {
  id: string;
  found: boolean;
  engagementId?: string;
  requestKind?: ReviewerRequestKind;
  targetEntityType?: ReviewerRequestTargetType;
  targetEntityId?: string;
  reason?: string;
  status?: ReviewerRequestStatus;
  requestedBy?: ReviewerRequestActor;
  requestedAt?: string;
  dismissedBy?: ReviewerRequestActor | null;
  dismissedAt?: string | null;
  dismissalReason?: string | null;
  resolvedAt?: string | null;
  triggeredActionEventId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewerRequestAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the reviewer-request atom registration.
 */
export function makeReviewerRequestAtom(
  deps: ReviewerRequestAtomDeps,
): AtomRegistration<"reviewer-request", ReviewerRequestSupportedModes> {
  // Declare every potential target edge plus the engagement parent.
  // The route layer / contextSummary populates only the target edge
  // matching the row's `targetEntityType` at lookup time. The
  // `engagement` edge is always populated since `engagement_id` is
  // NOT NULL on the row.
  const composition: ReadonlyArray<AtomComposition> = [
    {
      childEntityType: "engagement",
      childMode: "compact",
      dataKey: "engagement",
    },
    ...(
      REVIEWER_REQUEST_TARGET_TYPES as ReadonlyArray<ReviewerRequestTargetType>
    ).map((targetType) => ({
      childEntityType: targetType,
      childMode: "compact",
      dataKey: REVIEWER_REQUEST_TARGET_DATA_KEYS[targetType],
    })),
  ];

  const registration: AtomRegistration<
    "reviewer-request",
    ReviewerRequestSupportedModes
  > = {
    entityType: "reviewer-request",
    domain: "plan-review",
    supportedModes: REVIEWER_REQUEST_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: REVIEWER_REQUEST_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"reviewer-request">> {
      const rows = await deps.db
        .select()
        .from(reviewerRequests)
        .where(eq(reviewerRequests.id, entityId))
        .limit(1);
      const row = rows[0];

      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "reviewer-request",
            entityId,
          });
          if (latest) {
            latestEventId = latest.id;
            latestEventAt = latest.occurredAt.toISOString();
          }
        } catch {
          // Best-effort.
        }
      }

      if (!row) {
        return {
          prose: `Reviewer request ${entityId} could not be found.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies ReviewerRequestTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const requestedBy = row.requestedBy as ReviewerRequestActor;
      const requesterLabel =
        requestedBy.displayName?.trim() && requestedBy.displayName.trim().length > 0
          ? requestedBy.displayName.trim()
          : requestedBy.id;
      const statusFragment =
        row.status === "pending"
          ? "pending"
          : row.status === "dismissed"
            ? `dismissed${row.dismissalReason ? `: "${row.dismissalReason}"` : ""}`
            : "resolved";
      const proseRaw =
        `Reviewer request (${row.requestKind}) by ${requesterLabel} ` +
        `against ${row.targetEntityType} ${row.targetEntityId} — ` +
        `${statusFragment}: "${row.reason}".`;
      const prose =
        proseRaw.length > REVIEWER_REQUEST_PROSE_MAX_CHARS
          ? proseRaw.slice(0, REVIEWER_REQUEST_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Kind", value: row.requestKind },
        { label: "Status", value: row.status },
      ];

      const dismissedBy = row.dismissedBy as ReviewerRequestActor | null;
      const typed: ReviewerRequestTypedPayload = {
        id: row.id,
        found: true,
        engagementId: row.engagementId,
        requestKind: row.requestKind as ReviewerRequestKind,
        targetEntityType: row.targetEntityType as ReviewerRequestTargetType,
        targetEntityId: row.targetEntityId,
        reason: row.reason,
        status: row.status as ReviewerRequestStatus,
        requestedBy,
        requestedAt: row.requestedAt.toISOString(),
        dismissedBy: dismissedBy ?? null,
        dismissedAt: row.dismissedAt ? row.dismissedAt.toISOString() : null,
        dismissalReason: row.dismissalReason,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        triggeredActionEventId: row.triggeredActionEventId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      if (!latestEventId) {
        latestEventAt = row.createdAt.toISOString();
      }

      // Surface the engagement parent + the *single* matching target
      // edge as relatedAtoms, so the chat layer can drill straight
      // from the request to the engagement context and to the thing
      // the architect is asked to act on, without having to know the
      // kind→targetType mapping table.
      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        relatedAtoms: [
          {
            kind: "atom",
            entityType: "engagement",
            entityId: row.engagementId,
            mode: "compact",
          },
          {
            kind: "atom",
            entityType: row.targetEntityType,
            entityId: row.targetEntityId,
            mode: "compact",
          },
        ],
        historyProvenance: { latestEventId, latestEventAt },
        scopeFiltered: false,
      };
    },
  };

  return registration;
}
