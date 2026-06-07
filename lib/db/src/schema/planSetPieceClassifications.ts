import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { submissions } from "./submissions";

/**
 * Per-piece discipline classification for plan-set decomposition (WS1).
 *
 * One row per ingested sheet or attached-document piece on a submission.
 * Populated before the orchestrated finding-engine pass; drives per-
 * discipline specialist dispatch.
 */
export const PLAN_SET_PIECE_KIND_VALUES = ["sheet", "attached-document"] as const;
export type PlanSetPieceKind = (typeof PLAN_SET_PIECE_KIND_VALUES)[number];

export const PLAN_SET_CLASSIFICATION_SOURCE_VALUES = ["rule", "llm"] as const;
export type PlanSetClassificationSource =
  (typeof PLAN_SET_CLASSIFICATION_SOURCE_VALUES)[number];

export const planSetPieceClassifications = pgTable(
  "plan_set_piece_classifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    pieceKind: text("piece_kind").notNull(),
    /** FK target id — `sheets.id` or `attached_documents.id`. */
    pieceId: uuid("piece_id").notNull(),
    /**
     * Closed `PlanReviewDiscipline` value. Kept literal in the CHECK
     * below — mirror `lib/api-zod/src/types/planReviewDiscipline.ts`.
     */
    discipline: text("discipline").notNull(),
    confidence: numeric("confidence").notNull(),
    source: text("source").notNull().default("rule"),
    classifiedAt: timestamp("classified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    submissionIdx: index("plan_set_piece_classifications_submission_idx").on(
      t.submissionId,
    ),
    pieceUnique: uniqueIndex("plan_set_piece_classifications_piece_unique").on(
      t.pieceKind,
      t.pieceId,
    ),
    pieceKindCheck: check(
      "plan_set_piece_classifications_piece_kind_check",
      sql`${t.pieceKind} IN ('sheet', 'attached-document')`,
    ),
    sourceCheck: check(
      "plan_set_piece_classifications_source_check",
      sql`${t.source} IN ('rule', 'llm')`,
    ),
    disciplineCheck: check(
      "plan_set_piece_classifications_discipline_check",
      sql`${t.discipline} IN ('building', 'electrical', 'mechanical', 'plumbing', 'residential', 'fire-life-safety', 'accessibility')`,
    ),
  }),
);

export type PlanSetPieceClassification =
  typeof planSetPieceClassifications.$inferSelect;
export type NewPlanSetPieceClassification =
  typeof planSetPieceClassifications.$inferInsert;
