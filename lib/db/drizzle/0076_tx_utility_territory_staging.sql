-- Factory 1.5 staging seam for utility who-serves territories.
-- Acquisition only: this table is not a rail, cell declaration, or atom source.

CREATE TABLE IF NOT EXISTS "tx_utility_territory_staging" (
  "staging_row_id" text NOT NULL,
  "source_key" text NOT NULL,
  "service_kind" text NOT NULL,
  "territory_id" text NOT NULL,
  "territory_name" text,
  "county_name" text,
  "county_fips" text,
  "geometry" jsonb NOT NULL,
  "geometry_crs" text NOT NULL,
  "source_url" text NOT NULL,
  "source_layer_id" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "source_tiers" jsonb NOT NULL,
  "source_tier_satisfied" jsonb NOT NULL,
  "source_vintage" text NOT NULL,
  "source_citation" text NOT NULL,
  "passthrough_attributes" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "object_id" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tx_utility_territory_staging_pk" PRIMARY KEY ("staging_row_id"),
  CONSTRAINT "tx_utility_territory_staging_service_kind_chk"
    CHECK ("service_kind" IN ('water', 'sewer', 'electric', 'water-district')),
  CONSTRAINT "tx_utility_territory_staging_geometry_crs_chk"
    CHECK ("geometry_crs" = 'EPSG:4326'),
  CONSTRAINT "tx_utility_territory_staging_tier_satisfied_chk"
    CHECK (
      jsonb_typeof("source_tier_satisfied") = 'array'
      AND jsonb_array_length("source_tier_satisfied") > 0
    ),
  CONSTRAINT "tx_utility_territory_staging_texas_bbox_chk"
    CHECK (
      "west_lng" >= -107 AND "east_lng" <= -92
      AND "south_lat" >= 25 AND "north_lat" <= 37
      AND "west_lng" <= "east_lng"
      AND "south_lat" <= "north_lat"
    )
);

CREATE INDEX IF NOT EXISTS "tx_utility_territory_staging_source_idx"
  ON "tx_utility_territory_staging" ("source_key");

CREATE INDEX IF NOT EXISTS "tx_utility_territory_staging_county_idx"
  ON "tx_utility_territory_staging" ("county_fips");

CREATE INDEX IF NOT EXISTS "tx_utility_territory_staging_bbox_idx"
  ON "tx_utility_territory_staging"
  ("west_lng", "south_lat", "east_lng", "north_lat");
