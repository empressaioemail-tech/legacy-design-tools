import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { submissions } from "./submissions";

/**
 * PLR-11 — derived state for the city-seal-stamped issued plan-set
 * PDF rendered alongside an `approve` / `approve_with_conditions`
 * verdict. Keyed by `decisionId` (the entity id of the
 * `decision-event` atom). The recorded event itself stays free of
 * artifact references — the chain hash would otherwise need to be
 * recomputed when the artifact lands. The decision atom's
 * contextSummary joins this table to surface `pdfArtifactRef` /
 * `permitNumber` / `approverName` to atom consumers.
 */
export const decisionPdfArtifacts = pgTable(
  "decision_pdf_artifacts",
  {
    decisionId: uuid("decision_id").primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    /** `/objects/<uuid>` of the rendered PDF in object storage. */
    pdfArtifactRef: text("pdf_artifact_ref").notNull(),
    /** Tenant-scoped permit number stamped on every sheet. */
    permitNumber: text("permit_number").notNull(),
    /** Approver display name (from `users.displayName`) printed on the stamp. */
    approverName: text("approver_name").notNull(),
    /** Wall-clock the render landed; matches the recorded event's `occurredAt`. */
    approvalDate: timestamp("approval_date", { withTimezone: true }).notNull(),
    renderedAt: timestamp("rendered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    submissionIdx: index("decision_pdf_artifacts_submission_idx").on(
      t.submissionId,
      t.renderedAt,
    ),
  }),
);

export type DecisionPdfArtifact = typeof decisionPdfArtifacts.$inferSelect;
export type NewDecisionPdfArtifact = typeof decisionPdfArtifacts.$inferInsert;
