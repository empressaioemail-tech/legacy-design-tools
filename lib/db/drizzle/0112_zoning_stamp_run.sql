-- Zoning stamp run record (Burnet stage-3 gap, 2026-10-09 record, OPS-24).
--
-- THE GAP THIS CLOSES. hauska-factory's gate 1 (`load-reconciliation-gate`) grades
-- txgio_parcel, cad_property and txgio_address against a DECLARED independent
-- reference count, but it has never had one for zoning: the zoning-stamp CLI
-- (zoning-cli.ts / zoning-stamp-db.ts) printed its summary to the log and wrote
-- nothing durable, so a truncated or re-run stamp left the SAME signal behind as a
-- correct one -- the exact "silent loss at load with a successful report" shape
-- gate 1 exists to close for the other four sources (P6/P-287). Burnet's 2026-10-09
-- Marble Falls (4,264 matched / 4,625 rows) and Horseshoe Bay (2,495 matched, 23
-- no-district, 18 id-geometry-mismatch / 2,580 rows) writes have no independent
-- record to reconcile against today -- this table is that record, going forward.
--
-- One row per non-dry-run `zoning-stamp --city=<key>` CLI invocation. Written by
-- `writeZoningStampRun` (zoning-stamp-db.ts) from `zoning-cli.ts`'s `main()`, AFTER
-- `stampCountyZoning`'s batched UPDATEs complete and before the CLI exits -- not
-- inside the same transaction as those UPDATEs, because the stamp's own write path
-- is already a sequence of independently-committed batch UPDATEs (`flushBatch`,
-- `ZONING_STAMP_BATCH_SIZE` at a time: a long county run must not lose the whole
-- stamp if the process dies mid-way), so there is no single transaction for this
-- insert to join. A crash between the LAST UPDATE and this INSERT is therefore
-- detected downstream, not prevented here: gate 1 (hauska-factory) would find
-- stamped `txgio_parcel` rows for a registered city with no matching run record and
-- refuse `ZONING_NOT_STAMPED` -- the conservative reading (an unrecorded write is
-- treated as unverified, never as a silent pass).
--
-- `dry_run` is CHECKed false: `--dry-run` never calls `writeZoningStampRun` at all
-- (zoning-cli.ts), so no row here is ever a dry run by construction, and the CHECK
-- makes that invariant visible in the schema itself rather than only in the caller.
--
-- Counts mirror `ZoningStampSummary` (zoning-stamp-db.ts) by name where it has one:
--   features_read         summary.parcelsRead (DISTINCT feature_index read for the
--                          county -- the same denominator every CLI log line uses).
--   matched                summary.parcelsMatched + parcelsPlannedDevelopment +
--                          parcelsUnrecognised: every feature that got SOME code
--                          written to zoning_district, not just the "base" bucket
--                          -- gate 1's reconciliation is against what is actually
--                          STORED, and all three buckets store a code.
--   no_district_on_layer  summary.parcelsNoDistrictOnLayer (Bug 2: the city's own
--                          parcel-id-matched feature carries a blank code --
--                          declared, never a neighbour's).
--   parcels_null           summary.parcelsUnmatched (no zoning polygon held the
--                          representative point -- outside the city, or unzoned).
--   id_geometry_mismatch   summary.parcelsIdGeometryMismatch (an id match whose
--                          joined feature did not geometrically contain the
--                          parcel -- fell back to the point lookup instead).
--   code_histogram         summary.codeHistogram MERGED with summary.unrecognisedHistogram:
--                          every code value this run actually wrote to
--                          zoning_district, by count. Gate 1's own vocabulary check
--                          ("no stored code outside the layer's own vocabulary")
--                          reads this column, so it must cover every code the run
--                          could have written -- not just the "base" subset.
--
-- `layer_read_at` is the time this run fetched the public GIS layer (not a layer
-- vintage field -- most configured layers either publish no reliable
-- service-level edit date or publish one inconsistently across cities; a read
-- timestamp this CLI itself observed is never a guess).
--
-- IF NOT EXISTS keeps this idempotent under the filename-tracked runner (no drizzle
-- meta journal -- see drizzle/README.md).

CREATE TABLE IF NOT EXISTS "zoning_stamp_run" (
  "id" bigserial PRIMARY KEY,
  "county_fips" text NOT NULL,
  "city_key" text NOT NULL,
  "layer_url" text NOT NULL,
  "layer_read_at" timestamptz NOT NULL,
  "features_read" integer NOT NULL,
  "matched" integer NOT NULL,
  "no_district_on_layer" integer NOT NULL,
  "parcels_null" integer NOT NULL,
  "id_geometry_mismatch" integer NOT NULL,
  "code_histogram" jsonb NOT NULL,
  "dry_run" boolean NOT NULL DEFAULT false,
  "finished_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "zoning_stamp_run_dry_run_false_chk" CHECK ("dry_run" = false),
  CONSTRAINT "zoning_stamp_run_county_fips_chk" CHECK ("county_fips" <> ''),
  CONSTRAINT "zoning_stamp_run_city_key_chk" CHECK ("city_key" <> '')
);

-- Gate 1's own read is "the LATEST run for this (county, city)" -- this index
-- serves that lookup directly (DESC on finished_at, LIMIT 1).
CREATE INDEX IF NOT EXISTS "zoning_stamp_run_city_finished_idx"
  ON "zoning_stamp_run" ("county_fips", "city_key", "finished_at" DESC);

-- Attribution for the "no district on this city's OWN layer" bucket (Burnet stage 3
-- Bug 2 / HSB parcels 69366 and 106280, 2026-10-09 record section 3). Today
-- `zoning-stamp-db.ts`'s batched UPDATE writes `zoning_district` + `zoning_jurisdiction`
-- ONLY for a feature that got a resolved code (`flushBatch`): a feature whose own
-- parcel-id-matched city feature carries a BLANK code is `continue`d past with no
-- write at all, so it is left with BOTH columns NULL -- indistinguishable in storage
-- from a parcel outside every wired layer entirely (confirmed live, 2026-10-09:
-- Burnet prop_ids 69366 and 106280 both read zoning_district NULL /
-- zoning_jurisdiction NULL). Gate 1's city-level reconciliation needs to count this
-- bucket from the STORED rows (design goal (a): "same feature count, plus the
-- declared no-district count"), so it needs a place to read it from.
--
-- A NEW column, not a repurposing of `zoning_jurisdiction` -- that column's existing
-- NULL-means-"outside every wired layer" contract (migration 0062; read today by
-- hauska-factory's `parcel-r5-zoning.mjs`, `zoning-layer-completeness.mjs` and the
-- `ctx-w2` coverage scripts, and by hauska-engine's `rail-keys.ts`) is left exactly
-- as it is for every row this migration does not touch. Written ONLY on the
-- no-district-on-layer path (zoning-stamp-db.ts); every other row stays NULL,
-- including every row that already has a non-NULL `zoning_jurisdiction`.
ALTER TABLE "txgio_parcel"
  ADD COLUMN IF NOT EXISTS "zoning_no_district_layer" text;
