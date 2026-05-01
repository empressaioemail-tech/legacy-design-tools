import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * A *submission* is a plan-review package handed off to the
 * jurisdiction. Created by `POST /api/engagements/:id/submissions`.
 *
 * The row captures the engagement's jurisdiction labels at the moment
 * of submission (separate `jurisdictionCity` / `jurisdictionState`
 * columns plus the legacy free-form `jurisdiction` label) so the
 * submission record is self-contained for audit / timeline rendering
 * even if the engagement's resolved jurisdiction later changes. The
 * optional `note` mirrors what the route already accepted in the
 * request body and on the `engagement.submitted` event payload — kept
 * here so the row + the event are interchangeable sources of truth
 * for the submission record.
 *
 * `submittedAt` is the canonical creation timestamp consumers should
 * read; `createdAt` defaults to the same value and is kept distinct
 * for forward-compat (a future producer might backfill historical
 * submissions where `submittedAt` differs from row creation time).
 */
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    jurisdiction: text("jurisdiction"),
    jurisdictionCity: text("jurisdiction_city"),
    jurisdictionState: text("jurisdiction_state"),
    jurisdictionFips: text("jurisdiction_fips"),
    note: text("note"),
    submittedAt: timestamp("submitted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("submissions_engagement_idx").on(t.engagementId),
    submittedAtIdx: index("submissions_submitted_at_idx").on(t.submittedAt),
  }),
);

export const submissionsRelations = relations(submissions, ({ one }) => ({
  engagement: one(engagements, {
    fields: [submissions.engagementId],
    references: [engagements.id],
  }),
}));

export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
