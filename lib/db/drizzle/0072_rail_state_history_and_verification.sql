-- County Manifest observability (feat/manifest-observability-tables).
--
-- Part 1 of 2: append-only rail cell history + verification audit trail.
-- Separated from 0073 (manifest_run / slot / cost) so history + verification
-- can ship and revert independently of run-state tables, matching the repo's
-- 0068/0069 split precedent.
--
-- rail_state_history
--   Append-only snapshots per (county_fips, rail_key). The ledger table
--   county_facet_coverage overwrites current state in place; this table is the
--   regression-detection substrate backing the mockup TRENDS sparklines and
--   "what changed since you last looked". Written on material cell change
--   (primary) and optionally by a nightly cadence that skips cells already
--   snapshotted that UTC day (see manifestObservability.ts).
--
-- rail_verification
--   Multiple verification records per cell over time. The seven verification
--   columns on county_facet_coverage (0069) remain untouched — they are a
--   denormalized "latest" cache writers MAY update, but the audit trail and
--   OPS-5 sample-vs-sweep distinction live here. No row = never verified
--   (honest absence), distinct from a row confirming absence.

CREATE TABLE IF NOT EXISTS rail_state_history (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_fips         text NOT NULL,
  rail_key            text NOT NULL,
  rail_state          text,
  honest_coverage_pct numeric(5, 2),
  threshold_pct       numeric(5, 2),
  verified_at         timestamptz,
  run_id              uuid,
  snapshot_reason     text NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rail_state_history_rail_state_check
    CHECK (rail_state IS NULL OR rail_state IN
      ('satisfied-present', 'satisfied-absent', 'not-yet')),
  CONSTRAINT rail_state_history_snapshot_reason_check
    CHECK (snapshot_reason IN ('cell-change', 'nightly', 'manual'))
);

CREATE INDEX IF NOT EXISTS rail_state_history_cell_recorded_idx
  ON rail_state_history (county_fips, rail_key, recorded_at DESC);

CREATE INDEX IF NOT EXISTS rail_state_history_recorded_at_idx
  ON rail_state_history (recorded_at);

CREATE TABLE IF NOT EXISTS rail_verification (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  county_fips             text NOT NULL,
  rail_key                text NOT NULL,
  verified_at             timestamptz NOT NULL,
  verified_by_instrument    text NOT NULL,
  verification_method     text NOT NULL,
  verification_outcome      text NOT NULL,
  artifact_path           text,
  run_id                  uuid,
  notes                   text,
  recorded_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rail_verification_method_check
    CHECK (verification_method IN
      ('sweep', 'sample', 'probe', 'derived', 'roster-load', 'unverified')),
  CONSTRAINT rail_verification_outcome_check
    CHECK (verification_outcome IN
      ('confirmed-present', 'confirmed-absent', 'inconclusive', 'method-only'))
);

CREATE INDEX IF NOT EXISTS rail_verification_cell_verified_idx
  ON rail_verification (county_fips, rail_key, verified_at DESC);

CREATE INDEX IF NOT EXISTS rail_verification_run_idx
  ON rail_verification (run_id)
  WHERE run_id IS NOT NULL;
