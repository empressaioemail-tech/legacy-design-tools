-- Per-publisher extraterritorial-jurisdiction (ETJ) ring store and source register
-- (feat/p241-etj-acquisition, P-241 acquisition half).
--
-- ETJ has no statewide layer. TxGIO City_Boundaries publishes incorporated places
-- only, and every ETJ site in the product returns the literal string "unresolved"
-- because no ETJ geometry was ever acquired. Each municipality publishes its own ETJ
-- layer on its own ArcGIS host, so rings arrive one publisher at a time through
-- @workspace/cad-ingest's etj-ingest CLI.
--
-- tx_etj_boundary mirrors tx_city_boundary's shape (geo-key + name + GeoJSON WGS84 +
-- per-feature bbox + source bookkeeping). Two deliberate differences:
--   * key is `etj_id` = '<city_key>:<publisher object id>' — rings are identified by
--     their publisher, never by a statewide place code;
--   * `ring_label` is the publisher's own label, verbatim. Nothing is derived from
--     Texas Government Code §42.021: Austin's real ETJ is shaped by individual
--     development agreements and disannexation actions, and a statutory buffer
--     formula contradicts the published layer. Acquire the layer; never compute one.
--
-- tx_etj_source is one row per ENUMERATED city, including the cities whose publisher
-- exposes city limits and no ETJ layer (mode='city_limits_only'). It is what keeps
-- "checked, and the ETJ does not reach here" (absent) separate from "there is no
-- source to check" (unresolved). Extents are read from the publisher with
-- returnExtentOnly=true&outSR=4326, because the layer metadata extents come back in
-- each publisher's own projected SR (102739/102740/102100/102383/103160 all appear).
--
-- Replace semantics per run, matching boundary-ingest: the CLI deletes the rows it is
-- about to re-acquire, then batch-inserts with ON CONFLICT DO UPDATE. Idempotent.

CREATE TABLE IF NOT EXISTS "tx_etj_boundary" (
  "etj_id" text NOT NULL,
  "city_key" text NOT NULL,
  "city_name" text NOT NULL,
  "city_geo_id" text,
  "ring_label" text NOT NULL,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_etj_boundary_etj_id_pk" PRIMARY KEY ("etj_id")
);

CREATE INDEX IF NOT EXISTS "tx_etj_boundary_bbox_idx"
  ON "tx_etj_boundary" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_etj_boundary_city_idx"
  ON "tx_etj_boundary" ("city_key");

CREATE TABLE IF NOT EXISTS "tx_etj_source" (
  "city_key" text NOT NULL,
  "city_name" text NOT NULL,
  "city_geo_id" text,
  "mode" text NOT NULL,
  "layer_url" text,
  "layer_name" text,
  "has_etj_rings" boolean NOT NULL,
  "west_lng" double precision,
  "south_lat" double precision,
  "east_lng" double precision,
  "north_lat" double precision,
  "etj_ring_count" integer DEFAULT 0 NOT NULL,
  "layer_last_edit_at" timestamp with time zone,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_etj_source_city_key_pk" PRIMARY KEY ("city_key")
);

CREATE INDEX IF NOT EXISTS "tx_etj_source_extent_idx"
  ON "tx_etj_source" ("west_lng", "south_lat", "east_lng", "north_lat");
