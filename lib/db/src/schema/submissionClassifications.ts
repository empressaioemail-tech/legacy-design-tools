import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * Track 1 — auto-classification of plan-review submissions.
 *
 * One row per submission (PK FK to `submissions.id` with `ON DELETE
 * CASCADE`) carrying:
 *   - `projectType`        — free-text label produced by the classifier
 *                            ("commercial-tenant-improvement",
 *                             "residential-addition", …). Free-text on
 *                            purpose: the classifier emits an open
 *                            vocabulary today; constraining to an enum
 *                            would require coordinating retrains every
 *                            time we discover a new project shape.
 *   - `disciplines`        — closed enum array of `PlanReviewDiscipline`
 *                            values (the 7-value reviewer-certification
 *                            vocabulary, distinct from the 4-value
 *                            `submissions.discipline` legacy column).
 *   - `applicableCodeBooks`— free-text array ("IBC 2021", "NEC 2020", …).
 *                            Open vocabulary because the classifier picks
 *                            from whatever the cover-sheet text + RAG
 *                            retrieval surfaces.
 *   - `confidence`         — 0..1 numeric, mirrors the `findings.confidence`
 *                            convention (rounding is the renderer's
 *                            problem; the FE renders `confidence.toFixed(2)`).
 *   - `source`             — `'auto' | 'reviewer'`. `auto` on the
 *                            classifier's first write; flipped to
 *                            `reviewer` on a `POST /api/submissions/:id/reclassify`
 *                            correction.
 *   - `classifiedBy`       — actor envelope (`{kind,id}`) recorded at
 *                            write time. Null on the auto path; set to
 *                            the reviewer's session actor on reclassify.
 *
 * One-to-one with submissions on purpose (instead of denormalizing onto
 * the `submissions` row): the reclassify route overwrites the row in
 * place and emits a `submission.reclassified` event with the before/after
 * payload — the audit trail lives on the atom-event chain (locked
 * decision #5: rows-over-events for queryable state, events for history).
 *
 * Discipline enum values match `PlanReviewDiscipline` in
 * `lib/api-zod/src/types/planReviewDiscipline.ts` — the source-of-truth
 * for the 7-value reviewer-certification vocabulary. The CHECK constraint
 * here is duplicated literally because Drizzle's CHECK builder cannot
 * interpolate a TS array; keep it in lock-step with the enum.
 *
 * The `disciplines` GIN index supports the reviewer-queue / canned-findings
 * "show me classifications that overlap my discipline scope" query
 * pattern (`disciplines && ARRAY[...]`).
 */

export const submissionClassifications = pgTable(
  "submission_classifications",
  {
    submissionId: uuid("submission_id")
      .primaryKey()
      .references(() => submissions.id, { onDelete: "cascade" }),
    projectType: text("project_type"),
    disciplines: text("disciplines")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    applicableCodeBooks: text("applicable_code_books")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    confidence: numeric("confidence"),
    source: text("source").notNull().default("auto"),
    /**
     * `{kind,id}` actor envelope captured at write time. Null on the
     * auto-classifier path (the engine has no session actor); set on a
     * reclassify call to the session's resolved requestor.
     */
    classifiedBy: jsonb("classified_by"),
    classifiedAt: timestamp("classified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    sourceCheck: check(
      "submission_classifications_source_check",
      sql`${t.source} IN ('auto', 'reviewer')`,
    ),
    /**
     * Closed-set enforcement at the DB layer for the `PlanReviewDiscipline`
     * vocabulary. Kept literal because the Drizzle CHECK builder cannot
     * interpolate a TS array — pair this with the
     * `PLAN_REVIEW_DISCIPLINE_VALUES` tuple in `api-zod`.
     */
    disciplinesCheck: check(
      "submission_classifications_disciplines_check",
      sql`${t.disciplines} <@ ARRAY['building','electrical','mechanical','plumbing','residential','fire-life-safety','accessibility']::text[]`,
    ),
    disciplinesGinIdx: index("submission_classifications_disciplines_gin_idx")
      .using("gin", t.disciplines),
  }),
);

export type SubmissionClassification =
  typeof submissionClassifications.$inferSelect;
export type NewSubmissionClassification =
  typeof submissionClassifications.$inferInsert;

export const SUBMISSION_CLASSIFICATION_SOURCE_VALUES = [
  "auto",
  "reviewer",
] as const;
export type SubmissionClassificationSource =
  (typeof SUBMISSION_CLASSIFICATION_SOURCE_VALUES)[number];
