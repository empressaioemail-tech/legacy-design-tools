-- County appraisal-district (CAD) property-attribute store
-- (feat/cad-property-store).
--
-- Provider-neutral rows loaded from free CAD bulk exports: PACS 8.0.x
-- fixed-width appraisal exports (Travis 48453, Bastrop 48021, Caldwell
-- 48055), Tyler Orion PropertyDataExport CSVs (Hays 48209), and the WCAD
-- Socrata portal (Williamson 48491). Loaded by the @workspace/cad-ingest
-- batch CLI; consumed by follow-up Property Brief slot adapters.
--
-- Keyed (county_fips, prop_id, tax_year) so CAD-local prop_ids never
-- collide across counties and successive years accumulate side by side.
-- Re-ingesting the same (county, year) upserts in place (idempotent).
-- Values are whole dollars; land_acres keeps the CADs' 4 implied
-- decimals; exemption_codes carries normalized short codes (HS, OV65,
-- DV1, EX, ...). source_file/source_vintage identify the export drop;
-- ingested_at is bumped on every upsert.

CREATE TABLE IF NOT EXISTS "cad_property" (
  "county_fips" text NOT NULL,
  "prop_id" text NOT NULL,
  "tax_year" integer NOT NULL,
  "owner_name" text,
  "owner_mailing_address" text,
  "situs_address" text,
  "situs_city" text,
  "situs_zip" text,
  "legal_description" text,
  "exemption_codes" text[],
  "land_value" bigint,
  "improvement_value" bigint,
  "market_value" bigint,
  "assessed_value" bigint,
  "year_built" integer,
  "living_area_sqft" integer,
  "land_acres" numeric(14, 4),
  "property_use_code" text,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cad_property_county_fips_prop_id_tax_year_pk"
    PRIMARY KEY ("county_fips", "prop_id", "tax_year")
);
