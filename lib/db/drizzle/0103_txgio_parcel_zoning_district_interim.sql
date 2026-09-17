-- Record that a stamped zoning district is INTERIM (P-259b).
--
-- Austin publishes an interim family with a leading `I-` qualifier (14 live
-- values, 1,229 polygons: I-SF-2, I-RR, I-SF-4A, I-SF-3, I-LA, I-GR, I-MF-3,
-- I-AV, I-MF-2, I-PUD, I-RR-NP, I-SF-1, I-SF-2-NP, I-SF-6). An interim
-- designation is granted on annexation until permanent zoning is established,
-- and the city's ordinance reads it as its base district (C2O-2009-017 for
-- I-SF-2; the 2016 development-standards table 20160616-041 gives I-SF-2
-- front 25 / side 5 / rear 10, the shipped austin-tx.json SF-2 row exactly).
--
-- Since P-259b the parser resolves such a value to its BASE district, so
-- `zoning_district` holds "SF-2" for "I-SF-2-NP". That leaves the interim
-- designation itself unsaid, and "stably zoned SF-2" is a different fact from
-- "interim SF-2". This column carries the difference:
--
--   true  a district was stamped from a published value with a declared
--         interim qualifier
--   false a district was stamped from a value with no interim qualifier
--         (including every layer whose config declares none)
--   NULL  NOTHING was stamped -- `zoning_district` is NULL, or the feature was
--         skipped for carrying no CAD account. Never "stamped, interim
--         unknown", so a NULL can never be read as an understated disclosure.
--
-- NOTHING READS THIS COLUMN TODAY. No route, no MCP payload, no PDF and no
-- router consults it; it exists so the fact is recoverable from the store
-- instead of only from a run log. A serve change is out of this lane's scope.
--
-- The write is the stamp CLI's own batched UPDATE
-- (lib/cad-ingest/src/txgio/zoning-stamp-db.ts), which sets this column on
-- every stamped row and therefore FAILS CLOSED on a database that has not run
-- this migration: Postgres rejects the unknown column and the first batch
-- aborts with zero rows written, rather than silently stamping districts
-- without the disclosure. The integration seat MUST apply this before running
-- the stamp with --apply (same prerequisite shape as 0059 for
-- `zoning_district`).
--
-- IF NOT EXISTS keeps the migration idempotent under the filename-tracked
-- runner (no drizzle meta journal -- see drizzle/README.md).

ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "zoning_district_interim" boolean;

-- Backfill the rows stamped BEFORE this column existed. Without it, a row
-- carrying a district from an earlier run would sit at NULL, and NULL is
-- defined above as "nothing was stamped" -- a false statement that would
-- understate the disclosure on every pre-existing row. `false` is the correct
-- value for them: none of them came through an interim qualifier, because the
-- parser had no qualifier rule until this lane.
--
-- Idempotent (`IS NULL` is re-checked, so a re-run updates nothing) and
-- scoped to stamped rows only: an unstamped row is left NULL on purpose.
UPDATE "txgio_parcel"
  SET "zoning_district_interim" = false
  WHERE "zoning_district" IS NOT NULL
    AND "zoning_district_interim" IS NULL;
