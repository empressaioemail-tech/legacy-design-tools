-- L21 / P-25: deterministic cross-vintage CAD prop_id crosswalk.
-- Used by the blessed resolveDeclaredCadVintage seam so a declared-year
-- miss can resolve ONE mapped key. Ambiguous mappings are refused at
-- write time (unique constraints). Not a second resolver.

CREATE TABLE IF NOT EXISTS "cad_property_vintage_crosswalk" (
  "county_fips" text NOT NULL,
  "from_tax_year" integer NOT NULL,
  "from_prop_id" text NOT NULL,
  "to_tax_year" integer NOT NULL,
  "to_prop_id" text NOT NULL,
  "method" text NOT NULL,
  "evidence_class" text NOT NULL,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cad_property_vintage_crosswalk_pk"
    PRIMARY KEY ("county_fips", "from_tax_year", "from_prop_id", "to_tax_year"),
  CONSTRAINT "cad_property_vintage_crosswalk_unique_target"
    UNIQUE ("county_fips", "to_tax_year", "to_prop_id", "from_tax_year")
);

CREATE INDEX IF NOT EXISTS "cad_property_vintage_crosswalk_to_idx"
  ON "cad_property_vintage_crosswalk" ("county_fips", "to_tax_year", "to_prop_id");
