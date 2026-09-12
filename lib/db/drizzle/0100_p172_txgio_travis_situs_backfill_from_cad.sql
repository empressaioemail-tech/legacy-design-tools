-- P-172 (OPS-23 FIND BOX): backfill blank Travis `txgio_parcel` street lines
-- from `cad_property`, the same CAD-roll source the Property Explorer card's
-- own header already composes `baseFacts.situsAddress` from for Travis
-- (F16 / _decisions/2026-09-12_find_box_reads_the_situs_index.md).
--
-- WHY. `txgio_parcel.situs_address` for a real, measured share of Travis
-- (48453) rows is entirely blank (stored as ", TX" or ", TX <zip>" -- the
-- comma-and-state sentinel a blank CAD situs export leaves behind), which is
-- why the Find box's situs-index search can never resolve those addresses no
-- matter how the search route is fixed: there is nothing in the index to
-- match against. Verified live 2026-09-12 for the P-172 probe set:
-- `48453:113408` (414 Spiller Ln) and `48453:474034` (2601 Sterling Panorama
-- Ct) both carry a blank txgio_parcel street line while `cad_property`'s
-- 2026 tax-year row for the SAME prop_id carries the full street (and, for
-- 113408, the city too).
--
-- WHAT THIS DOES. For Travis only (county_fips = '48453'), for every
-- txgio_parcel row whose normalized street expression is blank (the same
-- expression migration 0058's functional index is built on, so "blank" here
-- means precisely what the search's index already treats as blank), pull the
-- MOST RECENT tax_year cad_property row for the same prop_id and copy its
-- situs_address / situs_city across -- but ONLY when the CAD row's OWN
-- street line is non-blank. A CAD row that is itself blank contributes
-- nothing (this is an honest backfill, not a fabrication).
--
-- NEVER OVERWRITES a txgio_parcel row that already carries a non-blank
-- street (the mission's explicit guard) -- the WHERE clause on the UPDATE
-- re-tests blankness with the same expression, so this is safe to re-run
-- (idempotent): a second run touches zero rows beyond whatever went blank
-- again in between (it will not, since nothing else writes this column).
--
-- SCOPE. Travis (48453) only, per R-3 (the city/county is the unit) and the
-- mission's explicit scope. Other counties' txgio_parcel blank-street rows,
-- if any, are NOT covered by this migration -- left_behind in the P-172
-- close.
--
-- ONE-SHOT, RUNS THROUGH THE DEPLOY PATH ONLY. Never applied ad hoc from a
-- laptop against production -- staging first, then production, both via the
-- normal migration runner (per lib/db/drizzle/README.md: applied migrations
-- are tracked by filename in `_schema_migrations`). Dry-run tested against
-- the f06-staging-neondb branch 2026-09-12 before this file was committed.
--
-- PERFORMANCE NOTE (2026-09-12): the FIRST version of this migration
-- reused migration 0058's full normalized-street expression to test
-- `cad_property.situs_address` for blankness too. `cad_property` (7.6M
-- rows, 3.6 GB, 2026-09-12 catalog read) carries NO functional index
-- matching that expression -- only `txgio_parcel` / `txgio_address` do
-- (migration 0058) -- so that predicate forced a per-row evaluation of the
-- ~30-call regexp_replace chain across every Travis cad_property row
-- (measured: still running past 25 minutes on staging, aborted). The
-- SEMANTIC goal on the CAD side is only "does this row have ANY real
-- street text", which a plain blank/sentinel check answers just as
-- correctly without the regex chain -- rewritten below. The txgio_parcel
-- side keeps the full expression: THAT table has the matching index
-- (confirmed via EXPLAIN 2026-09-12: Index Scan on
-- txgio_parcel_situs_norm_idx, not Seq Scan) and correctness there must
-- stay byte-identical to what the search route treats as "blank".
SET statement_timeout = 0;

-- Most-recent-tax_year cad_property row per Travis prop_id, restricted to
-- rows whose OWN street line is non-blank. Cheap predicate on purpose (see
-- PERFORMANCE NOTE above) -- this only needs to answer "is there real
-- street text here", not produce the normalized comparison key.
WITH latest_cad AS (
  SELECT DISTINCT ON (prop_id)
    prop_id,
    situs_address,
    situs_city
  FROM cad_property
  WHERE county_fips = '48453'
    AND situs_address IS NOT NULL
    AND btrim(situs_address) <> ''
    AND btrim(situs_address) NOT LIKE ',%'
  ORDER BY prop_id, tax_year DESC
),
updated AS (
  UPDATE txgio_parcel t
  SET
    situs_address = latest_cad.situs_address,
    situs_city = COALESCE(NULLIF(btrim(latest_cad.situs_city), ''), t.situs_city)
  FROM latest_cad
  WHERE t.county_fips = '48453'
    AND t.prop_id = latest_cad.prop_id
    -- Qualified t.situs_address: this UPDATE...FROM scope also carries
    -- latest_cad.situs_address, so the unqualified column name from the
    -- shared expression would be ambiguous here. This side KEEPS the full
    -- normalized expression (matches the search index's own definition of
    -- "blank" exactly) because txgio_parcel has the supporting index.
    AND (trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(trim(regexp_replace(regexp_replace(upper(split_part(t.situs_address, ',', 1)), '[.]', '', 'g'), '\s+', ' ', 'g')), '\mNORTH\M', 'N', 'g'), '\mSOUTH\M', 'S', 'g'), '\mEAST\M', 'E', 'g'), '\mWEST\M', 'W', 'g'), '\mNORTHEAST\M', 'NE', 'g'), '\mNORTHWEST\M', 'NW', 'g'), '\mSOUTHEAST\M', 'SE', 'g'), '\mSOUTHWEST\M', 'SW', 'g'), '\mALLEY\M', 'ALY', 'g'), '\mAVENUE\M', 'AVE', 'g'), '\mAV\M', 'AVE', 'g'), '\mBOULEVARD\M', 'BLVD', 'g'), '\mBEND\M', 'BND', 'g'), '\mCIRCLE\M', 'CIR', 'g'), '\mCOURT\M', 'CT', 'g'), '\mCOVE\M', 'CV', 'g'), '\mCROSSING\M', 'XING', 'g'), '\mDRIVE\M', 'DR', 'g'), '\mEXPRESSWAY\M', 'EXPY', 'g'), '\mHIGHWAY\M', 'HWY', 'g'), '\mHOLLOW\M', 'HOLW', 'g'), '\mLANE\M', 'LN', 'g'), '\mPARKWAY\M', 'PKWY', 'g'), '\mPLACE\M', 'PL', 'g'), '\mPLAZA\M', 'PLZ', 'g'), '\mPOINT\M', 'PT', 'g'), '\mRIDGE\M', 'RDG', 'g'), '\mROAD\M', 'RD', 'g'), '\mSQUARE\M', 'SQ', 'g'), '\mSTREET\M', 'ST', 'g'), '\mTERRACE\M', 'TER', 'g'), '\mTRACE\M', 'TRCE', 'g'), '\mTRAIL\M', 'TRL', 'g'), '\mTURNPIKE\M', 'TPKE', 'g'))) = ''
  RETURNING t.county_fips, t.prop_id
)
SELECT count(*) AS rows_filled FROM updated;

-- Post-run denominators (same predicate, run once at deploy time -- not from
-- an interactive laptop session against the live table). These are the
-- "rows examined / rows still blank" the mission's job record requires.
SELECT count(*) AS travis_rows_total
FROM txgio_parcel
WHERE county_fips = '48453';

SELECT count(*) AS travis_rows_still_blank_after_backfill
FROM txgio_parcel
WHERE county_fips = '48453'
  AND (trim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(trim(regexp_replace(regexp_replace(upper(split_part(situs_address, ',', 1)), '[.]', '', 'g'), '\s+', ' ', 'g')), '\mNORTH\M', 'N', 'g'), '\mSOUTH\M', 'S', 'g'), '\mEAST\M', 'E', 'g'), '\mWEST\M', 'W', 'g'), '\mNORTHEAST\M', 'NE', 'g'), '\mNORTHWEST\M', 'NW', 'g'), '\mSOUTHEAST\M', 'SE', 'g'), '\mSOUTHWEST\M', 'SW', 'g'), '\mALLEY\M', 'ALY', 'g'), '\mAVENUE\M', 'AVE', 'g'), '\mAV\M', 'AVE', 'g'), '\mBOULEVARD\M', 'BLVD', 'g'), '\mBEND\M', 'BND', 'g'), '\mCIRCLE\M', 'CIR', 'g'), '\mCOURT\M', 'CT', 'g'), '\mCOVE\M', 'CV', 'g'), '\mCROSSING\M', 'XING', 'g'), '\mDRIVE\M', 'DR', 'g'), '\mEXPRESSWAY\M', 'EXPY', 'g'), '\mHIGHWAY\M', 'HWY', 'g'), '\mHOLLOW\M', 'HOLW', 'g'), '\mLANE\M', 'LN', 'g'), '\mPARKWAY\M', 'PKWY', 'g'), '\mPLACE\M', 'PL', 'g'), '\mPLAZA\M', 'PLZ', 'g'), '\mPOINT\M', 'PT', 'g'), '\mRIDGE\M', 'RDG', 'g'), '\mROAD\M', 'RD', 'g'), '\mSQUARE\M', 'SQ', 'g'), '\mSTREET\M', 'ST', 'g'), '\mTERRACE\M', 'TER', 'g'), '\mTRACE\M', 'TRCE', 'g'), '\mTRAIL\M', 'TRL', 'g'), '\mTURNPIKE\M', 'TPKE', 'g'))) = '';
