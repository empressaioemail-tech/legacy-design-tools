import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { evalRuns } from "./evalRuns";

/**
 * Per-rubric-component score row, one per (evalRunId, componentKey).
 * The rubric component catalog lives in `lib/eval/src/rubric.ts`; the
 * v1 set is:
 *
 *   - citation-validity
 *   - citation-accuracy           (LLM-graded; requiresHumanReview)
 *   - finding-recall              (ground-truth-required)
 *   - finding-precision           (sample-for-review; no auto-score v1)
 *   - retrieval-top3
 *   - retrieval-section-number
 *   - retrieval-cross-ref
 *   - latency-finding-p50/p95/p99
 *   - latency-briefing-p50/p95/p99
 *   - latency-retrieval-p50/p95/p99
 *   - cost-per-finding-run
 *   - cost-per-jurisdiction
 *
 * Deferred (Bump 1 / design-fresh in hauska-engine, slot reserved):
 *   - mode-budget-conformance
 *   - geometric-reasoning-accuracy
 *   - sheet-content-extraction-fidelity
 *   - bim-model-symmetry
 *
 * The schema deliberately stores `componentKey` as free text rather
 * than a fixed enum: adding a new component should be a code change in
 * rubric.ts (and a baseline-recapture run), not a migration. The
 * aggregator validates against the live rubric registry at query time.
 */
export const evalScores = pgTable(
  "eval_scores",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    evalRunId: uuid("eval_run_id")
      .notNull()
      .references(() => evalRuns.id, { onDelete: "cascade" }),
    /** Rubric component key — kebab-case, matches rubric.ts catalog. */
    componentKey: text("component_key").notNull(),
    /**
     * Numeric score. Unit is tagged on `scoreUnit` so a single column
     * holds fractions (0-1), absolute durations (ms), dollar amounts
     * (USD), and counts. Aggregator interprets per-unit.
     *
     * Numeric(20, 6) holds an integer ms duration up to ~316 years
     * comfortably, and a USD amount to micro-cent precision — both
     * enough headroom for the v1 components.
     */
    score: numeric("score", { precision: 20, scale: 6 }).notNull(),
    /** `fraction` | `ms` | `usd` | `count`. */
    scoreUnit: text("score_unit").notNull(),
    /**
     * Did this score clear the regression threshold against the
     * matching `eval_baselines` row? Null when no baseline exists yet
     * (e.g. first run of a new fixture).
     */
    passedThreshold: boolean("passed_threshold"),
    /**
     * Component-specific evidence (per-finding precision sample,
     * per-query retrieval miss list, cost breakdown by call, etc.).
     * The CLI's `report` command pretty-prints what's relevant per
     * component.
     */
    details: jsonb("details"),
  },
  (t) => ({
    /**
     * Aggregator's "scores for this run" query and "scores for this
     * component across runs" trend query both want this composite.
     */
    runComponentIdx: index("eval_scores_run_component_idx").on(
      t.evalRunId,
      t.componentKey,
    ),
  }),
);

export const evalScoresRelations = relations(evalScores, ({ one }) => ({
  evalRun: one(evalRuns, {
    fields: [evalScores.evalRunId],
    references: [evalRuns.id],
  }),
}));

export type EvalScore = typeof evalScores.$inferSelect;
export type NewEvalScore = typeof evalScores.$inferInsert;
