import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Per-cell verification audit trail for the County Manifest console.
 *
 * Multiple rows per `(county_fips, rail_key)` over time. The seven verification
 * columns on `county_facet_coverage` (0069) are an optional denormalized
 * "latest" cache; this table is the load-bearing OPS-5 sample-vs-sweep record.
 *
 * Honest absence: no row means never verified. A row with
 * `verificationOutcome = 'confirmed-absent'` means verified and found absent —
 * distinct from missing verification.
 */
export const railVerification = pgTable(
  "rail_verification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    countyFips: text("county_fips").notNull(),
    railKey: text("rail_key").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    verifiedByInstrument: text("verified_by_instrument").notNull(),
    /**
     * `sweep` | `sample` | `probe` | `derived` | `roster-load` | `unverified`.
     * Superset of the 0069 column enum — probe and derived are verification-
     * table-only until a future additive migration extends the ledger column.
     */
    verificationMethod: text("verification_method").notNull(),
    /**
     * `confirmed-present` | `confirmed-absent` | `inconclusive` | `method-only`.
     */
    verificationOutcome: text("verification_outcome").notNull(),
    artifactPath: text("artifact_path"),
    runId: uuid("run_id"),
    notes: text("notes"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("rail_verification_cell_verified_idx").on(
      t.countyFips,
      t.railKey,
      t.verifiedAt,
    ),
    index("rail_verification_run_idx").on(t.runId),
    check(
      "rail_verification_method_check",
      sql`${t.verificationMethod} IN ('sweep', 'sample', 'probe', 'derived', 'roster-load', 'unverified')`,
    ),
    check(
      "rail_verification_outcome_check",
      sql`${t.verificationOutcome} IN ('confirmed-present', 'confirmed-absent', 'inconclusive', 'method-only')`,
    ),
  ],
);

export type RailVerificationRow = typeof railVerification.$inferSelect;
export type RailVerificationInsert = typeof railVerification.$inferInsert;
