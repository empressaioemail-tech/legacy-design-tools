import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Append-only rail cell history for the County Manifest console.
 *
 * `county_facet_coverage` stores CURRENT state, overwritten in place. This
 * table captures every material change (and optional nightly heartbeats) so
 * the TRENDS panel can render sparklines, diff strips, and regression
 * detection — a rail without history is a rail whose regressions are invisible.
 *
 * Written by `manifestObservability.ts` on cell change (primary) and by a
 * nightly cadence that skips cells already snapshotted that UTC day.
 */
export const railStateHistory = pgTable(
  "rail_state_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    countyFips: text("county_fips").notNull(),
    /** Matches `county_rail.rail_key` / `county_facet_coverage.facet`. */
    railKey: text("rail_key").notNull(),
    railState: text("rail_state"),
    honestCoveragePct: numeric("honest_coverage_pct", {
      precision: 5,
      scale: 2,
    }),
    thresholdPct: numeric("threshold_pct", { precision: 5, scale: 2 }),
    /** `last_verified_at` at snapshot time (may differ from `recorded_at`). */
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    /** Optional back-pointer to `manifest_run.id`. */
    runId: uuid("run_id"),
    /** `cell-change` | `nightly` | `manual`. */
    snapshotReason: text("snapshot_reason").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("rail_state_history_cell_recorded_idx").on(
      t.countyFips,
      t.railKey,
      t.recordedAt,
    ),
    index("rail_state_history_recorded_at_idx").on(t.recordedAt),
    check(
      "rail_state_history_rail_state_check",
      sql`${t.railState} IS NULL OR ${t.railState} IN ('satisfied-present', 'satisfied-absent', 'not-yet')`,
    ),
    check(
      "rail_state_history_snapshot_reason_check",
      sql`${t.snapshotReason} IN ('cell-change', 'nightly', 'manual')`,
    ),
  ],
);

export type RailStateHistoryRow = typeof railStateHistory.$inferSelect;
export type RailStateHistoryInsert = typeof railStateHistory.$inferInsert;
