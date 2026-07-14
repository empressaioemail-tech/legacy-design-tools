-- Self-hosted parcel geometry store from the free TxGIO/StratMap
-- statewide Land Parcels program (feat/txgio-parcel-geometry).
--
-- Per-county public-domain parcel polygons (GeoJSON, WGS84) for
-- counties that have CAD roll data in cad_property but no live
-- queryable county GIS — v1: Hays (48209) and Comal (48091). Loaded
-- by the @workspace/cad-ingest txgio-ingest CLI; read by the parcels
-- map provider (bbox tile fetch) and the point->(county_fips, prop_id)
-- resolver behind the cad:* Property Brief adapters.
--
-- Keyed (county_fips, tile_key, feature_index): tile_key is a snapped
-- 0.02-degree grid CELL key (single-cell form of the #242 tileKey()
-- grid math); a feature is written once per cell its bbox intersects,
-- so bbox reads are pk-prefix equality scans and point reads are a
-- single-cell scan + ray-cast. feature_index (source shapefile
-- sequence) dedupes a feature across cells. The ingest replaces a
-- county wholesale (DELETE + batch insert), keeping re-runs and
-- vintage refreshes idempotent. Bbox columns let readers filter to
-- true intersection without decoding geometry. TxGIO parcels are
-- informational, not survey grade — consumers carry notSurveyGrade.

CREATE TABLE IF NOT EXISTS "txgio_parcel" (
  "county_fips" text NOT NULL,
  "tile_key" text NOT NULL,
  "feature_index" integer NOT NULL,
  "prop_id" text,
  "geo_id" text,
  "owner_name" text,
  "situs_address" text,
  "situs_city" text,
  "situs_state" text,
  "situs_zip" text,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "txgio_parcel_county_fips_tile_key_feature_index_pk"
    PRIMARY KEY ("county_fips", "tile_key", "feature_index")
);

CREATE INDEX IF NOT EXISTS "txgio_parcel_prop_idx"
  ON "txgio_parcel" ("county_fips", "prop_id");
