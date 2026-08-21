-- SS-W7 / P-44: ingested per-county serving sweeps.
-- GET /api/serving-sweep ASSEMBLES the StatewideServingSweep from these rows
-- (countiesSwept is measured from the array served, never stored); GET
-- /api/serving-sweep/:countyFips serves one row's payload. Producers write
-- via POST /api/serving-sweep/ingest, which validates each county against the
-- frozen record before it lands. The four scalar columns are derived from the
-- payload at ingest, never supplied separately.

CREATE TABLE IF NOT EXISTS serving_sweep_county (
  county_fips       text PRIMARY KEY,
  county_name       text NOT NULL,
  swept_at          timestamptz NOT NULL,
  resolver_version  text NOT NULL,
  parcels_total     integer NOT NULL,
  payload           jsonb NOT NULL,
  ingested_at       timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT serving_sweep_county_fips_check CHECK (county_fips ~ '^[0-9]{5}$'),
  CONSTRAINT serving_sweep_county_parcels_total_check CHECK (parcels_total >= 0)
);
