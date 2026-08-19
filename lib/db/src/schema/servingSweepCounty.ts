import { pgTable, text, jsonb, integer, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * SS-W7 (P-44) — one ingested CountyServingSweep per county.
 *
 * The County Manifest answers "did a writer run for this county".
 * A serving sweep answers a different question: "what does Smart Site
 * actually SERVE a human, for every parcel in this county". The two
 * disagree, and the disagreement is the finding — so they are stored
 * separately and never reconciled into one number here.
 *
 * The record shape is FROZEN by the planner at doc_repo
 * `_catalog/parcel_fact_sheet_contract/serving-sweep.ts`. `payload` holds a
 * whole CountyServingSweep exactly as its producer (lane P-43, hauska-engine)
 * emitted it, validated against the frozen record at ingest. The four
 * scalar columns are DERIVED FROM THAT PAYLOAD at ingest time (never
 * supplied independently) so the county index and the statewide envelope
 * can be assembled without parsing every blob.
 *
 * There is deliberately NO statewide row. `StatewideServingSweep` is
 * ASSEMBLED at read time from the county rows present, so `countiesSwept`
 * is always measured from the array actually served and can never be a
 * stored claim that drifts away from it.
 *
 * A sweep runs county by county over hours, so a county is upserted on its
 * `county_fips` and the newest sweep for a county replaces the older one.
 */
export const servingSweepCounty = pgTable(
  "serving_sweep_county",
  {
    countyFips: text("county_fips").primaryKey(),
    /** Derived from payload.countyName. */
    countyName: text("county_name").notNull(),
    /** Derived from payload.sweptAt — when the SWEEP ran, not when it was ingested. */
    sweptAt: timestamp("swept_at", { withTimezone: true }).notNull(),
    /** Derived from payload.resolverVersion — the ParcelFactSheet resolver swept against. */
    resolverVersion: text("resolver_version").notNull(),
    /** Derived from payload.parcelsTotal. Every parcel on the roster; the sweep never samples. */
    parcelsTotal: integer("parcels_total").notNull(),
    /** The full CountyServingSweep, frozen shape. */
    payload: jsonb("payload").notNull(),
    /** When cortex-api received it. Distinct from sweptAt and never a substitute for it. */
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    check(
      "serving_sweep_county_fips_check",
      sql`${t.countyFips} ~ '^[0-9]{5}$'`,
    ),
    check(
      "serving_sweep_county_parcels_total_check",
      sql`${t.parcelsTotal} >= 0`,
    ),
  ],
);

export type ServingSweepCountyRow = typeof servingSweepCounty.$inferSelect;
export type ServingSweepCountyInsert = typeof servingSweepCounty.$inferInsert;
