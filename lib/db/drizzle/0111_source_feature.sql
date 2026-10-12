-- P-499 (OPS-16 A-382/A-383). One national source-table shape, keyed on the
-- provider's own id, so a new state never gets a new bespoke `tx_*` /
-- `txgio_*` table. Card A of 4 (design `_design/2026-10-09_P-499_source_
-- shape_and_address_from_record.md` section 3; operator ruling A-383, D5:
-- ONE `source_feature` table, list-partitioned by provider).
--
-- WHAT WAS WRONG (design section 2, G1/G2/G4/G6). Every TxGIO/CAD/FEMA
-- loader invented its own table, its own key, and its own shape:
-- `txgio_parcel` keys on a POSITIONAL `(county_fips, tile_key,
-- feature_index)` and carries no provider id at all (G2); `txgio_address`
-- collapsed distinct points under a non-unique label until #802's
-- emergency rekey (0110, this same lineage); `tx_etj_boundary` and
-- `tx_utility_territory_staging` already key on the provider's own object
-- id (G4) -- that Factory 1.5 staging seam is what this migration
-- generalises into one shape every provider uses. A second state (Factory
-- 1.5 / P-19) cannot onboard onto N bespoke per-state shapes.
--
-- THE SHAPE. One row per (provider, county, provider's own feature id).
-- `provider` is a registry key (`lib/source-registry`), e.g.
-- 'txgio.address-points' -- provider plus layer, never a state name (Texas
-- is a column value here, not a table-name prefix). `provider_object_id`
-- is TEXT so a non-integer id fits. A provider with no usable id (G2's
-- TxGIO parcels) registers a DECLARED key rule instead -- content-derived
-- (e.g. sha256 of county_fips, prop_id, ST_AsBinary(geom)), never
-- positional and never a bigserial -- see `lib/source-registry`, which
-- `scripts/check-source-shape.mjs` enforces. `geom` is nullable for
-- providers with no geometry (permit/attribute-only layers); `payload` is
-- the provider's attributes verbatim, no renaming or dropping at this
-- layer -- typing happens in the derived rails/indexes that read this
-- table, not here (design section 3, "Cost").
--
-- PARTITIONING. LIST on `provider`, per operator ruling D5. This migration
-- creates ZERO partitions on purpose: a list-partitioned table with no
-- partitions accepts no rows at all for any provider value (Postgres:
-- "no partition of relation ... found for row"), which is the correct
-- state for Card A -- it lands the shape, not a loader. Card B creates the
-- first partition (`txgio.address-points`) when the address loader
-- actually targets this table. A partition is added by generating its DDL
-- from `lib/source-registry`'s `partitionDdlForProvider()` (CREATE TABLE
-- ... PARTITION OF "source_feature" FOR VALUES IN (...), plus a GiST index
-- on geom and whatever expression indexes that provider's registry entry
-- declares) and pasting the result into that card's own migration file --
-- never hand-written ad hoc per provider, so every partition gets the same
-- index shape its registry entry promised. (Tests that need a partition to
-- insert through -- e.g. `sourceFeatureSwap.integration.test.ts` -- create
-- and drop their own inside a `withTestSchema` block; none is committed
-- here.)
--
-- WRITE SEMANTICS: stage, check, then swap (design section 3; integration
-- review note 2) -- never delete-then-insert, the same class of defect
-- that produced the September Bastrop parcel mistake (a short or broken
-- download silently replacing a good county). A load writes
-- `source_feature_stage` (same columns, with `load_run_id` folded into the
-- key so several runs can stage side by side without colliding). Gate 1
-- (factory) checks the staged count against the registry's expected
-- count. Only on a pass does `swapStagedCounty()`
-- (`lib/db/src/sourceFeatureSwap.ts`) run the one-transaction replace:
-- delete the live (provider, county) rows, insert the staged run's rows,
-- delete that run's staged rows. `swapStagedCounty` itself re-checks the
-- staged row count against an `expectedCount` the caller must supply and
-- refuses (no-op, no delete, no insert) on a mismatch or an empty stage --
-- gate 1's reconciliation is the factory's job, but the swap function
-- never trusts a caller that skipped it.
--
-- `source_feature_stage` is deliberately NOT partitioned. It is always
-- queried scoped to (provider, county_fips, load_run_id) -- its own
-- primary key's leading columns, so that scan is a plain PK-prefix index
-- scan with no partition pruning needed. Partitioning it would require a
-- matching stage partition created in lockstep with every live partition,
-- for a table that holds rows only transiently (between one load's write
-- and that same load's own swap) and that no serving read ever touches.
--
-- LOCK / HOW THIS IS APPLIED. Both statements below create brand-new,
-- empty tables -- not an ALTER of a live one -- so there is no lock here
-- worth sizing against a live reader, unlike 0108/0110's ACCESS EXCLUSIVE
-- windows on tables that are read live. `SET LOCAL` (never plain `SET`),
-- per the 0110 W3 review: `migrate-prod.mjs` wraps this file in one
-- BEGIN/COMMIT, so LOCAL is scoped to this transaction and can never leak
-- onto a pooled connection's next client (the 2026-10-07 incident this
-- convention exists to prevent).

SET LOCAL statement_timeout = 0;

CREATE TABLE IF NOT EXISTS "source_feature" (
  "provider" text NOT NULL,
  "provider_object_id" text NOT NULL,
  "state_fips" text NOT NULL,
  "county_fips" text NOT NULL,
  "vintage" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "load_run_id" text NOT NULL,
  "source_url" text NOT NULL,
  "geom" geometry(Geometry,4326),
  "payload" jsonb NOT NULL,
  CONSTRAINT "source_feature_pk"
    PRIMARY KEY ("provider", "county_fips", "provider_object_id")
) PARTITION BY LIST ("provider");

CREATE TABLE IF NOT EXISTS "source_feature_stage" (
  "provider" text NOT NULL,
  "provider_object_id" text NOT NULL,
  "state_fips" text NOT NULL,
  "county_fips" text NOT NULL,
  "vintage" text NOT NULL,
  "fetched_at" timestamp with time zone NOT NULL,
  "load_run_id" text NOT NULL,
  "source_url" text NOT NULL,
  "geom" geometry(Geometry,4326),
  "payload" jsonb NOT NULL,
  -- `load_run_id` sits before `provider_object_id` so the leading three
  -- columns of this PK's own btree ARE the (provider, county_fips,
  -- load_run_id) prefix every swap/count-check query filters on -- no
  -- second index is needed on this table.
  CONSTRAINT "source_feature_stage_pk"
    PRIMARY KEY ("provider", "county_fips", "load_run_id", "provider_object_id")
);
