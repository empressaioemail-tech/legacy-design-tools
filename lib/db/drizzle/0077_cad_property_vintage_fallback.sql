-- L21 follow-up 3 / P-25: named, county-scoped prior-vintage fallback.
-- This is not a second resolver. The blessed vintage seam consults this
-- table only after exact declared-year and deterministic crosswalk reads miss.

CREATE TABLE IF NOT EXISTS "cad_property_vintage_fallback" (
  "county_fips" text NOT NULL,
  "requested_prop_id" text NOT NULL,
  "declared_tax_year" integer NOT NULL,
  "fallback_prop_id" text NOT NULL,
  "fallback_tax_year" integer NOT NULL,
  "method" text NOT NULL,
  "evidence_class" text NOT NULL,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cad_property_vintage_fallback_pk"
    PRIMARY KEY ("county_fips", "requested_prop_id", "declared_tax_year"),
  CONSTRAINT "cad_property_vintage_fallback_distinct_years"
    CHECK ("declared_tax_year" <> "fallback_tax_year")
);

CREATE INDEX IF NOT EXISTS "cad_property_vintage_fallback_lookup_idx"
  ON "cad_property_vintage_fallback"
  ("county_fips", "fallback_tax_year", "fallback_prop_id");
