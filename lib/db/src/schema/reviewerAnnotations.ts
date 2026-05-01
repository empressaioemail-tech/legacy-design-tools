import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * Closed enum of *target atom types* a reviewer annotation may anchor
 * against. Mirrors the Wave 2 Sprint C spec (#307): a reviewer scratch
 * note must point at a concrete atom render so the affordance can
 * surface threaded notes inline wherever the target appears.
 *
 * Kept here (alongside the schema) so the route layer, the OpenAPI
 * `ReviewerAnnotationTarget` enum, and the atom registration's
 * composition list all import the same source-of-truth tuple instead
 * of open-coding string literals. Adding a new target type is an O(1)
 * change here — append the literal, rebuild, and the route validator
 * + atom composition pick it up automatically.
 */
export const REVIEWER_ANNOTATION_TARGET_TYPES = [
  "submission",
  "briefing-source",
  "materializable-element",
  "briefing-divergence",
  "sheet",
  "parcel-briefing",
] as const;

export type ReviewerAnnotationTargetType =
  (typeof REVIEWER_ANNOTATION_TARGET_TYPES)[number];

/**
 * Closed enum of *category* buckets a reviewer may file an annotation
 * under. Drives the small badge in the side-panel and lets future
 * promotion-side filtering (e.g. "promote all concerns") avoid
 * relying on free-text classification.
 */
export const REVIEWER_ANNOTATION_CATEGORIES = [
  "concern",
  "question",
  "note",
  "requires-followup",
] as const;

export type ReviewerAnnotationCategory =
  (typeof REVIEWER_ANNOTATION_CATEGORIES)[number];

/**
 * A *reviewer annotation* is a scratch note left by a reviewer (audience
 * `internal`) against a specific target atom render inside the context
 * of a single plan-review submission. Annotations are reviewer-only
 * until promoted as part of a jurisdiction response — once promoted
 * the row's `promotedAt` timestamp is set, the row becomes immutable,
 * and a `reviewer-annotation.promoted` event is appended to the
 * annotation's history chain.
 *
 * Submission-scoped: `submissionId` is required and FK-cascaded so a
 * submission deletion cleans up its annotations. The
 * `(submissionId, targetEntityType, targetEntityId)` index supports the
 * affordance's "annotations on this target?" query without a sequential
 * scan; the `(parentAnnotationId)` index supports threaded reply
 * lookups.
 *
 * `parentAnnotationId` is a self-FK (nullable) — top-level annotations
 * have no parent, replies point at the root of their thread. The DB
 * enforces a single-level threading shape via the route layer (replies
 * cannot reply to replies); the column itself accepts any annotation
 * id under the same submission so a future "deep threading" relax is
 * a route-only change.
 *
 * `reviewerId` is plain `text` (not an FK to `users.id`) for the same
 * reason `users.id` itself is `text` and the divergence-resolve
 * attribution columns are: the api-server accepts arbitrary opaque
 * ids from the upstream identity layer and nothing here should
 * retroactively break the audit trail if the identity source is
 * swapped or a profile row is removed.
 */
export const reviewerAnnotations = pgTable(
  "reviewer_annotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /**
     * One of {@link REVIEWER_ANNOTATION_TARGET_TYPES}. Closed-set is
     * enforced at the route layer; the column itself is `text` so a
     * future spec extension only needs a route change plus an atom
     * composition addition (no DB migration to relax the enum).
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
     * Session-bound reviewer identifier — the `id` half of
     * `SessionUser.requestor`. Always populated; the route gates on
     * the presence of a session-bound requestor before insert so a
     * row without an attribution is impossible.
     */
    reviewerId: text("reviewer_id").notNull(),
    /**
     * Free-text annotation body, capped at 4 KB by the route's Zod
     * validator (matches the existing submission-note convention).
     */
    body: text("body").notNull(),
    /**
     * One of {@link REVIEWER_ANNOTATION_CATEGORIES}. Defaults to
     * `note` so a minimal create call (just `body`) gets a sensible
     * bucket without a route-side default.
     */
    category: text("category").notNull().default("note"),
    /**
     * Optional self-FK for threaded replies. Null for top-level
     * annotations. ON DELETE SET NULL keeps a child annotation
     * alive when the parent is deleted (the soft-delete path is
     * intentionally undefined for v1 — promoted annotations are
     * immutable anyway, and a non-promoted parent that gets
     * removed should still let replies stay in the thread).
     *
     * The forward-reference syntax (the `(): AnyPgColumn` callback)
     * is required because drizzle's pgTable column factory cannot
     * read its own table mid-declaration.
     */
    parentAnnotationId: uuid("parent_annotation_id").references(
      (): AnyPgColumn => reviewerAnnotations.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Last edit timestamp, refreshed by the PATCH route. Defaults to
     * `now()` so a freshly-inserted row's `updatedAt` is comparable
     * to its `createdAt` without a separate backfill.
     */
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /**
     * Promotion stamp. Null while the annotation is still
     * reviewer-only; set the first time a jurisdiction response
     * promotes the annotation. Once non-null the row is immutable
     * — the route layer rejects further PATCH / promote calls so
     * the architect-visible content does not silently change after
     * the fact.
     */
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (t) => ({
    /**
     * Drives the affordance's "annotations on this target for this
     * submission?" query — the side panel reads with all three
     * columns present in the WHERE clause.
     */
    targetIdx: index("reviewer_annotations_target_idx").on(
      t.submissionId,
      t.targetEntityType,
      t.targetEntityId,
    ),
    /**
     * Drives threaded-reply lookups (one indexed scan per parent).
     */
    parentIdx: index("reviewer_annotations_parent_idx").on(
      t.parentAnnotationId,
    ),
    /**
     * Spec 307 closed-set DB enforcement. The route layer gates on
     * the same TS literal tuples (`REVIEWER_ANNOTATION_TARGET_TYPES`
     * / `REVIEWER_ANNOTATION_CATEGORIES`) but a CHECK at the DB
     * layer catches any direct insert (backfill scripts, manual SQL,
     * future routes that forget the validator) so a malformed value
     * can never reach a consumer that round-trips it through the
     * `ReviewerAnnotationTargetType` / `ReviewerAnnotationCategory`
     * type narrowing.
     *
     * Kept in sync with the TS constants above by literal copy —
     * the drizzle CHECK builder takes a raw SQL literal so we
     * cannot interpolate the TS array directly. A pre-merge
     * reviewer change to the TS tuple must include a sibling change
     * to the CHECK; the schema-integration test pinning the table
     * shape is the safety net.
     */
    targetTypeCheck: check(
      "reviewer_annotations_target_type_check",
      sql`${t.targetEntityType} IN ('submission', 'briefing-source', 'materializable-element', 'briefing-divergence', 'sheet', 'parcel-briefing')`,
    ),
    categoryCheck: check(
      "reviewer_annotations_category_check",
      sql`${t.category} IN ('concern', 'question', 'note', 'requires-followup')`,
    ),
  }),
);

export const reviewerAnnotationsRelations = relations(
  reviewerAnnotations,
  ({ one }) => ({
    submission: one(submissions, {
      fields: [reviewerAnnotations.submissionId],
      references: [submissions.id],
    }),
    parent: one(reviewerAnnotations, {
      fields: [reviewerAnnotations.parentAnnotationId],
      references: [reviewerAnnotations.id],
      relationName: "reviewer_annotation_parent",
    }),
  }),
);

export type ReviewerAnnotation = typeof reviewerAnnotations.$inferSelect;
export type NewReviewerAnnotation = typeof reviewerAnnotations.$inferInsert;
