import {
  pgTable,
  text,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Statewide county boundary store — U.S. Census TIGERweb State_County
 * (feat/city-county-boundary-layer, layer-first L1).
 *
 * Texas county polygons from the keyless Census TIGERweb ArcGIS REST at
 * `tigerweb.geo.census.gov/.../TIGERweb/State_County/MapServer/1`
 * (Counties layer; layer 0 is States — verified by adversarial probe
 * 2026-08-08: layer 0 returns 1 TX feature, layer 1 returns 254).
 * TxGIO publishes no dedicated county-boundary service (every TxGIO folder
 * probed 2026-08-08).
 *
 * Loaded by the `@workspace/cad-ingest` boundary-ingest CLI alongside the
 * TxGIO city layer. Keyed `county_fips` (5-digit GEOID, e.g. `48453`).
 *
 * Geometry is GeoJSON in WGS84. Every point in Texas resolves to exactly
 * one county polygon via the containment helper.
 */
export const txCountyBoundary = pgTable(
  "tx_county_boundary",
  {
    /** 5-digit county GEOID, e.g. `48453` (Travis). */
    countyFips: text("county_fips").notNull(),
    /** Display name as shipped, e.g. `Travis County`. */
    countyName: text("county_name").notNull(),
    /** State FIPS; always `48` for this store. */
    stateFips: text("state_fips").notNull().default("48"),
    geometry: jsonb("geometry").notNull(),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    source: text("source").notNull(),
    sourceVintage: text("source_vintage").notNull(),
    sourceCitation: text("source_citation").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips] }),
    bboxIdx: index("tx_county_boundary_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
  }),
);

export type TxCountyBoundaryRow = typeof txCountyBoundary.$inferSelect;
export type TxCountyBoundaryInsert = typeof txCountyBoundary.$inferInsert;
