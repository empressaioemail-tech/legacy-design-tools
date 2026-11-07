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
 * Keyed (county_fips, object_id) — changed from (county_fips, full_addr,
 * unit) in migration 0110 (P-txgio-address-key, measured 2026-10-09).
 * `full_addr` is the program's assembled address label (e.g.
 * `3075 HILL ST`) and is NOT unique on its own: distinct delivery points
 * with no shared coordinates repeat the same label (e.g. a road number
 * that recurs 21 km apart, or several buildings on one rural route).
 * Keying on (full_addr, unit) silently collapsed those into one row —
 * measured on Burnet (48053): the service returned 35,857 points, only
 * 35,690 were stored, 167 lost across 86 colliding (full_addr, unit)
 * groups, none of them actually the same point.
 *
 * `object_id` is the source service's OBJECTID. It churns across
 * program vintages WHEN COMPARED BARE, STATEWIDE — the same OBJECTID
 * repeats across different counties loaded from different vintages of
 * the statewide layer — but scoped to (county_fips, object_id) it is
 * reliable: verified live 2026-10-09, object_id is never null and
 * (county_fips, object_id) has zero duplicate groups across all 7 loaded
 * counties. The vintage-churn risk does not reach this table either way,
 * because the ingest replaces a county wholesale (see below), so a
 * fresher vintage's OBJECTIDs never have to coexist with a stale
 * vintage's OBJECTIDs for the same county. `full_addr`/`unit` remain —
 * they are still the join surface to CAD situs, via the normalized
 * full_addr index from migration 0058, not this table's key.
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
    /**
     * Source service OBJECTID. Statewide-unique within a vintage, and
     * (county_fips, object_id) is unique across vintages too because the
     * ingest replaces a county wholesale (see module header). Half of
     * the primary key as of migration 0110; NOT NULL since the same
     * migration (a feature with no usable objectid is skipped at parse
     * time, never inserted — see address/parse.ts).
     */
    objectId: integer("object_id").notNull(),
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
    pk: primaryKey({ columns: [t.countyFips, t.objectId] }),
    tileIdx: index("txgio_address_tile_idx").on(t.countyFips, t.tileKey),
  }),
);

export type TxgioAddressRow = typeof txgioAddress.$inferSelect;
export type TxgioAddressInsert = typeof txgioAddress.$inferInsert;
