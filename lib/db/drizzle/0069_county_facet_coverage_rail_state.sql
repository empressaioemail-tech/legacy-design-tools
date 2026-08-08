-- County Manifest Sprint 1 (feat/county-manifest-sprint1).
--
-- Additive extension of county_facet_coverage for the 13-rail three-state
-- manifest per the ruling at
-- doc_repo/_decisions/2026-08-08_county_shape_thirteen_rails_and_geometry_first.md
-- and the build spec at
-- doc_repo/_inbox/2026-08-08_SPRINT1_manifest_schema_spec.md section 4.
--
-- All columns nullable or defaulted; every existing row (19 counties x 3
-- facets, live 2026-08-08) stays valid with zero backfill, matching the
-- pattern 0064 used for the Phase A7 performance fields. Separate migration
-- file from 0068 (new pure-additive tables) because this one touches a
-- table with live rows and its own existing check-constraint set, matching
-- the repo's own precedent of 0060 (create) / 0064 (extend) as separate
-- files so either can be reverted independently.
--
-- rail_state             the three-state axis: satisfied-present |
--                        satisfied-absent | not-yet. `no-atom` / `no-writer`
--                        are NOT stored here — they are derived at query
--                        time from county_rail (see countyLedger.ts), so
--                        updating one county_rail row instantly and
--                        correctly reflects across all 254 counties with
--                        zero backfill, and no-atom can never be
--                        miscoded as not-yet by a stale write.
-- threshold_pct          ruling 3's declared per-rail threshold, SATISFIED
--                        vs PARTIAL comparison point. Copied from
--                        county_rail.threshold_pct at write time; exists
--                        independently so a future county-specific
--                        override does not require a schema change.
-- absence_basis          the public-record citation for satisfied-absent.
--                        REQUIRED (see CHECK below) whenever rail_state is
--                        satisfied-absent — ruling 2 makes absence a
--                        finding, and a finding needs its citation.
-- last_verified_at       per-cell trust: when was this specific cell last
--                        checked, distinct from checked_at (write time).
-- verified_by_instrument free-text identifier of what did the verifying
--                        (a CLI name, a sweep job id, 'roster-load' for
--                        cells seeded from the roster with no independent
--                        instrument run).
-- verification_method    sample | sweep | roster-load | unverified, per
--                        MEMORY.md area-sweep-not-parcel-sample.
-- artifact_path          evidence drill-through, pointer to the artifact
--                        backing the cell.
--
-- None of the three existing CHECK constraints (integrity_verdict,
-- classification, cert_state) are touched — they encode join integrity,
-- not acquisition; rail_state is a new, independent axis.

ALTER TABLE county_facet_coverage
  ADD COLUMN IF NOT EXISTS rail_state             text,
  ADD COLUMN IF NOT EXISTS threshold_pct           numeric(5, 2),
  ADD COLUMN IF NOT EXISTS absence_basis           text,
  ADD COLUMN IF NOT EXISTS last_verified_at         timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by_instrument    text,
  ADD COLUMN IF NOT EXISTS verification_method      text,
  ADD COLUMN IF NOT EXISTS artifact_path            text;

ALTER TABLE county_facet_coverage
  ADD CONSTRAINT county_facet_coverage_rail_state_check
    CHECK (rail_state IS NULL OR rail_state IN
      ('satisfied-present', 'satisfied-absent', 'not-yet'));

ALTER TABLE county_facet_coverage
  ADD CONSTRAINT county_facet_coverage_verification_method_check
    CHECK (verification_method IS NULL OR verification_method IN
      ('sweep', 'sample', 'roster-load', 'unverified'));

-- absence_basis is REQUIRED (not just present) whenever rail_state is
-- satisfied-absent -- ruling 2 makes absence a finding, and a finding
-- needs its citation or the state is unfalsifiable.
ALTER TABLE county_facet_coverage
  ADD CONSTRAINT county_facet_coverage_absence_basis_required_check
    CHECK (rail_state IS DISTINCT FROM 'satisfied-absent' OR absence_basis IS NOT NULL);

CREATE INDEX IF NOT EXISTS county_facet_coverage_rail_state_idx
  ON county_facet_coverage (rail_state);
