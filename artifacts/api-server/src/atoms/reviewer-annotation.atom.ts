/**
 * The `reviewer-annotation` atom registration — Wave 2 Sprint C /
 * Spec 307.
 *
 * A *reviewer annotation* is a scratch note left by a reviewer
 * (`audience: "internal"`) anchored to a specific target atom render
 * inside the context of a single plan-review submission. Annotations
 * are reviewer-only by default; they become architect-visible only
 * when the reviewer formally promotes them as part of a jurisdiction
 * response.
 *
 * Identity is the row UUID. Append-mostly — the row itself is mutable
 * via PATCH (body / category) until promoted, after which the route
 * layer rejects further mutations and the row is treated as frozen
 * audit content.
 *
 * Composition (Spec 307 §"Done looks like"):
 *   - `submission`              (1, dataKey: submission)
 *   - `briefing-source`         (1, dataKey: briefingSource, optional)
 *   - `materializable-element`  (1, dataKey: materializableElement, optional)
 *   - `briefing-divergence`     (1, dataKey: briefingDivergence, optional)
 *   - `sheet`                   (1, dataKey: sheet, optional)
 *   - `parcel-briefing`         (1, dataKey: parcelBriefing, optional)
 *
 * Only the edge that matches `targetEntityType` is populated at
 * `contextSummary` time; the others are declared in `composition` so
 * the registry validator sees the full target vocabulary up front.
 *
 * supportedModes: all five per Spec 20 §10. `defaultMode: "compact"`
 * — annotations appear as line items inside their parent target's
 * side panel.
 *
 * Event types per Spec 307 §"Done looks like":
 *   - `reviewer-annotation.created`  — emitted on top-level insert.
 *   - `reviewer-annotation.replied`  — emitted on reply insert.
 *   - `reviewer-annotation.promoted` — emitted exactly once when
 *     the annotation is first promoted via the bulk-promote endpoint.
 */

import { eq } from "drizzle-orm";
import {
  reviewerAnnotations,
  REVIEWER_ANNOTATION_TARGET_TYPES,
  type ReviewerAnnotationTargetType,
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
export const REVIEWER_ANNOTATION_PROSE_MAX_CHARS = 400;

/** All five Spec 20 §5 render modes. */
export const REVIEWER_ANNOTATION_SUPPORTED_MODES = [
  "inline",
  "compact",
  "card",
  "expanded",
  "focus",
] as const;

export type ReviewerAnnotationSupportedModes =
  typeof REVIEWER_ANNOTATION_SUPPORTED_MODES;

/**
 * Single source of truth for reviewer-annotation event types per
 * Spec 307. The route layer in `routes/reviewerAnnotations.ts`
 * imports this constant.
 */
export const REVIEWER_ANNOTATION_EVENT_TYPES = [
  "reviewer-annotation.created",
  "reviewer-annotation.replied",
  "reviewer-annotation.promoted",
] as const;

export type ReviewerAnnotationEventType =
  (typeof REVIEWER_ANNOTATION_EVENT_TYPES)[number];

/**
 * Map a `targetEntityType` to its composition `dataKey`. Centralized
 * so the route layer (when it hand-rolls a wire envelope) and the
 * atom (when it surfaces the same edge under `relatedAtoms`) stay in
 * sync.
 */
export const REVIEWER_ANNOTATION_TARGET_DATA_KEYS: Record<
  ReviewerAnnotationTargetType,
  string
> = {
  submission: "submission",
  "briefing-source": "briefingSource",
  "materializable-element": "materializableElement",
  "briefing-divergence": "briefingDivergence",
  sheet: "sheet",
  "parcel-briefing": "parcelBriefing",
};

/**
 * Typed payload returned by `reviewer-annotation`'s
 * `contextSummary.typed`.
 */
export interface ReviewerAnnotationTypedPayload {
  id: string;
  found: boolean;
  submissionId?: string;
  targetEntityType?: ReviewerAnnotationTargetType;
  targetEntityId?: string;
  reviewerId?: string;
  body?: string;
  category?: string;
  parentAnnotationId?: string | null;
  promotedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ReviewerAnnotationAtomDeps {
  db: typeof ProdDb;
  history?: EventAnchoringService;
}

/**
 * Build the reviewer-annotation atom registration.
 */
export function makeReviewerAnnotationAtom(
  deps: ReviewerAnnotationAtomDeps,
): AtomRegistration<
  "reviewer-annotation",
  ReviewerAnnotationSupportedModes
> {
  // Declare every potential target edge up front. The route layer
  // populates only the edge matching the row's `targetEntityType`
  // at lookup time; the registration itself just promises the
  // catalog "I might compose any of these six".
  const composition: ReadonlyArray<AtomComposition> = (
    REVIEWER_ANNOTATION_TARGET_TYPES as ReadonlyArray<ReviewerAnnotationTargetType>
  ).map((targetType) => ({
    childEntityType: targetType,
    childMode: "compact",
    dataKey: REVIEWER_ANNOTATION_TARGET_DATA_KEYS[targetType],
  }));

  const registration: AtomRegistration<
    "reviewer-annotation",
    ReviewerAnnotationSupportedModes
  > = {
    entityType: "reviewer-annotation",
    domain: "plan-review",
    supportedModes: REVIEWER_ANNOTATION_SUPPORTED_MODES,
    defaultMode: "compact",
    composition,
    eventTypes: REVIEWER_ANNOTATION_EVENT_TYPES,
    async contextSummary(
      entityId: string,
      _scope,
    ): Promise<ContextSummary<"reviewer-annotation">> {
      const rows = await deps.db
        .select()
        .from(reviewerAnnotations)
        .where(eq(reviewerAnnotations.id, entityId))
        .limit(1);
      const row = rows[0];

      let latestEventId = "";
      let latestEventAt = new Date(0).toISOString();
      if (deps.history) {
        try {
          const latest = await deps.history.latestEvent({
            kind: "atom",
            entityType: "reviewer-annotation",
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
          prose: `Reviewer annotation ${entityId} could not be found.`,
          typed: {
            id: entityId,
            found: false,
          } satisfies ReviewerAnnotationTypedPayload as unknown as Record<
            string,
            unknown
          >,
          keyMetrics: [],
          relatedAtoms: [],
          historyProvenance: { latestEventId, latestEventAt },
          scopeFiltered: false,
        };
      }

      const promotionFragment = row.promotedAt
        ? ` (promoted ${row.promotedAt.toISOString()})`
        : " (reviewer-only)";
      const proseRaw =
        `Reviewer annotation by ${row.reviewerId} on ${row.targetEntityType} ` +
        `${row.targetEntityId}${promotionFragment}: "${row.body}".`;
      const prose =
        proseRaw.length > REVIEWER_ANNOTATION_PROSE_MAX_CHARS
          ? proseRaw.slice(0, REVIEWER_ANNOTATION_PROSE_MAX_CHARS - 1) + "…"
          : proseRaw;

      const keyMetrics: KeyMetric[] = [
        { label: "Category", value: row.category },
        { label: "Promoted", value: row.promotedAt ? "yes" : "no" },
      ];

      const typed: ReviewerAnnotationTypedPayload = {
        id: row.id,
        found: true,
        submissionId: row.submissionId,
        targetEntityType:
          row.targetEntityType as ReviewerAnnotationTargetType,
        targetEntityId: row.targetEntityId,
        reviewerId: row.reviewerId,
        body: row.body,
        category: row.category,
        parentAnnotationId: row.parentAnnotationId,
        promotedAt: row.promotedAt ? row.promotedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };

      if (!latestEventId) {
        latestEventAt = row.createdAt.toISOString();
      }

      return {
        prose,
        typed: typed as unknown as Record<string, unknown>,
        keyMetrics,
        // Surface the *single* matching target edge as a relatedAtom
        // so the chat layer can drill straight from the annotation to
        // the thing it's anchored to without having to know the
        // mapping table.
        relatedAtoms: [
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
