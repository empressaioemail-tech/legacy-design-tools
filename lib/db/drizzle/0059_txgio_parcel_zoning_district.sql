-- Attach the real zoning district to self-hosted TxGIO parcels (F11).
--
-- The buildable-envelope route reads a parcel's zoning district off ONE
-- field, `feature.properties.zoningCode`, and maps it onto that
-- jurisdiction's setback-district row (districtMapping.ts). But the
-- TxGIO parcel store (txgioParcelStore.ts `toFeature()`) never populated
-- a zoning code — the StratMap land-parcel program ships geometry +
-- owner/situs + land-use only, no zoning — so every store-backed parcel
-- arrived `zoningCode: null` and mapDistrict() degraded to the
-- most-conservative district (Georgetown: MF-2 High Density Multifamily,
-- largest combined setback) on single-family lots. Correct-but-safe, but
-- wrong: 120 Nolan Dr (RS Residential Single-Family) drew MF-2 setbacks.
--
-- This column carries the real district code stamped at ingest by a
-- point-in-polygon of each parcel's centroid against the jurisdiction's
-- public zoning GIS layer (Georgetown: the ArcGIS `ZONE` field, e.g.
-- "RS"), so `toFeature()` can set `zoningCode` and mapDistrict() matches
-- the true setback row instead of the conservative fallback.
--
-- Additive + nullable: existing rows keep NULL (unchanged behavior — the
-- conservative fallback), and only the zoning-stamp CLI writes it. It is
-- NOT touched by the geometry ingest's per-county DELETE+INSERT replace
-- (that path does not set it, and a geometry re-run before a re-stamp
-- simply leaves it NULL again — honest, never a stale wrong district).
--
-- IF NOT EXISTS keeps the migration idempotent under the filename-tracked
-- runner (no drizzle meta journal — see drizzle/README.md).

ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "zoning_district" text;
