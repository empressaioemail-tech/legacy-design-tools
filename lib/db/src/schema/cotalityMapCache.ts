import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Cotality map-proxy cache (cc-agent-D).
 *
 * The cortex-api `/gis-layer` bbox map mesh (`brokerageGisLayers.ts`)
 * calls Cotality Spatial Tile + Property directly and is NOT cached —
 * unlike the engine assemble (pin) path and the brief underwriting path,
 * which both run through `adapter_response_cache` (keyed by
 * `adapter_key + lat/lng`). The map mesh re-fetches on every pan/zoom
 * (up to 4 Spatial Tile + 25 geocode + 25 site-location calls per bbox),
 * which is the Cotality quota burn. These three tables back that path so
 * the same parcels and viewports are served from cache and Cotality is
 * hit only on a miss.
 *
 * Each mirrors `adapter_response_cache`: jsonb payload, `expires_at` TTL
 * gate (readers filter `expires_at > now()`), `created_at` bumped on
 * upsert so the row age tracks the most recent successful fetch, a unique
 * index for the upsert/lookup, and an `expires_at` index for the capacity
 * sweep. None requires a sweep for correctness — expired rows stop serving
 * and are overwritten in place on the next fetch.
 */

/**
 * Spatial Tile parcel mesh, keyed by snapped grid tile. Parcel geometry
 * is near-static, so this carries the longest TTL. `tile_key` encodes the
 * layer plus the snapped grid cell (or, in the MVP, the snapped-bbox hash)
 * so overlapping pans share tiles.
 */
export const cotalitySpatialTileCache = pgTable(
  "cotality_spatial_tile_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `<layer>:<snapped grid cell or bbox hash>` — see `tileKey()`. */
    tileKey: text("tile_key").notNull(),
    /** Cached Spatial Tile parcel rows / feature collection for the tile. */
    payload: jsonb("payload").notNull(),
    /** `geojson.features.length` at write time — a capacity / debug signal. */
    featureCount: integer("feature_count").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("cotality_spatial_tile_cache_uniq").on(t.tileKey),
    expiresIdx: index("cotality_spatial_tile_cache_expires_idx").on(
      t.expiresAt,
    ),
  }),
);

/**
 * Property attributes keyed by `(clip, product)`. `product` is the
 * attribute family: `site-location` | `rent-avm` | `propensity` | `hoa` |
 * `ownership` | `comparables` | ... . Shared (in a later phase) between
 * the map and the brief so a parcel underwritten in a brief seeds the map
 * coloring for free.
 */
export const cotalityPropertyAttrCache = pgTable(
  "cotality_property_attr_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Cotality CLIP — the parcel's universal key. */
    clip: text("clip").notNull(),
    /** Attribute family: site-location | rent-avm | propensity | hoa | ... . */
    product: text("product").notNull(),
    /** Cached Property response for `(clip, product)`. */
    payload: jsonb("payload").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("cotality_property_attr_cache_uniq").on(
      t.clip,
      t.product,
    ),
    expiresIdx: index("cotality_property_attr_cache_expires_idx").on(
      t.expiresAt,
    ),
  }),
);

/**
 * Address -> CLIP geocode resolutions, keyed by normalized
 * `street|city|state`. Address-to-CLIP is effectively permanent, so this
 * carries a long TTL. `resolved` distinguishes a real CLIP from a cached
 * negative (an address that did not geocode) so a parcel with no CLIP is
 * not re-geocoded on every pan.
 */
export const cotalityGeocodeCache = pgTable(
  "cotality_geocode_cache",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** Normalized `street|city|state` — see `normalizeAddrKey()`. */
    addrNorm: text("addr_norm").notNull(),
    /** Resolved CLIP, or null when `resolved` is true and nothing matched. */
    clip: text("clip"),
    /** False is never written today; reserved so callers can read the row
     * shape uniformly. A row always represents a completed lookup — a real
     * CLIP (`clip` set) or a cached negative (`clip` null). */
    resolved: boolean("resolved").default(true).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => ({
    uniq: uniqueIndex("cotality_geocode_cache_uniq").on(t.addrNorm),
    expiresIdx: index("cotality_geocode_cache_expires_idx").on(t.expiresAt),
  }),
);

export type CotalitySpatialTileCacheRow =
  typeof cotalitySpatialTileCache.$inferSelect;
export type CotalityPropertyAttrCacheRow =
  typeof cotalityPropertyAttrCache.$inferSelect;
export type CotalityGeocodeCacheRow = typeof cotalityGeocodeCache.$inferSelect;
