import { pgTable, uuid, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * Closed enum of *author roles* for a submission comment. The two
 * roles are:
 *
 *   - `architect` — the design-tools (architect-facing) caller. Posts
 *     a reply directly under the reviewer's seed comment from the
 *     submission detail modal.
 *   - `reviewer`  — the plan-review (reviewer-facing) caller. Posts
 *     a follow-up to keep the conversation going.
 *
 * Modelled as a closed enum on the comment row (rather than inferred
 * from the request's audience) because both surfaces today run as
 * `audience: "internal"` in the session model — distinguishing role
 * by audience would conflate two unrelated concerns. The route layer
 * trusts the body-supplied role and pairs it with the session
 * requestor id; once the identity layer carries roles natively this
 * becomes a server-derived field.
 */
export const SUBMISSION_COMMENT_AUTHOR_ROLES = [
  "architect",
  "reviewer",
] as const;

export type SubmissionCommentAuthorRole =
  (typeof SUBMISSION_COMMENT_AUTHOR_ROLES)[number];

/**
 * A *submission comment* is a single message in the reviewer↔architect
 * conversation that hangs off a plan-review submission. The seed of
 * the thread is the reviewer's original `submissions.reviewer_comment`
 * field; this table stores the back-and-forth replies.
 *
 * Distinct from `reviewer_annotations`, which is a reviewer-only
 * scratch-note table (Spec 307). That route is audience-gated to the
 * reviewer surface and supports a promotion flow; this one is the
 * cross-audience inline reply channel and has no promotion concept.
 *
 * Submission-scoped: `submissionId` is required and FK-cascaded so a
 * submission deletion cleans up its conversation. Listed chronologically
 * (oldest-first) on read so the UI reads top-to-bottom like a chat
 * transcript without a follow-up sort. The `(submissionId, createdAt)`
 * index supports that ordered scan without a sequential scan.
 *
 * `authorId` is plain `text` (not an FK to `users.id`) for the same
 * reason `reviewer_annotations.reviewerId` is: the api-server accepts
 * arbitrary opaque ids from the upstream identity layer and nothing
 * here should retroactively break the audit trail if the identity
 * source is swapped or a profile row is removed.
 */
export const submissionComments = pgTable(
  "submission_comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /**
     * One of {@link SUBMISSION_COMMENT_AUTHOR_ROLES}. Closed-set is
     * enforced both at the route layer and via a CHECK constraint so a
     * direct insert (backfill, manual SQL) can never produce a row
     * the wire-format type narrowing cannot represent.
     */
    authorRole: text("author_role").notNull(),
    /**
     * Session-bound author identifier — the `id` half of
     * `SessionUser.requestor`. Always populated; the route gates on
     * the presence of a session-bound requestor before insert so a
     * row without an attribution is impossible.
     */
    authorId: text("author_id").notNull(),
    /**
     * Free-text comment body, capped at 4 KB by the route's Zod
     * validator (matches the existing reviewer-annotation /
     * submission-note convention).
     */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    /**
     * Drives the thread read query — list every comment under a
     * submission, oldest-first.
     */
    submissionIdx: index("submission_comments_submission_idx").on(
      t.submissionId,
      t.createdAt,
    ),
    authorRoleCheck: check(
      "submission_comments_author_role_check",
      sql`${t.authorRole} IN ('architect', 'reviewer')`,
    ),
  }),
);

export const submissionCommentsRelations = relations(
  submissionComments,
  ({ one }) => ({
    submission: one(submissions, {
      fields: [submissionComments.submissionId],
      references: [submissions.id],
    }),
  }),
);

export type SubmissionComment = typeof submissionComments.$inferSelect;
export type NewSubmissionComment = typeof submissionComments.$inferInsert;
