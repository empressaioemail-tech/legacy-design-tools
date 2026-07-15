-- Self-hosted address-POINT store from the free TxGIO/StratMap
-- statewide Address Points program (feat/txgio-address-points).
--
-- Public-domain geocoded delivery points (WGS84) served as open
-- paginated ArcGIS REST at
-- feature.geographic.texas.gov/.../Address_Points/stratmap_address_points_48_most_recent/MapServer/0
-- (f=geojson, resultOffset pagination, maxRecordCount 2000, statewide
-- ~11.7M points). Loaded by the @workspace/cad-ingest address-ingest
-- CLI, county-partitioned so a statewide crawl is resumable at county
-- boundaries. Point sibling of txgio_parcel (0053): joins to a parcel
-- by situs (full_addr <-> situs_address) or point-in-polygon, and backs
-- address autocomplete/geocode + the situs->parcel resolver.
--
-- Keyed (county_fips, full_addr, unit): full_addr is the program's
-- assembled label and is not unique on its own (a multi-unit building
-- repeats it per unit), so unit (empty string when absent) is the
-- tiebreaker in the key. object_id is the source OBJECTID, kept for
-- provenance/re-fetch but not the key (it churns across vintages). The
-- ingest replaces a county wholesale (DELETE + batch insert), keeping
-- re-runs and vintage refreshes idempotent. tile_key is the same
-- snapped 0.02-degree grid cell key as txgio_parcel/#242, indexed so a
-- viewport bbox read is a tile_key IN (covering cells) scan.

CREATE TABLE IF NOT EXISTS "txgio_address" (
  "county_fips" text NOT NULL,
  "full_addr" text NOT NULL,
  "unit" text DEFAULT '' NOT NULL,
  "object_id" integer,
  "add_number" text,
  "st_name" text,
  "post_comm" text,
  "post_code" text,
  "state" text,
  "county_name" text,
  "source" text,
  "date_acq" text,
  "longitude" double precision NOT NULL,
  "latitude" double precision NOT NULL,
  "tile_key" text NOT NULL,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "txgio_address_county_fips_full_addr_unit_pk"
    PRIMARY KEY ("county_fips", "full_addr", "unit")
);

CREATE INDEX IF NOT EXISTS "txgio_address_tile_idx"
  ON "txgio_address" ("county_fips", "tile_key");
