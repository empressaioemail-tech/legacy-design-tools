-- Statewide city and county boundary polygon stores (feat/city-county-boundary-layer).
--
-- Layer-first L1: incorporated-place and county boundaries acquired once and
-- blanket Texas. City polygons from the free TxGIO City_Boundaries ArcGIS REST
-- service (City_Boundaries/Texas_City_Boundaries/MapServer/0, ~1,225 CPA
-- polygons, queryable REST, $0). County polygons from Census TIGERweb
-- State_County/MapServer/1 (254 Texas counties; TxGIO publishes no dedicated
-- county-boundary layer — verified 2026-08-08 by probing every TxGIO folder).
--
-- Loaded by the @workspace/cad-ingest boundary-ingest CLI in one statewide pass
-- per layer. Replace semantics: DELETE all rows for the layer, then batch
-- insert with ON CONFLICT DO UPDATE, so re-runs and vintage refreshes are
-- idempotent. Geometry is GeoJSON in WGS84 (outSR=4326 at fetch time).
--
-- Enables real point-in-polygon in-city determination instead of address-string
-- inference. Unincorporated territory is the honest absence answer (most of
-- Texas by area), not a blank or a failure.

CREATE TABLE IF NOT EXISTS "tx_city_boundary" (
  "geo_id" text NOT NULL,
  "city_name" text NOT NULL,
  "gnis" text,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_city_boundary_geo_id_pk" PRIMARY KEY ("geo_id")
);

CREATE INDEX IF NOT EXISTS "tx_city_boundary_bbox_idx"
  ON "tx_city_boundary" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE TABLE IF NOT EXISTS "tx_county_boundary" (
  "county_fips" text NOT NULL,
  "county_name" text NOT NULL,
  "state_fips" text NOT NULL DEFAULT '48',
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_county_boundary_county_fips_pk" PRIMARY KEY ("county_fips")
);

CREATE INDEX IF NOT EXISTS "tx_county_boundary_bbox_idx"
  ON "tx_county_boundary" ("west_lng", "south_lat", "east_lng", "north_lat");
