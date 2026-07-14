import {
  pgTable,
  text,
  integer,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Self-hosted parcel GEOMETRY store — TxGIO/StratMap statewide Land
 * Parcels program (feat/txgio-parcel-geometry).
 *
 * Free public-domain per-county parcel polygons from the Texas
 * Geographic Information Office Land Parcels collection
 * (data.geographic.texas.gov, stratmap25 vintage), loaded by the
 * `@workspace/cad-ingest` txgio-ingest CLI. Covers counties that have
 * CAD roll data (`cad_property`) but NO live queryable county GIS —
 * v1: Hays (48209) and Comal (48091). Counties with a live county
 * ArcGIS service keep being served live (`brokerageTxParcels.ts`) and
 * are NOT bulk-loaded here.
 *
 * Geometry is GeoJSON (WGS84 — the stratmap25 shapefiles ship in
 * GCS_WGS_1984; verified against the .prj of the real downloads).
 * TxGIO parcels are informational, not survey grade, per the program's
 * own disclaimer — consumers must carry `notSurveyGrade`, same
 * convention as the county-GIS provider (#242).
 *
 * Keyed (county_fips, tile_key, feature_index):
 *  - `tile_key` is a snapped grid CELL key (same 0.02-degree grid math
 *    as the #242 `tileKey()` helper, single-cell form `g0.02:<w>,<s>`).
 *    A feature is written once per grid cell its bbox intersects, so a
 *    bbox read is a `tile_key IN (covering cells)` equality scan on the
 *    primary key and a point read is a single-cell scan + ray-cast.
 *    Parcels are far smaller than a cell (~2.2 km), so the duplication
 *    factor is small.
 *  - `feature_index` is the feature's sequence number in the source
 *    shapefile — the dedupe key across cells.
 *
 * Idempotency: the ingest CLI replaces a county wholesale (DELETE
 * county rows, then batch-insert with ON CONFLICT DO UPDATE), so
 * re-running an ingest or loading a fresher vintage never strands
 * stale rows under abandoned keys.
 *
 * The per-feature bbox columns (`west_lng`..`north_lat`) let readers
 * filter candidate rows to true bbox intersection without decoding
 * geometry, and back a fallback scan when a request bbox would cover
 * an unreasonable number of cells.
 */
export const txgioParcel = pgTable(
  "txgio_parcel",
  {
    /** 5-digit county FIPS, e.g. `48209` (Hays). */
    countyFips: text("county_fips").notNull(),
    /** Snapped grid cell key, e.g. `g0.02:-97.94000,29.88000`. */
    tileKey: text("tile_key").notNull(),
    /** Feature sequence number in the source shapefile (0-based). */
    featureIndex: integer("feature_index").notNull(),
    /** CAD property id as shipped (trimmed; may be absent upstream). */
    propId: text("prop_id"),
    /** CAD geographic id, e.g. `10-0017-2321-00000-3`. */
    geoId: text("geo_id"),
    ownerName: text("owner_name"),
    /** Single situs line as shipped, e.g. `707 UHLAND RD, SAN MARCOS, TX 78666`. */
    situsAddress: text("situs_address"),
    situsCity: text("situs_city"),
    situsState: text("situs_state"),
    situsZip: text("situs_zip"),
    /** GeoJSON geometry (Polygon | MultiPolygon), WGS84. */
    geometry: jsonb("geometry").notNull(),
    /** Feature bbox, WGS84. */
    westLng: doublePrecision("west_lng").notNull(),
    southLat: doublePrecision("south_lat").notNull(),
    eastLng: doublePrecision("east_lng").notNull(),
    northLat: doublePrecision("north_lat").notNull(),
    /** Basename of the source zip/shapefile the row was parsed from. */
    sourceFile: text("source_file").notNull(),
    /** Program vintage label, e.g. `stratmap25-landparcels_48209_hays_202503`. */
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.tileKey, t.featureIndex] }),
    propIdx: index("txgio_parcel_prop_idx").on(t.countyFips, t.propId),
  }),
);

export type TxgioParcelRow = typeof txgioParcel.$inferSelect;
export type TxgioParcelInsert = typeof txgioParcel.$inferInsert;
