-- Municipal building-permit store (feat/building-permit-store).
--
-- Provider-neutral rows loaded from free open-data permit exports:
-- Austin's issued-construction-permits Socrata drop (Travis 48453,
-- keyed on parcel via `TCAD ID` — the same Travis CAD prop id
-- cad_property uses) and San Antonio's permits-issued open-data CSVs
-- (Bexar 48029, keyed on parcel via `PARCEL`). Loaded by the
-- @workspace/permit-ingest batch CLI; consumed by a follow-up Property
-- Brief permits:* slot adapter.
--
-- Keyed (county_fips, prop_id, permit_id) so permit ids never collide
-- across jurisdictions and re-ingesting the same corpus upserts in
-- place (idempotent). prop_id is the parcel key verbatim from source
-- (may be empty string when the source row carries no parcel — the
-- permit still lands). issued_date/applied_date are calendar dates.
-- Free-text columns are stored as the source presents them, whitespace
-- normalized. source_file/source_vintage identify the export drop;
-- ingested_at is bumped on every upsert.

CREATE TABLE IF NOT EXISTS "building_permits" (
  "county_fips" text NOT NULL,
  "prop_id" text NOT NULL,
  "permit_id" text NOT NULL,
  "issued_date" date,
  "applied_date" date,
  "work_class" text,
  "status" text,
  "description" text,
  "permit_type" text,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "building_permits_county_fips_prop_id_permit_id_pk"
    PRIMARY KEY ("county_fips", "prop_id", "permit_id")
);
