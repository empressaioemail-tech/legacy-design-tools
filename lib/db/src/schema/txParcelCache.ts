import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Central Texas county-GIS parcel tile cache.
 *
 * The `parcels` gis-layer now has a county-GIS provider in front of the
 * dormant Cotality Spatial Tile branch (`brokerageTxParcels.ts`): bbox/pin
 * requests that fall inside a supported Central Texas county are served
 * from that county's public ArcGIS parcel service. This table is the
 * read-through cache for that provider — deliberately NEUTRAL of the
 * Cotality tables (`cotality_spatial_tile_cache` etc.) so the dormant
 * Cotality path and its cache stay untouched.
 *
 * Mirrors the shape of `cotality_spatial_tile_cache` (migration 0043) but
 * is keyed by `(tile_key, county_fips)` and carries `fetched_at` instead
 * of `created_at` (bumped on upsert so row age tracks the most recent
 * successful county fetch). Parcels change slowly; TTL defaults to 30
 * days. Readers filter `expires_at > now()`; expired rows stop serving
 * and are overwritten in place — no sweep required for correctness.
 */
export const txParcelTileCache = pgTable(
  "tx_parcel_tile_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `<layer>:<snapped grid cell or bbox hash>` — see `tileKey()`. */
    tileKey: text("tile_key").notNull(),
    /** County FIPS the tile was served from (e.g. `48453` Travis). */
    countyFips: text("county_fips").notNull(),
    /** Cached normalized GeoJSON envelope for the tile. */
    payload: jsonb("payload").notNull(),
    /** `geojson.features.length` at write time — a capacity / debug signal. */
    featureCount: integer("feature_count").default(0).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("tx_parcel_tile_cache_uniq").on(t.tileKey, t.countyFips),
    expiresIdx: index("tx_parcel_tile_cache_expires_idx").on(t.expiresAt),
  }),
);

export type TxParcelTileCacheRow = typeof txParcelTileCache.$inferSelect;
