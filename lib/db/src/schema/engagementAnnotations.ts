import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";
import { findings } from "./findings";

/**
 * Engagement-scoped 2D/3D unified annotation (Track D Phase 2).
 *
 * Distinct from {@link import('./reviewerAnnotations').reviewerAnnotations}
 * (which is submission-scoped threaded reviewer scratch notes). An
 * `engagement_annotation` is a markup / finding overlay anchored to an
 * engagement, carrying EITHER a 2D document-space location
 * (`location2d`: `{ submissionId, page, bbox, label }`, bbox in 0..1
 * normalized coords) OR a 3D element-space location
 * (`location3d`: `{ globalId, elementId, face?, label }`), plus an optional
 * back-link to the `finding` it visualizes.
 *
 * `kind` is plain `text` (the closed set lives in the `@empressaio/document-viewer`
 * `AnnotationKind` union and is validated at the route layer); `author` is
 * plain `text` (opaque id from the identity layer or the literal `'ai'`), for
 * the same reason `findings.accepted_by_reviewer_id` /
 * `reviewer_annotations.reviewer_id` are text — the api-server must not break
 * the audit trail if the identity source is swapped.
 *
 * `finding_id` is a nullable FK with `ON DELETE SET NULL`: a purely-manual
 * markup carries no finding, and deleting a finding should orphan-but-keep
 * the visual annotation rather than cascade-delete it.
 */
export const engagementAnnotations = pgTable(
  "engagement_annotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    author: text("author").notNull(),
    kind: text("kind").notNull(),
    findingId: uuid("finding_id").references(() => findings.id, {
      onDelete: "set null",
    }),
    confidence: jsonb("confidence"),
    location2d: jsonb("location2d"),
    location3d: jsonb("location3d"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("idx_annotations_engagement").on(t.engagementId),
  }),
);

export const engagementAnnotationsRelations = relations(
  engagementAnnotations,
  ({ one }) => ({
    engagement: one(engagements, {
      fields: [engagementAnnotations.engagementId],
      references: [engagements.id],
    }),
    finding: one(findings, {
      fields: [engagementAnnotations.findingId],
      references: [findings.id],
    }),
  }),
);

export type EngagementAnnotation = typeof engagementAnnotations.$inferSelect;
export type NewEngagementAnnotation = typeof engagementAnnotations.$inferInsert;
