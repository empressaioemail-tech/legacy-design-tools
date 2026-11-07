-- TXGIO-GEOM-FIX: bring the already-live txgio_parcel.geom column under
-- tracked canon.
--
-- PARCEL-TXGIO-REACQ found this column live in production with zero tracked
-- migration and zero drizzle schema declaration -- a PostGIS geometry(Geometry,4326)
-- column, its own partial GiST index (txgio_parcel_geom_gist_idx), zero triggers,
-- no generated-column expression, populated entirely by an uncodified manual
-- backfill. This migration does not create anything new against production
-- (both the column and the index already exist there); it makes the schema this
-- repo tracks match what has been true in the live database, and is written
-- idempotent (IF NOT EXISTS) so it is also safe to run against a fresh
-- environment (a test database, a future clone) where neither yet exists.
--
-- The write-side half of this fix (upsertTxgioParcels deriving geom from
-- geometry on every insert AND every ON CONFLICT update, so an apply can never
-- silently wipe it again) is a code change in
-- lib/cad-ingest/src/txgio/ingest.ts, not a migration.

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "geom" geometry(Geometry, 4326);

CREATE INDEX IF NOT EXISTS "txgio_parcel_geom_gist_idx"
  ON "txgio_parcel" USING gist ("geom")
  WHERE "geom" IS NOT NULL;
