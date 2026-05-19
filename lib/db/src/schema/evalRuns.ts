import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { engagements } from "./engagements";

/**
 * Eval-harness run. One row per kickoff of `pnpm eval run <fixture>`
 * (manual, CI, or scheduled). Mirrors the `finding_runs` shape so the
 * aggregator can join across both tables when producing scorecards.
 *
 * Why a real table: the eval CLI's `report <evalRunId>` command needs
 * to look up arbitrary historical runs by id, and the GitHub Actions
 * scorecard comment posts a link to a run that must survive the
 * workflow-runner's process death. Same reasoning as
 * `briefingGenerationJobs` / `finding_runs`.
 *
 * The per-component scores live on `eval_scores`; this table carries
 * only the run-level envelope (which fixture, which engine commit,
 * what total cost, total wall-clock, trigger source). One row of
 * eval_runs → many rows of eval_scores via `eval_run_id`.
 *
 * Identity: the row's `id` IS the public `evalRunId` returned to the
 * CLI on kickoff and written into PR-comment links by the CI workflow.
 */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /**
     * The engagement the eval ran against. Nullable for retrieval-only
     * runs (which exercise the codes corpus without binding to a
     * specific project) and for early scaffold-stage runs that have no
     * seeded engagement yet (Arena Roja R1 sits in this state until
     * the SCA-comment ground-truth + seed land).
     */
    engagementId: uuid("engagement_id").references(() => engagements.id, {
      onDelete: "set null",
    }),
    /**
     * Fixture key from `lib/eval/src/fixtures/` — `musgrave`, `seguin`,
     * `arena-roja-r1`, etc. Joined-on by the aggregator so per-fixture
     * trends survive across engine commits.
     */
    fixtureKey: text("fixture_key").notNull(),
    /**
     * Engine commit hash at the moment the runner kicked off. Lets
     * baselines tie scores to a specific engine SHA so regressions are
     * attributable to a known change set.
     */
    engineVersion: text("engine_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** `running` | `completed` | `failed` — narrowed by the CLI. */
    state: text("state").notNull(),
    /** Verbatim runner-failure message (truncated to ~1KB). */
    error: text("error"),
    /**
     * Total Anthropic spend across every `messages.create` call the
     * run made, in USD. Computed by the instrumented client wrapper as
     * `input_tokens * input_price + output_tokens * output_price`. Null
     * while running; null on retrieval-only runs (no LLM calls).
     */
    totalCostUsd: numeric("total_cost_usd", { precision: 12, scale: 6 }),
    /** Sum of wall-clock duration across every runner sub-call. */
    totalDurationMs: integer("total_duration_ms"),
    /** `manual` | `ci` | `scheduled`. */
    triggerSource: text("trigger_source").notNull(),
  },
  (t) => ({
    /**
     * Aggregator queries the most recent run per fixture frequently
     * ("what's the current baseline-comparison?"); index supports both
     * fixture-scoped and time-ordered lookups.
     */
    fixtureStartedIdx: index("eval_runs_fixture_started_idx").on(
      t.fixtureKey,
      t.startedAt,
    ),
  }),
);

export const evalRunsRelations = relations(evalRuns, ({ one }) => ({
  engagement: one(engagements, {
    fields: [evalRuns.engagementId],
    references: [engagements.id],
  }),
}));

export type EvalRun = typeof evalRuns.$inferSelect;
export type NewEvalRun = typeof evalRuns.$inferInsert;
