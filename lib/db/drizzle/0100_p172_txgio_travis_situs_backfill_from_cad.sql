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
-- means precisely what the search's index already treats as blank), pull
-- Travis's DECLARED CAD vintage row for the same prop_id and copy its
-- situs_address / situs_city across -- but ONLY when that row's OWN street
-- line is non-blank. A CAD row that is itself blank contributes nothing
-- (this is an honest backfill, not a fabrication).
--
-- DECLARED VINTAGE, NOT max(tax_year) (CI ci-vintage-predicate). Travis's
-- declared CAD vintage is tax_year 2026, tier "cad-export"
-- (DECLARED_CAD_VINTAGES["48453"], lib/cad-ingest/src/vintage.ts,
-- resolveDeclaredCadVintage / tryResolveDeclaredCadVintage). That file's own
-- doc comment: "Fail-closed: unknown FIPS or missing declaration throws --
-- never invent a year from max(tax_year)." An early draft of this migration
-- picked `ORDER BY tax_year DESC` per prop_id, which happens to agree with
-- the declared vintage for Travis today but is the wrong MECHANISM (a
-- county can carry a newer, not-yet-declared preliminary/supplemental year
-- that should not be trusted) -- this SQL migration cannot import the
-- resolver a TS caller would use, so the declared year is hardcoded here
-- with this comment as its citation, and pinned to `county_fips = '48453'`
-- so it can never silently apply the wrong year to another county.
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
-- laptop against production -- staging then production, both via the normal
-- migrate:prod deploy step (lib/db/drizzle/README.md: applied migrations
-- are tracked by filename in `_schema_migrations`).
--
-- PERFORMANCE NOTE (2026-09-12). The first cut of this migration reused
-- migration 0058's full ~30-call regexp_replace normalization expression to
-- test `cad_property.situs_address` for blankness too. `cad_property` (7.6M
-- rows / 3.6 GB, 2026-09-12 catalog read) carries NO functional index
-- matching that expression -- only `txgio_parcel` / `txgio_address` do
-- (migration 0058) -- so it forced a per-row regex evaluation across every
-- Travis cad_property row and ran roughly 25-40 minutes on staging (the
-- local client that launched it was killed at 25 minutes for looking stuck;
-- the query kept running SERVER-SIDE past that -- killing a local psql
-- client does not reliably cancel an in-flight remote query -- and had, in
-- fact, already committed correctly by the time this was investigated).
-- Rewritten below to a plain blank/sentinel check on the CAD side, which
-- answers the same question ("does this row have real street text")
-- without the regex chain. Validated equivalent to the full expression on
-- staging 2026-09-12: 0 disagreements across a 20,000-row sample, and 0
-- rows in a full Travis table scan for a non-comma-prefixed, all-
-- punctuation street value (the one shape the cheap check could have
-- missed). Full run after the rewrite: 6m1s wall clock, 0 rows filled
-- because the earlier (correct, slow) run had already applied them --
-- confirmed by direct row reads, not by this count alone. The txgio_parcel
-- side of the UPDATE keeps the full expression unchanged, since that table
-- has the supporting index and correctness there must stay byte-identical
-- to what the search route itself treats as blank.
SET statement_timeout = 0;

WITH latest_cad AS (
  SELECT
    prop_id,
    situs_address,
    situs_city
  FROM cad_property
  WHERE county_fips = '48453'
    AND tax_year = 2026 -- Travis's DECLARED vintage; see note above
    AND situs_address IS NOT NULL
    AND btrim(situs_address) <> ''
    AND btrim(situs_address) NOT LIKE ',%'
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
