-- Williamson CAD (WCAD) per-property land-segment detail table.
--
-- NOT owned by this repo's own ingest pipeline (acquired 2026-09-03 by a
-- separate pipeline, Socrata portal pull) — this repo only reads it, for
-- the Williamson land_value/land_acres reconciliation (F-01,
-- lib/cad-ingest/src/williamsonAgValuation.ts). CREATE TABLE IF NOT
-- EXISTS is a safe no-op against the real production table, which
-- already exists; this migration exists so a fresh schema build (CI, a
-- new dev DB, disaster recovery) has it too, matching the established
-- pattern for other externally-sourced tx_* tables (see
-- 0071_tx_fema_nfhl_flood_zone.sql).
--
-- Schema confirmed live against information_schema.columns before
-- writing this migration (see
-- _inbox/2026-09-05_ctx-wrapup-ldt_williamson-mclennan-cad_close.json).

CREATE TABLE IF NOT EXISTS "tx_wcad_ag_valuation" (
  "id" bigint PRIMARY KEY,
  "prop_id" text NOT NULL,
  "wcad_property_id" text,
  "property_number" text,
  "record_type" text,
  "sequence" integer,
  "land_type" text,
  "description" text,
  "state_code" text,
  "homesite_flag" boolean,
  "appr_method" text,
  "acres" numeric,
  "value" numeric,
  "curr_value" numeric,
  "ag_year" text,
  "raw_ag_flag" text,
  "ag_flag" boolean NOT NULL,
  "source" text NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "county_fips" text
);
