-- txgio_parcel.zoning_subarea (OPS-24 Burnet per-parcel setbacks, 2026-10-13).
--
-- WHY. Horseshoe Bay's zoning standards for one district code differ by the ordinance's
-- GEOGRAPHIC ZONE (Code of Ordinances Ch. 14 Art. 14.02: "Zones 3, 4A & 4B", "Zone 7
-- (Peninsula)", ...). The city's zoning layer (Public/Zoning/FeatureServer/2) carries that zone
-- as the coded-domain field SUBDIVISION on the SAME feature the zoning stamp already reads
-- ZONING from, but the stamp never persisted it, so no parcel's zone was resolvable and every
-- Horseshoe Bay district refused. The stamp (lib/cad-ingest zoning-stamp-db.ts) now writes the
-- matched feature's SUBDIVISION here for a layer whose ZONING_LAYERS entry sets `subareaField`
-- (Horseshoe Bay only), in the same batched UPDATE that writes zoning_district.
--
-- Purely additive, nullable, no default: every existing row stays NULL ("zone unknown"), which
-- the per-parcel resolver reads as SETBACK_ZONE_UNRESOLVED until the Horseshoe Bay stamp is
-- re-run after this migration. Adding a nullable column with no default is a catalog-only change
-- in Postgres (no table rewrite). IF NOT EXISTS keeps it idempotent under the filename-tracked
-- runner (no drizzle meta journal -- see drizzle/README.md).
--
-- ORDER. Apply BEFORE running a zoning stamp built from a commit that carries this migration: the
-- Horseshoe Bay stamp's UPDATE names the column and fails without it. Stamps for every other
-- city do not touch the column and are unaffected either way.
SET LOCAL statement_timeout = '60s';
ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "zoning_subarea" text;
