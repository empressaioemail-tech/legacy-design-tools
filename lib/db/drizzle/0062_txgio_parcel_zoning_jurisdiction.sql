-- Persist the city zoning layer that PIP-matched a parcel (multi-city fix).
--
-- `zoning_district` alone is not enough when a county has more than one
-- wired city layer (Travis: Austin + Pflugerville). The setback table and
-- jurisdiction key must come from the layer whose polygon contained the
-- parcel, not from a county-level "sole city" guess.
--
-- Written by the zoning-stamp CLI alongside `zoning_district` (cityKey from
-- ZONING_LAYERS, e.g. "austin-tx"). NULL means no polygon match —
-- unincorporated / outside every wired city layer — honest absence.
--
-- IF NOT EXISTS keeps the migration idempotent under the filename-tracked
-- runner (no drizzle meta journal — see drizzle/README.md).

ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "zoning_jurisdiction" text;
