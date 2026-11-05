-- Parcel history from the TxGIO Land Parcels annual releases (stratmap19, 21-26).
--
-- One row per (county, StratMap vintage, source feature). Append-only: the
-- loader (lib/cad-ingest txgio vintage-history CLI) inserts with
-- ON CONFLICT DO NOTHING and never updates or deletes, so a vintage, once
-- loaded, stays exactly what was published. txgio_parcel keeps the ONE
-- current vintage and is untouched by this table.
--
-- Additive: a new table and its index. No existing table or row changes.

CREATE TABLE IF NOT EXISTS "txgio_parcel_vintage" (
  "county_fips" text NOT NULL,
  "source_vintage" text NOT NULL,
  "vintage_year" integer NOT NULL,
  "feature_index" integer NOT NULL,
  "prop_id" text,
  "geo_id" text,
  "owner_name" text,
  "situs_address" text,
  "situs_city" text,
  "situs_state" text,
  "situs_zip" text,
  "legal_desc" text,
  "land_value" numeric,
  "imp_value" numeric,
  "mkt_value" numeric,
  "tax_year" integer,
  "year_built" integer,
  "geometry" jsonb NOT NULL,
  "geom" geometry(Geometry,4326),
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source_file" text NOT NULL,
  "ingested_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "txgio_parcel_vintage_pk" PRIMARY KEY ("county_fips", "source_vintage", "feature_index"),
  CONSTRAINT "txgio_parcel_vintage_county_fips_chk" CHECK ("county_fips" ~ '^[0-9]{5}$'),
  CONSTRAINT "txgio_parcel_vintage_year_chk" CHECK ("vintage_year" BETWEEN 2000 AND 2100)
);

CREATE INDEX IF NOT EXISTS "txgio_parcel_vintage_prop_year_idx"
  ON "txgio_parcel_vintage" ("county_fips", "prop_id", "vintage_year");
