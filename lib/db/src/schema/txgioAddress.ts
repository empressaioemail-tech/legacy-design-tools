import {
  pgTable,
  text,
  integer,
  doublePrecision,
  timestamp,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

/**
 * Self-hosted address-POINT store — TxGIO/StratMap statewide Address
 * Points program (feat/txgio-address-points).
 *
 * Free public-domain address points from the Texas Geographic
 * Information Office StratMap Address Points collection, served as open
 * paginated ArcGIS REST at
 * `feature.geographic.texas.gov/.../Address_Points/stratmap_address_points_48_most_recent/MapServer/0`
 * (no auth; `f=geojson`, `resultOffset` pagination, `maxRecordCount`
 * 2000, statewide ~11.7M points). Loaded by the `@workspace/cad-ingest`
 * address-ingest CLI, county-partitioned so a statewide crawl is
 * resumable at county boundaries.
 *
 * This is the point sibling of the `txgio_parcel` polygon store: where
 * `txgio_parcel` colors the map and answers point->parcel, this store
 * carries geocoded delivery points that join to a parcel by situs
 * (`full_addr` <-> `situs_address`) or by falling within a parcel
 * polygon (the point lng/lat run through `pointInGeometry`). It backs
 * address autocomplete/geocode and the situs->parcel resolver for
 * counties without a live county geocoder.
 *
 * Keyed (county_fips, full_addr, unit):
 *  - `full_addr` is the program's assembled address label (e.g.
 *    `3075 HILL ST`). It is not unique on its own — a multi-unit
 *    building repeats the label per `unit` — so `unit` (empty string
 *    when the point carries none) is the tiebreaker in the key. This
 *    keeps the key on fips + full_addr while never silently collapsing
 *    two distinct delivery points into one row.
 *  - `object_id` is the source service's statewide-unique OBJECTID,
 *    kept for provenance and re-fetch, not as the key (it churns across
 *    program vintages; the address label is the stable join surface).
 *
 * `tile_key` is the same snapped 0.02-degree grid CELL key as
 * `txgio_parcel`/#242 (single-cell `g0.02:<w>,<s>` from
 * `cellKeyForPoint`), indexed so a viewport bbox read is a
 * `tile_key IN (covering cells)` scan instead of a lat/lng range scan.
 *
 * Idempotency: the ingest replaces a county wholesale (DELETE county
 * rows, then batch-insert with ON CONFLICT DO UPDATE), so re-running an
 * ingest or loading a fresher vintage never strands stale rows.
 *
 * Coordinates are WGS84 (the service publishes geographic lon/lat in
 * `f=geojson`); no reprojection.
 */
export const txgioAddress = pgTable(
  "txgio_address",
  {
    /** 5-digit county FIPS, e.g. `48453` (Travis). */
    countyFips: text("county_fips").notNull(),
    /** Assembled address label as shipped, e.g. `3075 HILL ST`. */
    fullAddr: text("full_addr").notNull(),
    /** Unit/suite as shipped; empty string (not null) when absent, so it
     *  can sit in the primary key. */
    unit: text("unit").notNull().default(""),
    /** Source service OBJECTID (statewide-unique within a vintage). */
    objectId: integer("object_id"),
    /** Parsed house number, e.g. `3075`. */
    addNumber: text("add_number"),
    /** Base street name, e.g. `Hill`. */
    stName: text("st_name"),
    /** Postal community, e.g. `Round Rock`. */
    postComm: text("post_comm"),
    /** ZIP, e.g. `78664`. */
    postCode: text("post_code"),
    /** State abbreviation as shipped, e.g. `TX`. */
    state: text("state"),
    /** County display name as shipped, e.g. `Travis`. */
    countyName: text("county_name"),
    /** Contributing authority, e.g. `CAPCOG`. */
    source: text("source"),
    /** Program acquisition date as shipped (ISO string). */
    dateAcq: text("date_acq"),
    /** WGS84 point longitude. */
    longitude: doublePrecision("longitude").notNull(),
    /** WGS84 point latitude. */
    latitude: doublePrecision("latitude").notNull(),
    /** Snapped grid cell key, e.g. `g0.02:-97.62000,30.48000`. */
    tileKey: text("tile_key").notNull(),
    /** Basename of the source (service label) the row was parsed from. */
    sourceFile: text("source_file").notNull(),
    /** Program vintage label, e.g. `stratmap_address_points_48_most_recent`. */
    sourceVintage: text("source_vintage").notNull(),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.countyFips, t.fullAddr, t.unit] }),
    tileIdx: index("txgio_address_tile_idx").on(t.countyFips, t.tileKey),
  }),
);

export type TxgioAddressRow = typeof txgioAddress.$inferSelect;
export type TxgioAddressInsert = typeof txgioAddress.$inferInsert;
