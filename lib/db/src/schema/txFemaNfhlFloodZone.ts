import {
  pgTable,
  text,
  bigint,
  jsonb,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Statewide FEMA NFHL flood-hazard polygon store — layer-first L4a
 * (feat/fema-nfhl-statewide-layer).
 *
 * Texas flood zones from the FEMA NFHL statewide bulk file
 * (`NFHL_48_<date>.zip`, `S_FLD_HAZ_AR` layer inside the FileGDB).
 * Loaded by `@workspace/cad-ingest` nfhl-ingest CLI in one statewide
 * pass. Serves in-state parcel flood-zone evaluation without per-parcel
 * ArcGIS point queries.
 *
 * Keyed `zone_row_id` = `${dfirm_id}:${fld_ar_id}` (FEMA panel-local
 * flood-area identifier). Parcels outside every stored polygon are the
 * honest `outside-mapped-zones` answer from the evaluation helper.
 *
 * Geometry is GeoJSON Polygon/MultiPolygon in WGS84 (EPSG:4326). Per-
 * feature bbox columns back viewport pre-filter without decoding jsonb.
 *
 * Idempotency: the ingest replaces the layer wholesale (DELETE all rows,
 * then batch-insert with ON CONFLICT DO UPDATE).
 */
export const txFemaNfhlFloodZone = pgTable(
  "tx_fema_nfhl_flood_zone",
  {
    /** Stable row key: `${dfirm_id}:${fld_ar_id}`. */
    zoneRowId: text("zone_row_id").notNull(),
    /** DFIRM community id, e.g. `48021C` (Bastrop). */
    dfirmId: text("dfirm_id").notNull(),
    /** FEMA flood-area id within the DFIRM, e.g. `48021C_2261`. */
    fldArId: text("fld_ar_id").notNull(),
    /** Effective zone code, e.g. `AE`, `X`, `VE`. */
    fldZone: text("fld_zone"),
    /** Zone subtype when present, e.g. `FLOODWAY`. */
    zoneSubty: text("zone_subty"),
    /** SFHA flag as shipped: literal `T` or `F`. */
    sfhaTf: text("sfha_tf"),
    /** Static BFE when meaningful; FEMA sentinel -9999 stored as NULL. */
    staticBfe: doublePrecision("static_bfe"),
    /** Source OBJECTID for traceability. */
    femaObjectId: bigint("fema_object_id", { mode: "number" }),
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
    pk: primaryKey({ columns: [t.zoneRowId] }),
    bboxIdx: index("tx_fema_nfhl_flood_zone_bbox_idx").on(
      t.westLng,
      t.southLat,
      t.eastLng,
      t.northLat,
    ),
    dfirmIdx: index("tx_fema_nfhl_flood_zone_dfirm_idx").on(t.dfirmId),
  }),
);

export type TxFemaNfhlFloodZoneRow = typeof txFemaNfhlFloodZone.$inferSelect;
export type TxFemaNfhlFloodZoneInsert =
  typeof txFemaNfhlFloodZone.$inferInsert;
