-- PREPARED retirement of county_facet_coverage.facet = 'land-use'
-- ============================================================================
-- HARD STOP. This file is PREPARE only. Do not apply.
-- Production apply is OPERATOR-AUTHORISED. No UPDATE / INSERT / DELETE / DDL
-- in this file is live. The mutation statements are commented. A scorer or
-- agent that uncomments them without an operator go is violating the card.
--
-- Snapshot (READ, then VERIFIED by SELECT on 2026-08-20T19:45:34Z):
--   database: neondb   (NOT hauska_mcp)
--   project:  fancy-fire-06136146
--   host:     ep-lucky-truth-apodo8hr
--   user:     neondb_owner
--   commit:   1a55566b057f8db4b888d007009c7fcaf84031d7  (code; this SQL is unapplied)
--
-- Why this exists. countyCoverageScoreCli.ts used to upsert facet 'land-use'.
-- On this commit the upsert key is LANDUSE_JOIN_FACET_KEY = 'landuse-cad-join'
-- (READ of upsertLedger: INSERT ... VALUES (..., f.facet, ...) where scoreCounty
-- sets classifyFacet({ facet: LANDUSE_JOIN_FACET_KEY })). The 19 live
-- 'land-use' rows are therefore Y, the retired store. Doctrine: repoint
-- consumers first (loadLedgerBlockedFips now reads both keys), then retire Y.
--
-- Do NOT overlay these 19 onto rail 'landuse'. VERIFIED 2026-08-20T19:45Z:
-- 19/19 counties have a matching landuse row; 15/19 percentages disagree;
-- sources are cad-roll (or cad-roll-address-join) vs land-use-fact-atom-count;
-- the rail rows are newer (2026-08-12 vs 2026-07-21..2026-08-05). Overlay
-- would overwrite a complete 254-county atom-count rail with a different
-- quantity. Comal 48091 would drop from landuse 99.68 satisfied-present to
-- 0.00 true-source-gap.
--
-- The table CANNOT express retirement. county_facet_coverage has no retired
-- marker column. classification is a closed CHECK
-- (real-at-ceiling | needs-crosswalk | true-source-gap | fabricated-blocked).
-- rail_state is the acquisition axis for rails and is NULL on these 19.
-- Prefer re-key to the declared successor over silent DELETE. Re-key is an
-- explicit decline of the retired name, not a delete of the measurement.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Three counts. Run these. Do not skip to the mutation.
--    Recorded live 2026-08-20T19:45:34Z UTC, neondb / neondb_owner:
--      land-use           n = 19     (19 distinct counties)
--      landuse            n = 254    (254 distinct counties; complete TX)
--      landuse-cad-join   n = 0      (ZERO, measured, not unmeasured)
--    Successor occupancy of the 19: 0 counties already hold landuse-cad-join.
--    Rail occupancy of the 19: 19/19 already hold landuse. Overlay is PK
--    overwrite, not a merge.
-- ---------------------------------------------------------------------------

SELECT 'land-use' AS facet, count(*)::int AS n, count(DISTINCT county_fips)::int AS counties
  FROM county_facet_coverage WHERE facet = 'land-use'
UNION ALL
SELECT 'landuse', count(*)::int, count(DISTINCT county_fips)::int
  FROM county_facet_coverage WHERE facet = 'landuse'
UNION ALL
SELECT 'landuse-cad-join', count(*)::int, count(DISTINCT county_fips)::int
  FROM county_facet_coverage WHERE facet = 'landuse-cad-join';

-- ---------------------------------------------------------------------------
-- 2. NAME the 19 rows. A count is not a record.
--    FIPS (live 2026-08-20T19:45Z):
--    48021 48027 48029 48055 48085 48091 48113 48121 48139
--    48187 48209 48251 48257 48309 48367 48397 48439 48453 48491
--    Verdicts on these 19: pass/real-at-ceiling = 14,
--    insufficient-sample/true-source-gap = 5. integrity_verdict='block' = 0.
--    Retiring them does not currently change the bake's ledger-block set
--    from these rows. The reader was still repointed because a FUTURE
--    scorer write under landuse-cad-join with verdict block would have
--    been invisible to a land-use-only reader.
-- ---------------------------------------------------------------------------

SELECT
  county_fips,
  facet,
  honest_coverage_pct,
  integrity_verdict,
  classification,
  source,
  source_vintage,
  sampled,
  rail_state,
  checked_at,
  verified_by_instrument,
  artifact_path
FROM county_facet_coverage
WHERE facet = 'land-use'
ORDER BY county_fips;

-- ---------------------------------------------------------------------------
-- 3. Overlay-falsification join. If pct_equal is true for all 19 AND source
--    matches, the "different measurement" claim would be wrong and overlay
--    would need re-argument. Live: 15/19 pct_equal=false. Do not overlay.
-- ---------------------------------------------------------------------------

SELECT
  o.county_fips,
  o.honest_coverage_pct AS land_use_join_pct,
  o.source              AS land_use_source,
  o.classification      AS land_use_class,
  o.checked_at          AS land_use_checked,
  r.honest_coverage_pct AS landuse_rail_pct,
  r.source              AS landuse_source,
  r.classification      AS landuse_class,
  r.rail_state          AS landuse_rail_state,
  r.checked_at          AS landuse_checked,
  (o.honest_coverage_pct = r.honest_coverage_pct) AS pct_equal
FROM county_facet_coverage o
LEFT JOIN county_facet_coverage r
  ON r.county_fips = o.county_fips AND r.facet = 'landuse'
WHERE o.facet = 'land-use'
ORDER BY o.county_fips;

-- ---------------------------------------------------------------------------
-- 4. Successor occupancy. Re-key is refused if any of the 19 already hold
--    landuse-cad-join (PK county_fips, facet). Live: 0.
-- ---------------------------------------------------------------------------

SELECT o.county_fips
FROM county_facet_coverage o
WHERE o.facet = 'land-use'
  AND EXISTS (
    SELECT 1 FROM county_facet_coverage t
     WHERE t.county_fips = o.county_fips
       AND t.facet = 'landuse-cad-join'
  )
ORDER BY o.county_fips;

-- ============================================================================
-- MUTATIONS BELOW ARE COMMENTED. Operator go required to uncomment AND run.
-- Preferred: re-key to landuse-cad-join (preserves the join-quality number
-- under the declared diagnostic). Alternative: DELETE the 19 (drops the
-- measurement). Neither overlays landuse.
-- ============================================================================

-- BEGIN;
--
-- -- Refuse a partial re-key: occupancy must still be zero at apply time.
-- DO $$
-- BEGIN
--   IF EXISTS (
--     SELECT 1
--       FROM county_facet_coverage o
--       JOIN county_facet_coverage t
--         ON t.county_fips = o.county_fips AND t.facet = 'landuse-cad-join'
--      WHERE o.facet = 'land-use'
--   ) THEN
--     RAISE EXCEPTION 'landuse-cad-join already occupied for a land-use county; refusing re-key';
--   END IF;
-- END $$;
--
-- UPDATE county_facet_coverage
--    SET facet = 'landuse-cad-join'
--  WHERE facet = 'land-use';
--
-- -- Post-condition. Apply is not done until these three hold:
-- --   land-use         n = 0
-- --   landuse          n = 254
-- --   landuse-cad-join n = 19
-- -- and landuse n did not move.
--
-- COMMIT;

-- Alternative if the operator rules DROP rather than preserve the join-quality
-- measurement. Silent relative to the rail (the 254 landuse rows stay) but
-- destructive of the CAD-join history. Prefer the UPDATE above.
--
-- BEGIN;
-- DELETE FROM county_facet_coverage WHERE facet = 'land-use';
-- -- post-condition: land-use n = 0; landuse n = 254; landuse-cad-join n = 0
-- COMMIT;
