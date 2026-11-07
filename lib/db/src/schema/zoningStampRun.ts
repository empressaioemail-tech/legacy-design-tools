import {
  pgTable,
  bigserial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * One row per non-dry-run `zoning-stamp --city=<key>` CLI invocation
 * (`zoning-cli.ts` / `zoning-stamp-db.ts`, migration 0112). This is the
 * independent reference hauska-factory's gate 1 (`load-reconciliation-gate`)
 * reconciles stored `txgio_parcel` zoning rows against, per city — the gap
 * the 2026-10-09 Burnet record (stage 3 section 5) names: the stamp's own
 * success was never durable, so a truncated and a correct run left the same
 * signal behind.
 *
 * See the migration file's own comment for the full rationale and the
 * mapping from each count column back to `ZoningStampSummary`'s field names.
 */
export const zoningStampRun = pgTable(
  "zoning_stamp_run",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** 5-digit county FIPS, e.g. `48053` (Burnet). */
    countyFips: text("county_fips").notNull(),
    /** ZONING_LAYERS cityKey this run stamped, e.g. `marble-falls-tx`. */
    cityKey: text("city_key").notNull(),
    /** The public ArcGIS layer URL fetched (ZoningLayerConfig.layerUrl). */
    layerUrl: text("layer_url").notNull(),
    /** When this run fetched the layer — a read timestamp, not a layer vintage. */
    layerReadAt: timestamp("layer_read_at", { withTimezone: true }).notNull(),
    /** summary.parcelsRead — DISTINCT feature_index read for the county. */
    featuresRead: integer("features_read").notNull(),
    /**
     * summary.parcelsMatched + parcelsPlannedDevelopment + parcelsUnrecognised:
     * every feature that got SOME code written to zoning_district.
     */
    matched: integer("matched").notNull(),
    /** summary.parcelsNoDistrictOnLayer (Bug 2's declared blank-code bucket). */
    noDistrictOnLayer: integer("no_district_on_layer").notNull(),
    /** summary.parcelsUnmatched — no zoning polygon held the representative point. */
    parcelsNull: integer("parcels_null").notNull(),
    /** summary.parcelsIdGeometryMismatch — an id match whose feature didn't contain the parcel. */
    idGeometryMismatch: integer("id_geometry_mismatch").notNull(),
    /**
     * summary.codeHistogram merged with summary.unrecognisedHistogram: every
     * code value this run actually wrote to zoning_district, by count. Gate
     * 1's vocabulary check reads this column, so it must cover every code the
     * run could have written, not only the "base" subset.
     */
    codeHistogram: jsonb("code_histogram").notNull(),
    /**
     * Always false — `--dry-run` never calls the function that inserts this
     * row (zoning-cli.ts). The CHECK constraint makes that invariant visible
     * in the schema, not only in the caller.
     */
    dryRun: boolean("dry_run").notNull().default(false),
    finishedAt: timestamp("finished_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    cityFinishedIdx: index("zoning_stamp_run_city_finished_idx").on(
      t.countyFips,
      t.cityKey,
      t.finishedAt,
    ),
    dryRunFalseChk: check("zoning_stamp_run_dry_run_false_chk", sql`${t.dryRun} = false`),
    countyFipsChk: check("zoning_stamp_run_county_fips_chk", sql`${t.countyFips} <> ''`),
    cityKeyChk: check("zoning_stamp_run_city_key_chk", sql`${t.cityKey} <> ''`),
  }),
);

export type ZoningStampRunRow = typeof zoningStampRun.$inferSelect;
export type ZoningStampRunInsert = typeof zoningStampRun.$inferInsert;
