-- Municipal issued-permit records store (feat/permits-brief-slot).
--
-- OWNED public-record corpus (calibrated-spine Wave 3, acquired
-- 2026-06-21 via the uniform public-record process, raw CSVs in
-- gs://hauska-calibration-raw/backtest/{metro}/permit/open_data/):
-- Austin ~2.36M issued-construction-permit rows (1921-present,
-- data.austintexas.gov 3syk-w9eu) + San Antonio ~487K building-permit
-- rows (2020-07-present, data.sanantonio.gov; the pre-2020 Hansen
-- legacy era was not bulk-acquirable and that gap is disclosed).
--
-- Loaded by the @workspace/cad-ingest permits-ingest batch CLI from
-- local copies of the acquired CSVs; consumed by the permits:record
-- Property Brief adapter (rehab-reality slot) through an injected
-- accessor, same pattern as cad_property (#245/#246).
--
-- Keyed (metro, record_hash) — record_hash is the SHA-256 of the raw
-- CSV row (metro-prefixed): rows are immutable raw public records, so
-- re-ingest is idempotent (ON CONFLICT DO NOTHING) and exact source
-- duplicates collapse. No natural key exists: SA repeats PERMIT #
-- across trade sub-permits; Austin numbers recycle across vintages.
-- address_normalized is the adapter's fuzzy street-line match key;
-- tcad_id (Austin geo-format) is stored for a future verified id-join,
-- not matched on in v1. valuation is the applicant-declared figure,
-- not an appraisal.

CREATE TABLE IF NOT EXISTS "permit_record" (
  "metro" text NOT NULL,
  "record_hash" text NOT NULL,
  "permit_number" text NOT NULL,
  "permit_type" text,
  "work_class" text,
  "permit_class" text,
  "description" text,
  "status" text,
  "applied_date" date,
  "issued_date" date,
  "valuation" numeric(14, 2),
  "address_raw" text,
  "address_normalized" text,
  "tcad_id" text,
  "source_file" text NOT NULL,
  "acquired_date" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "permit_record_metro_record_hash_pk"
    PRIMARY KEY ("metro", "record_hash")
);

CREATE INDEX IF NOT EXISTS "permit_record_metro_address_issued_idx"
  ON "permit_record" ("metro", "address_normalized", "issued_date");
