-- ============================================================================
-- OPERATOR-GATED: promote txgio_parcel_staging -> txgio_parcel (PRODUCTION)
-- ============================================================================
-- Run MANUALLY against DEPLOYMENT_DATABASE_URL (Neon, project
-- legacy-design-tools-prod). This is NOT a drizzle migration and MUST NOT be
-- placed in lib/db/drizzle/ (deploy-time migrations must not carry a
-- ~2.5M-row data move). See RUNBOOK.md in this directory.
--
-- What it does: inserts all 8 staging counties into prod txgio_parcel.
--   Bastrop 48021, Bell 48027, Bexar 48029, Caldwell 48055, Guadalupe 48187,
--   McLennan 48309, Travis 48453, Williamson 48491.
-- Prod already holds Hays 48209 + Comal 48091 (untouched).
--
-- Idempotent + restartable: ON CONFLICT (PK) DO NOTHING. Safe to re-run and
-- safe to resume after an interrupt. Verified 2026-07-19 that staging and prod
-- schemas are byte-identical (18 cols, same types/nullability/defaults), PK on
-- both = (county_fips, tile_key, feature_index), zero staging rows NULL in any
-- prod NOT-NULL column, and zero PK overlap between staging and prod today.
--
-- Explicit column list (NOT SELECT *) so a future column-order drift cannot
-- silently misalign the copy.
--
-- Lock/traffic: INSERT takes only RowExclusiveLock on txgio_parcel; it does
-- NOT block concurrent SELECT reads (the live /resolve path). No index rebuild.
-- Prefer low-traffic window anyway (large functional situs index maintenance
-- per row makes this write-heavy). Run per-county (below) for observability
-- and restartability; each statement is independently restartable.
-- ============================================================================

\set ON_ERROR_STOP on
\timing on
\pset pager off

-- ----------------------------------------------------------------------------
-- PRE-CHECK: what we are about to promote (staging) and current prod state.
-- ----------------------------------------------------------------------------
\echo '=== PRE: staging per-county counts (source of truth for the promote) ==='
SELECT county_fips, count(*) AS staging_rows
FROM txgio_parcel_staging
GROUP BY county_fips ORDER BY county_fips;

\echo '=== PRE: prod per-county counts (should be only 48091 + 48209 before) ==='
SELECT county_fips, count(*) AS prod_rows
FROM txgio_parcel
GROUP BY county_fips ORDER BY county_fips;

-- ----------------------------------------------------------------------------
-- PROMOTE: per-county, each statement independently restartable.
-- Run these one at a time; check the reported INSERT row count against the
-- PRE staging count for that county (they should match on a first clean run;
-- a resumed run inserts only the remainder, the rest are ON CONFLICT skips).
-- ----------------------------------------------------------------------------

\echo '=== PROMOTE 48021 Bastrop ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48021'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48027 Bell ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48027'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48029 Bexar ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48029'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48055 Caldwell ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48055'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48187 Guadalupe ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48187'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48309 McLennan ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48309'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48453 Travis ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48453'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== PROMOTE 48491 Williamson ==='
INSERT INTO txgio_parcel (
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
)
SELECT
  county_fips, tile_key, feature_index, prop_id, geo_id, owner_name,
  situs_address, situs_city, situs_state, situs_zip, geometry,
  west_lng, south_lat, east_lng, north_lat, source_file, source_vintage, ingested_at
FROM txgio_parcel_staging
WHERE county_fips = '48491'
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

-- ----------------------------------------------------------------------------
-- POST-CHECK: prod per-county counts should now match staging for the 8, and
-- still show the original Hays/Comal. Reconciliation query flags any county
-- whose prod count != staging count.
-- ----------------------------------------------------------------------------
\echo '=== POST: prod per-county counts (expect 10 counties) ==='
SELECT county_fips, count(*) AS prod_rows
FROM txgio_parcel
GROUP BY county_fips ORDER BY county_fips;

\echo '=== POST: reconciliation (any row here = MISMATCH, investigate) ==='
SELECT s.county_fips,
       s.staging_rows,
       coalesce(p.prod_rows, 0) AS prod_rows,
       s.staging_rows - coalesce(p.prod_rows, 0) AS missing_in_prod
FROM (SELECT county_fips, count(*) AS staging_rows
      FROM txgio_parcel_staging GROUP BY county_fips) s
LEFT JOIN (SELECT county_fips, count(*) AS prod_rows
           FROM txgio_parcel GROUP BY county_fips) p
  ON p.county_fips = s.county_fips
WHERE s.staging_rows <> coalesce(p.prod_rows, 0)
ORDER BY s.county_fips;

\echo '=== DONE. Empty reconciliation result above = clean promote. ==='
