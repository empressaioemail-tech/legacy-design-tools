-- cad_property.legal_acres (OPS-24 Burnet acreage, 2026-10-14).
--
-- WHY. Burnet (48053) cad_property is entirely the TxGIO StratMap land-parcels load
-- (tier:stratmap-roll). On that tier land_acres is StratMap's GIS polygon area (GIS_AREA),
-- not the appraisal district's stated figure: 48053:29742 serves 0.90 ac where the CAD states
-- 0.57 (hauska-factory #295). The same StratMap file publishes the CAD's own legal acreage as
-- LEGAL_AREA in the unit LGL_AREA_U, which the StratMap adapter (lib/cad-ingest
-- txgio/landuse.ts) dropped and this table had no column for. The adapter now writes it here,
-- converted to acres only from a stated unit (acres / sq ft / hectares); a blank, zero,
-- non-numeric or unit-less value stays NULL. Never a guessed unit.
--
-- Purely additive, nullable, no default: every existing row stays NULL ("not loaded") until
-- its county's StratMap roll is re-run with a commit carrying this change. Adding a nullable
-- column with no default is a catalog-only change in Postgres (no table rewrite). IF NOT EXISTS
-- keeps it idempotent under the filename-tracked runner (no drizzle meta journal -- see
-- drizzle/README.md).
--
-- ORDER. Apply BEFORE running cad-ingest (any adapter) from a commit that carries this
-- migration: upsertCadProperties names the column in every INSERT and fails without it.
SET LOCAL statement_timeout = '60s';
ALTER TABLE "cad_property"
  ADD COLUMN IF NOT EXISTS "legal_acres" numeric(14, 4);
