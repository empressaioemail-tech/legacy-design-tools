-- P-124 CTX-HAYS-REBIND: the county's OTHER two published identifiers.
--
-- WHY. Tyler Orion property exports publish three identifiers per account in
-- adjacent columns -- PropertyID, QuickRefID and PropertyNumber -- and this
-- repo's parser has only ever read the first. cad_property is therefore keyed
-- on PropertyID while TxGIO/StratMap publishes Hays 48209 parcels under the
-- QuickRefID account number with its leading R already stripped at the source.
-- Two different published identifiers, one bare-numeric namespace, and the
-- 2026-08-25 P-78 StratMap merge upserted the TxGIO-keyed rows into
-- cad_property on (county_fips, prop_id, tax_year). Worked example, verified
-- live against the county's own export and the parcel store on 2026-09-10:
-- Hays CAD account 40138 carries QuickRefID R26199 and PropertyNumber
-- 11-2520-0000-03100-2, and txgio_parcel 48209 prop_id 26199 is that parcel.
-- Measured consequence on production: 30,862 Hays parcel nodes draw a
-- DIFFERENT parcel's polygon than the one the county's own crosswalk names.
--
-- WHAT THESE COLUMNS ARE. Evidence, not keys. The primary key stays
-- (county_fips, prop_id, tax_year); no existing consumer moves, no existing
-- row changes, and nothing is backfilled by this migration. property_number
-- is the join key to txgio_parcel.geo_id; quick_ref_id is the second,
-- independently derived identifier that corroborates it against
-- txgio_parcel.prop_id, so a geometry bind is an agreement between two
-- derivations rather than a presence check on one.
--
-- HONEST NULL. Both columns are nullable and stay NULL for every county whose
-- export does not publish them (the WCAD Socrata shape carries neither) and
-- for every row ingested before the parser change. NULL means "not published
-- / not acquired", never a defaulted empty string, and a null key can never
-- produce a bind.
--
-- NO INDEX, DELIBERATELY. The first draft of this migration carried a partial
-- index on (county_fips, property_number). It is not here, for two reasons and
-- the second is the one that matters. First, nothing queries cad_property by
-- property_number: the bake loads the county's declared-vintage rows by
-- (county_fips, tax_year) and reads the column off rows it already has, and an
-- index with no query is an artifact that exists, is correct, and does nothing.
-- Second, this repo's test schema fixture is a pg_dump of what `drizzle-kit
-- push` builds from lib/db/src/schema, NOT of what the migrations build --
-- proven by txgio_parcel.geom and txgio_parcel_geom_gist_idx from migration
-- 0095, which are in that migration and in production and appear NOWHERE in
-- schema.sql.template. A migration-only index would therefore drift the
-- fixture and fail CI's own drift check. If a reverse lookup ever lands, the
-- card that lands it adds the index alongside its query and declares it in the
-- drizzle schema so push and the fixture agree.
--
-- Column absence confirmed live against information_schema.columns on both
-- the staging (f06-staging-neondb) and production Neon branches, read-only,
-- 2026-09-10, before writing this migration.

ALTER TABLE "cad_property"
  ADD COLUMN IF NOT EXISTS "quick_ref_id" text;

ALTER TABLE "cad_property"
  ADD COLUMN IF NOT EXISTS "property_number" text;
