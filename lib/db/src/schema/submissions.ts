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
 *
 * Response columns (Task #76) — `status`, `reviewerComment`, and
 * `respondedAt` capture the *jurisdiction's reply* against the
 * submission. `status` is the canonical review-state enum (see
 * {@link SUBMISSION_STATUS_VALUES}) — defaulted to `"pending"` at
 * insert so every existing row, and every newly-created row, has a
 * meaningful status without a separate backfill. `reviewerComment` is
 * an optional free-text note from the reviewer (e.g. correction
 * requests, approval conditions) and is null while the submission is
 * still pending. `respondedAt` is null until the response is recorded;
 * once non-null it is the canonical timestamp of the jurisdiction's
 * reply (mirrors how `submittedAt` is the canonical send-off
 * timestamp). Storing the response inline on the same row — rather
 * than as a separate `submission_responses` table — keeps a
 * submission's full back-and-forth retrievable in one read and
 * matches the locked decision #5 (rows over events) for the response
 * surface; the `submission.response-recorded` event remains the
 * audit trail.
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
    status: text("status").notNull().default("pending"),
    reviewerComment: text("reviewer_comment"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    engagementIdx: index("submissions_engagement_idx").on(t.engagementId),
    submittedAtIdx: index("submissions_submitted_at_idx").on(t.submittedAt),
  }),
);

/**
 * Canonical set of jurisdiction-response statuses a submission row's
 * `status` column may hold. The `pending` value is the default at
 * insert (no response yet); the other three are terminal-ish review
 * outcomes the route handler may transition the row into when the
 * jurisdiction's reply is recorded. Kept here (alongside the schema)
 * so consumers — the response route, the OpenAPI body schema, the
 * submission atom's keyMetric — all import the same source-of-truth
 * tuple rather than open-coding string literals.
 */
export const SUBMISSION_STATUS_VALUES = [
  "pending",
  "approved",
  "corrections_requested",
  "rejected",
] as const;

export type SubmissionStatus = (typeof SUBMISSION_STATUS_VALUES)[number];

/**
 * The non-pending subset — the values the response route is allowed
 * to transition a submission *into*. `pending` is the implicit
 * starting state and not a valid response payload, so excluding it
 * here lets the route validation reject `{"status":"pending"}` at the
 * contract layer instead of silently no-op'ing the response.
 */
export const SUBMISSION_RESPONSE_STATUS_VALUES = [
  "approved",
  "corrections_requested",
  "rejected",
] as const;

export type SubmissionResponseStatus =
  (typeof SUBMISSION_RESPONSE_STATUS_VALUES)[number];

export const submissionsRelations = relations(submissions, ({ one }) => ({
  engagement: one(engagements, {
    fields: [submissions.engagementId],
    references: [engagements.id],
  }),
}));

export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
