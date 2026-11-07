-- P-178 (Hays declared roll): the marker for an account present on a prior
-- drop of a tax_year and absent from the DECLARED drop.
--
-- WHY. upsertCadProperties (lib/cad-ingest/src/ingest.ts) writes a WHOLE row
-- and never deletes. Re-ingesting a fresher export for the same tax_year
-- therefore only ever touches rows the new export still names -- an account
-- present on the OLD drop but missing from the new one is left untouched, at
-- its stale notice values, indistinguishable from a currently-accurate row.
-- Measured against Hays' 2026-preliminary roll vs. the 2026-08-26 certified
-- export: 390 roll rows are not in the new export
-- (_inbox/2026-09-10_ctx-hays-rebind_addendum_source_reconciliation.json).
--
-- WHAT THIS COLUMN IS. A declared disposition, written by whatever load step
-- lands the declared drop (not by this migration, which adds no data) once it
-- has enumerated the new export's own prop_ids for a (county, tax_year) and
-- can name every row NOT among them. roll_membership stays NULL for every
-- row that IS present on its own declared drop -- NULL is "no disposition
-- needed", never a default absence. declared_source_file names the export
-- that was declared current when the row was marked, for provenance.
--
-- HONEST SERVING, NOT A DELETE. A marked row's cad_property columns are left
-- untouched (the old dollar/situs values stay queryable for audit), but
-- cadRollValue.ts's cadPropertyFactsFromRow refuses to serve a marked row's
-- cadRoll/yearBuilt/legalDescription/exemptionCodes as present -- see that
-- file's ROLL_MEMBERSHIP_ABSENT_FROM_DECLARED_DROP handling and its own
-- violation test.
--
-- Column absence confirmed live against information_schema.columns on both
-- staging (f06-staging-neondb) and production Neon, read-only, 2026-09-13,
-- before writing this migration.

ALTER TABLE "cad_property"
  ADD COLUMN IF NOT EXISTS "roll_membership" text;

ALTER TABLE "cad_property"
  ADD COLUMN IF NOT EXISTS "declared_source_file" text;
