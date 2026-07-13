-- Central Texas county-GIS parcel tile cache (feat/tx-parcels-county-provider).
--
-- The `parcels` gis-layer gains a county-GIS provider in front of the dormant
-- Cotality Spatial Tile branch (brokerageTxParcels.ts): bbox/pin requests that
-- fall inside a supported Central Texas county (Travis, Williamson, Bexar,
-- Bastrop, Caldwell) are served from that county's public ArcGIS parcel
-- service. This table is the read-through cache for that provider — a NEW
-- neutral table so the dormant Cotality path and its cache stay untouched.
--
-- Mirrors cotality_spatial_tile_cache (migration 0043) but keyed by
-- (tile_key, county_fips), with fetched_at instead of created_at (bumped on
-- upsert so row age tracks the most recent successful county fetch). Parcels
-- change slowly; TTL defaults to 30 days. Readers filter expires_at > now();
-- expired rows stop serving and are overwritten in place — no sweep required.

CREATE TABLE IF NOT EXISTS "tx_parcel_tile_cache" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "tile_key" text NOT NULL,
  "county_fips" text NOT NULL,
  "payload" jsonb NOT NULL,
  "feature_count" integer DEFAULT 0 NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tx_parcel_tile_cache_uniq"
  ON "tx_parcel_tile_cache" ("tile_key", "county_fips");
CREATE INDEX IF NOT EXISTS "tx_parcel_tile_cache_expires_idx"
  ON "tx_parcel_tile_cache" ("expires_at");
