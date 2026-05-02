import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * Closed enum of *request kinds* a reviewer may file against a target
 * atom on the engagement. Each kind names the architect-side action the
 * reviewer wants to see run; the architect's existing domain action
 * (e.g. `briefing-source.refreshed`, `bim-model.refreshed`,
 * `parcel-briefing.regenerated`) implicitly resolves the request via
 * the post-action hook in `lib/reviewerRequestResolution.ts`.
 *
 * Wave 2 Sprint D / V1-2 minimum cut. Six event types ride this enum:
 * three `*.requested` (one per kind, emitted at create) plus three
 * `*.dismissed` (emitted when an architect dismisses with reason).
 * `*.honored` events are deliberately NOT modelled — the architect's
 * existing domain action is the resolution signal.
 */
export const REVIEWER_REQUEST_KINDS = [
  "refresh-briefing-source",
  "refresh-bim-model",
  "regenerate-briefing",
] as const;

export type ReviewerRequestKind = (typeof REVIEWER_REQUEST_KINDS)[number];

/**
 * Closed enum of statuses a reviewer-request row may hold. `pending`
 * is the default at insert; `dismissed` is the architect-explicit
 * reject path; `resolved` is set by the implicit-resolve hook when
 * the matching domain action emits; `withdrawn` is the *reviewer*-
 * explicit retract path (Task #443) for a reviewer to clear their
 * own outstanding ask without architect involvement. `withdrawn`
 * stays distinct from `dismissed` so the audit trail can tell apart
 * "architect declined" from "reviewer changed their mind" — both
 * the row-level columns (`withdrawn_by` / `withdrawn_at` /
 * `withdrawal_reason`) and the lifecycle event
 * (`reviewer-request.<kind>.withdrawn`) preserve that split.
 */
export const REVIEWER_REQUEST_STATUSES = [
  "pending",
  "dismissed",
  "resolved",
  "withdrawn",
] as const;

export type ReviewerRequestStatus =
  (typeof REVIEWER_REQUEST_STATUSES)[number];

/**
 * Closed enum of target atom types a reviewer-request may anchor
 * against. One-to-one with the request kinds (refresh-briefing-source
 * → briefing-source, etc.) but kept as its own column so a future
 * many-to-one expansion (e.g. a kind that targets multiple atom types)
 * doesn't require a schema migration.
 */
export const REVIEWER_REQUEST_TARGET_TYPES = [
  "briefing-source",
  "bim-model",
  "parcel-briefing",
] as const;

export type ReviewerRequestTargetType =
  (typeof REVIEWER_REQUEST_TARGET_TYPES)[number];

/**
 * Actor envelope stamped on `requested_by` / `dismissed_by`. Mirrors
 * the `FindingActor` shape promoted to a shared OpenAPI type in
 * `lib/api-spec/openapi.yaml` and re-exported by `@workspace/api-zod`.
 * Defined inline here so the schema file does not depend on the
 * generated types (the schema is the source-of-truth for table shape;
 * the generated type is the wire envelope).
 */
export interface ReviewerRequestActor {
  kind: "user" | "agent" | "system";
  id: string;
  displayName?: string | null;
}

/**
 * A *reviewer request* is a free-text ask filed by a reviewer
 * (`audience: "internal"`) against a single target atom on an
 * engagement. The architect either acts on the request — running the
 * existing domain action, which closes the request implicitly via the
 * post-action hook — or dismisses it with a reason.
 *
 * Engagement-scoped: `engagement_id` is FK-cascaded so an engagement
 * deletion cleans up its reviewer-requests. The
 * `(engagement_id, status, requested_at)` index drives the architect
 * strip's pending-list query (Postgres serves DESC scans from this
 * btree without an explicit `.desc()` modifier). The
 * `(target_entity_type, target_entity_id, status)` index drives the
 * implicit-resolve helper's "find pending requests for this target"
 * lookup that fires from each domain action's emit site.
 *
 * `target_entity_id` is `text` (not `uuid`) because briefing-source
 * ids are composite strings of the form
 * `briefing-source:{briefingId}:{overlayId}:{snapshotDate}` per the
 * `briefing-source` atom contract; reviewer-annotation precedent uses
 * the same `text` shape for the same reason.
 *
 * `requested_by` / `dismissed_by` are `jsonb` carrying the actor
 * envelope (kind + id + optional displayName) at write time, so the
 * architect strip can render "Requested by Alex" without a chatty
 * round-trip per row. Reviewer-annotation stores only `reviewer_id`
 * and lazy-hydrates displayName at read; the strip's pending-queue
 * UX did not justify the extra round-trip, so this surface stamps the
 * envelope eagerly.
 *
 * `triggered_action_event_id` is set by the implicit-resolve hook to
 * the `id` of the atom-history event that closed the request (e.g.
 * the `briefing-source.refreshed` event id). Null while the request
 * is `pending` or `dismissed`.
 */
export const reviewerRequests = pgTable(
  "reviewer_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    /**
     * One of {@link REVIEWER_REQUEST_KINDS}. Closed-set is enforced
     * at the route layer; the column is `text` so a future spec
     * extension only needs a route + check-constraint change (no DB
     * migration to relax the enum).
     */
    requestKind: text("request_kind").notNull(),
    /**
     * One of {@link REVIEWER_REQUEST_TARGET_TYPES}. Closed-set
     * enforced via the `target_type_check` constraint below.
     */
    targetEntityType: text("target_entity_type").notNull(),
    /**
     * Opaque atom id under the target type. For composite-key atoms
     * (e.g. `briefing-source:{briefingId}:{overlayId}:{snapshotDate}`)
     * the route layer is responsible for passing the full canonical
     * id; nothing in this table parses the structure.
     */
    targetEntityId: text("target_entity_id").notNull(),
    /**
     * Free-text reason the reviewer supplied at create time. Capped
     * at 4 KB by the route's Zod validator (matches the reviewer-
     * annotation body convention).
     */
    reason: text("reason").notNull(),
    /**
     * One of {@link REVIEWER_REQUEST_STATUSES}. Defaults to `pending`
     * so a freshly-inserted row needs no explicit status. Closed-set
     * enforced via the `status_check` constraint below.
     */
    status: text("status").notNull().default("pending"),
    /**
     * Actor envelope stamped at create. `requestor` is always
     * session-bound at the route gate (`requireReviewerAudience`);
     * the envelope is jsonb so a future identity-source change can
     * add fields (e.g. `tenantId`) without a column add.
     */
    requestedBy: jsonb("requested_by")
      .$type<ReviewerRequestActor>()
      .notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Actor envelope stamped at dismiss time. Null while the request
     * is `pending` or `resolved`.
     */
    dismissedBy: jsonb("dismissed_by").$type<ReviewerRequestActor>(),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    /**
     * Free-text reason the architect supplied at dismiss time. Capped
     * at 4 KB by the route's Zod validator. Null while the request is
     * `pending` or `resolved`.
     */
    dismissalReason: text("dismissal_reason"),
    /**
     * Actor envelope stamped at withdraw time (Task #443). Null while
     * the request is in any state other than `withdrawn`. Mirrors the
     * `dismissedBy` shape — the *reviewer* who filed the row is the
     * only actor allowed to populate it; the route layer enforces
     * that ownership gate at write time.
     */
    withdrawnBy: jsonb("withdrawn_by").$type<ReviewerRequestActor>(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    /**
     * Optional free-text rationale the reviewer supplied at withdraw
     * time. Capped at 4 KB by the route's Zod validator. Null when
     * the reviewer did not supply one (the surface treats withdraw
     * as a low-friction self-service action; a written reason is
     * encouraged but not required, in contrast to the architect-side
     * `dismissalReason` which is mandatory).
     */
    withdrawalReason: text("withdrawal_reason"),
    /**
     * Set by the implicit-resolve hook when a matching domain action
     * emits. Null while the request is `pending`, `dismissed`, or
     * `withdrawn`.
     */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /**
     * The id of the atom-history event that closed the request (e.g.
     * the `briefing-source.refreshed` event id). Stamped by the
     * implicit-resolve hook in lockstep with `resolved_at`.
     */
    triggeredActionEventId: uuid("triggered_action_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Drives the architect strip's pending-list query
     * (`WHERE engagement_id = $1 AND status = $2 ORDER BY requested_at DESC`).
     * Postgres serves the DESC scan from this btree without an explicit
     * sort modifier — matches the house convention used by every other
     * timestamped index in this schema.
     */
    pendingByEngagement: index("reviewer_requests_pending_idx").on(
      t.engagementId,
      t.status,
      t.requestedAt,
    ),
    /**
     * Drives the implicit-resolve helper's
     * `WHERE target_entity_type = $1 AND target_entity_id = $2 AND status = 'pending'`
     * lookup. Fires from each domain action's emit site (briefing-source
     * refresh, bim-model refresh, parcel-briefing regenerate).
     */
    targetIdx: index("reviewer_requests_target_idx").on(
      t.targetEntityType,
      t.targetEntityId,
      t.status,
    ),
    /**
     * Closed-set DB enforcement for `request_kind`. The route layer
     * gates on the same TS literal tuple
     * ({@link REVIEWER_REQUEST_KINDS}) but a CHECK at the DB layer
     * catches any direct insert (backfill scripts, manual SQL,
     * future routes that forget the validator) so a malformed value
     * can never reach a consumer that round-trips it through the
     * `ReviewerRequestKind` type narrowing.
     *
     * Kept in sync with the TS constants by literal copy — the
     * drizzle CHECK builder takes a raw SQL literal so we cannot
     * interpolate the TS array directly. A pre-merge change to the
     * TS tuple must include a sibling change to the CHECK; the
     * schema-integration test pinning the table shape is the safety
     * net.
     */
    kindCheck: check(
      "reviewer_requests_kind_check",
      sql`${t.requestKind} IN ('refresh-briefing-source', 'refresh-bim-model', 'regenerate-briefing')`,
    ),
    statusCheck: check(
      "reviewer_requests_status_check",
      sql`${t.status} IN ('pending', 'dismissed', 'resolved', 'withdrawn')`,
    ),
    targetTypeCheck: check(
      "reviewer_requests_target_type_check",
      sql`${t.targetEntityType} IN ('briefing-source', 'bim-model', 'parcel-briefing')`,
    ),
  }),
);

export const reviewerRequestsRelations = relations(
  reviewerRequests,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [reviewerRequests.engagementId],
      references: [engagements.id],
    }),
  }),
);

export type ReviewerRequest = typeof reviewerRequests.$inferSelect;
export type NewReviewerRequest = typeof reviewerRequests.$inferInsert;
