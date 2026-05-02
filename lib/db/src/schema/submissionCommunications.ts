import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * Communication-event row (PLR-5). Persists each AI-drafted comment
 * letter the reviewer sends from the Communicate composer. Hangs off
 * a single plan-review submission and is treated as audit-grade
 * append-only — neither the body nor the recipient list is mutable
 * after insert. The corresponding `communication-event` atom (and
 * its `communication-event.sent` history event) anchor against
 * `id`.
 *
 * Email dispatch is intentionally out-of-scope for this row: the
 * api-server has no outbound-mail pipeline yet (`notifications.ts`
 * is the in-app architect surface), so the route layer logs the
 * intended recipient list and persists it for a future dispatcher to
 * pick up. Distinct from `submission_comments`, which carries the
 * inline reviewer↔architect chat thread and is freely editable.
 */
export const submissionCommunications = pgTable(
  "submission_communications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /**
     * Atom id assigned at insert time using the
     * `communication-event:{submissionId}:{rowId}` grammar so the
     * empressa-atom registry can look the row up by its public id.
     */
    atomId: text("atom_id").notNull().unique(),
    /** Reviewer-edited subject line. */
    subject: text("subject").notNull(),
    /** Reviewer-edited markdown body (post-edit, post-AI draft). */
    body: text("body").notNull(),
    /**
     * Snapshot of the open-finding atom ids the draft was assembled
     * from. Audit trail — lets a future "what changed since this
     * letter" view diff against current findings.
     */
    findingAtomIds: jsonb("finding_atom_ids").notNull(),
    /**
     * Recipient list as opaque user / contact ids. Empty array is
     * legal — the route falls back to logging when no architect-of-
     * record contact exists on the parent engagement.
     */
    recipientUserIds: jsonb("recipient_user_ids").notNull(),
    /**
     * Stable actor envelope (`{kind,id,displayName?}`) of the
     * reviewer who sent the letter, captured at send time so a later
     * profile-row removal can't rewrite history.
     */
    sentBy: jsonb("sent_by").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    submissionIdx: index("submission_communications_submission_idx").on(
      t.submissionId,
      t.sentAt,
    ),
  }),
);

export const submissionCommunicationsRelations = relations(
  submissionCommunications,
  ({ one }) => ({
    submission: one(submissions, {
      fields: [submissionCommunications.submissionId],
      references: [submissions.id],
    }),
  }),
);

export type SubmissionCommunication =
  typeof submissionCommunications.$inferSelect;
export type NewSubmissionCommunication =
  typeof submissionCommunications.$inferInsert;
