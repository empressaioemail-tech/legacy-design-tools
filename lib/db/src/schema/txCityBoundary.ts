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
 * Statewide incorporated-place boundary store — TxGIO City_Boundaries
 * (feat/city-county-boundary-layer, layer-first L1).
 *
 * Free public-domain city-limit polygons from the Texas Geographic
 * Information Office City_Boundaries program, served as open paginated
 * ArcGIS REST at
 * `feature.geographic.texas.gov/.../City_Boundaries/Texas_City_Boundaries/MapServer/0`
 * (~1,225 CPA polygons; CPA geometry retained as authoritative source with
 * Census attributes added per the service description). Loaded by the
 * `@workspace/cad-ingest` boundary-ingest CLI in one statewide pass.
 *
 * Keyed `geo_id` (CPA 7-char place identifier, e.g. `4805000` for Austin).
 * Unincorporated territory is NOT represented here — a point outside every
 * polygon is the honest `unincorporated` answer from the containment helper,
 * not a missing row.
 *
 * Geometry is GeoJSON Polygon/MultiPolygon in WGS84. Per-feature bbox
 * columns back viewport pre-filter without decoding jsonb.
 *
 * Idempotency: the ingest replaces the layer wholesale (DELETE all rows,
 * then batch-insert with ON CONFLICT DO UPDATE).
 */
export const txCityBoundary = pgTable(
  "tx_city_boundary",
  {
    /** CPA geo_id, e.g. `4805000` (Austin). Primary key. */
    geoId: text("geo_id").notNull(),
    /** Display name as shipped, e.g. `Austin`. */
    cityName: text("city_name").notNull(),
    /** GNIS identifier when present. */
    gnis: text("gnis"),
    /** GeoJSON geometry (WGS84). */
    geometry: jsonb("geometry").notNull(),
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    /** Owning organization label, e.g. `TxGIO/CPA`. */
    source: text("source").notNull(),
    /** Program vintage label recorded at ingest. */
    sourceVintage: text("source_vintage").notNull(),
    /** Canonical service URL citation. */
    sourceCitation: text("source_citation").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.geoId] }),
    bboxIdx: index("tx_city_boundary_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
  }),
);

export type TxCityBoundaryRow = typeof txCityBoundary.$inferSelect;
export type TxCityBoundaryInsert = typeof txCityBoundary.$inferInsert;
