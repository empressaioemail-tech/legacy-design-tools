-- Statewide FEMA NFHL flood-hazard polygon store (feat/fema-nfhl-statewide-layer).
--
-- Layer-first L4a: Texas flood zones acquired once from the FEMA NFHL
-- statewide bulk file (`NFHL_48_20260101.zip`, ~1.81 GB, probed live
-- 2026-08-08) — the `S_FLD_HAZ_AR` polygon layer inside
-- `NFHL_48_20260101.gdb`. Replaces per-parcel ArcGIS point queries for
-- in-state reads; the existing `fema:nfhl-flood-zone` adapter remains for
-- out-of-state and freshness fallback.
--
-- Loaded by the @workspace/cad-ingest nfhl-ingest CLI in one statewide
-- pass. Replace semantics: DELETE all rows, then batch insert with ON
-- CONFLICT DO UPDATE, so re-runs and vintage refreshes are idempotent.
-- Geometry is GeoJSON in WGS84 (EPSG:4326) after explicit reprojection
-- from the source NAD83 geographic CRS (EPSG:4269) at extract time.
--
-- Parcels outside every mapped zone polygon receive an explicit honest
-- absence (`outside-mapped-zones`), not a blank or a failure.

CREATE TABLE IF NOT EXISTS "tx_fema_nfhl_flood_zone" (
  "zone_row_id" text NOT NULL,
  "dfirm_id" text NOT NULL,
  "fld_ar_id" text NOT NULL,
  "fld_zone" text,
  "zone_subty" text,
  "sfha_tf" text,
  "static_bfe" double precision,
  "fema_object_id" bigint,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_fema_nfhl_flood_zone_zone_row_id_pk" PRIMARY KEY ("zone_row_id")
);

CREATE INDEX IF NOT EXISTS "tx_fema_nfhl_flood_zone_bbox_idx"
  ON "tx_fema_nfhl_flood_zone" ("west_lng", "south_lat", "east_lng", "north_lat");

CREATE INDEX IF NOT EXISTS "tx_fema_nfhl_flood_zone_dfirm_idx"
  ON "tx_fema_nfhl_flood_zone" ("dfirm_id");
