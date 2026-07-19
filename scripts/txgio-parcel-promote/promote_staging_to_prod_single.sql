-- ============================================================================
-- OPERATOR-GATED (single-statement variant): promote ALL 8 staging counties
-- into prod txgio_parcel in ONE INSERT.
-- ============================================================================
-- Prefer promote_staging_to_prod.sql (per-county, restartable, per-county row
-- counts). Use THIS single-statement form only if you specifically want one
-- atomic INSERT. Downside: no per-county progress, and an interrupt mid-run
-- rolls back the entire ~2.5M-row insert (nothing lands until it commits) —
-- but it is still safe to simply re-run from scratch (ON CONFLICT DO NOTHING).
--
-- Same guarantees as the per-county file: explicit column list, idempotent,
-- schema verified byte-identical, PK = (county_fips, tile_key, feature_index).
-- ============================================================================

\set ON_ERROR_STOP on
\timing on
\pset pager off

\echo '=== PRE: staging total + per-county ==='
SELECT county_fips, count(*) AS staging_rows
FROM txgio_parcel_staging GROUP BY county_fips ORDER BY county_fips;

\echo '=== PROMOTE all 8 counties (single INSERT) ==='
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
ON CONFLICT (county_fips, tile_key, feature_index) DO NOTHING;

\echo '=== POST: prod per-county (expect 10 counties) ==='
SELECT county_fips, count(*) AS prod_rows
FROM txgio_parcel GROUP BY county_fips ORDER BY county_fips;

\echo '=== POST: reconciliation (empty = clean) ==='
SELECT s.county_fips, s.staging_rows, coalesce(p.prod_rows,0) AS prod_rows,
       s.staging_rows - coalesce(p.prod_rows,0) AS missing_in_prod
FROM (SELECT county_fips, count(*) AS staging_rows FROM txgio_parcel_staging GROUP BY county_fips) s
LEFT JOIN (SELECT county_fips, count(*) AS prod_rows FROM txgio_parcel GROUP BY county_fips) p
  ON p.county_fips = s.county_fips
WHERE s.staging_rows <> coalesce(p.prod_rows,0)
ORDER BY s.county_fips;
