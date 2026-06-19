-- Cotality map-proxy cache (cc-agent-D) — persistent cache for the cortex-api
-- /gis-layer bbox map mesh so the same parcels and viewports are not re-fetched
-- from Cotality. The engine assemble (pin) path and the brief underwriting path
-- already cache through adapter_response_cache (keyed by adapter_key + lat/lng);
-- the in-process /gis-layer bbox mesh path in brokerageGisLayers.ts does NOT, and
-- is the Cotality quota burn (up to 4 Spatial Tile + 25 geocode + 25 site-location
-- calls per pan, uncached). These three tables back that path.
--
-- All three mirror adapter_response_cache: jsonb payload, expires_at TTL gate
-- (readers filter expires_at > now()), created_at bumped on upsert so the row age
-- tracks the most recent successful fetch, a unique index for the upsert/lookup,
-- and an expires_at index for the capacity sweep. None requires a sweep for
-- correctness (expired rows simply stop serving and are overwritten in place).

-- Spatial Tile parcel mesh, keyed by snapped grid tile. Parcel geometry is
-- near-static, so this carries the longest TTL. tile_key encodes the layer plus
-- the snapped grid cell (or, in the MVP, the snapped-bbox hash) so overlapping
-- pans share tiles.
CREATE TABLE IF NOT EXISTS "cotality_spatial_tile_cache" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "tile_key" text NOT NULL,
  "payload" jsonb NOT NULL,
  "feature_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "cotality_spatial_tile_cache_uniq"
  ON "cotality_spatial_tile_cache" ("tile_key");
CREATE INDEX IF NOT EXISTS "cotality_spatial_tile_cache_expires_idx"
  ON "cotality_spatial_tile_cache" ("expires_at");

-- Property attributes keyed by (clip, product). product is the attribute family:
-- site-location | rent-avm | propensity | hoa | ownership | comparables | ... .
-- This is the parcel-attribute cache shared (in a later phase) between the map and
-- the brief so a parcel underwritten in a brief seeds the map coloring for free.
CREATE TABLE IF NOT EXISTS "cotality_property_attr_cache" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "clip" text NOT NULL,
  "product" text NOT NULL,
  "payload" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "cotality_property_attr_cache_uniq"
  ON "cotality_property_attr_cache" ("clip", "product");
CREATE INDEX IF NOT EXISTS "cotality_property_attr_cache_expires_idx"
  ON "cotality_property_attr_cache" ("expires_at");

-- Address -> CLIP geocode resolutions, keyed by normalized street|city|state.
-- Address-to-CLIP is effectively permanent, so this carries a long TTL. resolved
-- distinguishes a real CLIP from a cached negative (an address that did not geocode)
-- so a parcel that has no CLIP is not re-geocoded on every pan.
CREATE TABLE IF NOT EXISTS "cotality_geocode_cache" (
  "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
  "addr_norm" text NOT NULL,
  "clip" text,
  "resolved" boolean DEFAULT true NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "cotality_geocode_cache_uniq"
  ON "cotality_geocode_cache" ("addr_norm");
CREATE INDEX IF NOT EXISTS "cotality_geocode_cache_expires_idx"
  ON "cotality_geocode_cache" ("expires_at");
