import {
  pgTable,
  bigint,
  text,
  integer,
  boolean,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Williamson CAD (WCAD) per-property land-segment detail, acquired
 * 2026-09-03 (Socrata portal pull, separate from and later than the
 * 2026-08-25 StratMap leftover-farm fill that populates most of
 * Williamson's `cad_property` rows — see F-01,
 * `_inbox/2026-09-05_engine-williamson-mclennan-geomgap-nulls_close.json`).
 *
 * One row per land segment on a property, keyed loosely by `prop_id`
 * (the SAME key `cad_property` uses for Williamson, county_fips 48491) —
 * a property can carry many rows (real large ranches sampled with up to
 * ~29 segments), each an additive physical land segment, never
 * competing readings of the same land. `land_type` names the segment
 * kind (R residential, L vacant land, C commercial, several ag/pasture/
 * wildlife-management categories, ...) and is self-documented on every
 * row via `description` — no external code table needed.
 *
 * `value` vs `curr_value`: distinct, real columns (differ on ~66% of
 * Residential rows), not a duplicate field. `value` is the market-rate
 * figure `cad_property.land_value` is documented to want elsewhere in
 * this codebase (`lib/cad-ingest/src/pacs/parser.ts`'s own `land_value =
 * ... + ag_market + timber_market` — "ag/timber market is how rural
 * land market value is carried"); `curr_value` is presumed to be a
 * current/ag-productivity-adjusted figure and is deliberately NOT read
 * by the reconciliation in `williamsonAgValuation.ts`.
 *
 * `acres` is null on the majority of rows (real source shape, not a
 * parsing gap — small residential lots routinely carry a dollar value
 * with no recorded acreage). A `land_value` reconciliation from this
 * table will resolve comprehensively; a `land_acres` reconciliation
 * will only resolve the subset of properties whose land rows happen to
 * carry acreage.
 */
export const txWcadAgValuation = pgTable("tx_wcad_ag_valuation", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  propId: text("prop_id").notNull(),
  wcadPropertyId: text("wcad_property_id"),
  propertyNumber: text("property_number"),
  recordType: text("record_type"),
  sequence: integer("sequence"),
  landType: text("land_type"),
  description: text("description"),
  stateCode: text("state_code"),
  homesiteFlag: boolean("homesite_flag"),
  apprMethod: text("appr_method"),
  acres: numeric("acres"),
  value: numeric("value"),
  currValue: numeric("curr_value"),
  agYear: text("ag_year"),
  rawAgFlag: text("raw_ag_flag"),
  agFlag: boolean("ag_flag").notNull(),
  source: text("source").notNull(),
  sourceVintage: text("source_vintage").notNull(),
  sourceCitation: text("source_citation").notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  countyFips: text("county_fips"),
});

export type TxWcadAgValuationRow = typeof txWcadAgValuation.$inferSelect;
