import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Frozen baseline scores per (fixtureKey, componentKey). The CI eval
 * workflow joins the PR's `eval_scores` rows against these to compute
 * `passedThreshold` and to populate the scorecard PR comment.
 *
 * Baselines are intentionally NOT keyed on an eval_run_id — they are
 * a curated snapshot updated by `pnpm eval baseline <fixture>` after
 * an operator has inspected the most recent run and decided "yes, this
 * is the new floor". The `commitHash` column records which engine
 * commit produced the score at the moment it was promoted.
 */
export const evalBaselines = pgTable(
  "eval_baselines",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fixtureKey: text("fixture_key").notNull(),
    componentKey: text("component_key").notNull(),
    baselineScore: numeric("baseline_score", {
      precision: 20,
      scale: 6,
    }).notNull(),
    /**
     * How far a new score may drop below baseline before counting as a
     * regression. Stored as a fraction of the baseline (e.g. 0.05 = 5%
     * drop). For absolute-unit components (latency, cost) the same
     * fractional interpretation applies — a 5% latency increase is a
     * regression.
     *
     * Set per-component because tolerance differs (citation validity
     * should not regress at all; latency may swing 10%+ on cold runs).
     */
    regressionThreshold: numeric("regression_threshold", {
      precision: 6,
      scale: 4,
    }).notNull(),
    lastUpdated: timestamp("last_updated", { withTimezone: true })
      .defaultNow()
      .notNull(),
    /** Engine commit hash when the baseline was promoted. */
    commitHash: text("commit_hash").notNull(),
  },
  (t) => ({
    /**
     * One live baseline per (fixture, component). Reseating a baseline
     * is an UPDATE, not an INSERT — the unique index enforces that.
     */
    fixtureComponentUniq: uniqueIndex("eval_baselines_fixture_component_uniq").on(
      t.fixtureKey,
      t.componentKey,
    ),
  }),
);

export type EvalBaseline = typeof evalBaselines.$inferSelect;
export type NewEvalBaseline = typeof evalBaselines.$inferInsert;
