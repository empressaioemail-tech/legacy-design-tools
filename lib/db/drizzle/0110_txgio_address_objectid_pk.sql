-- Fix the primary key of txgio_address: (county_fips, full_addr, unit) ->
-- (county_fips, object_id). object_id becomes NOT NULL.
--
-- WHAT WAS WRONG. The StratMap Address Points service's `full_addr` label
-- is not a stable per-point identity: `full_addr` + `unit` (the key 0056
-- chose) collapses multiple DISTINCT delivery points that happen to share
-- a label. Measured live on Burnet (48053), 2026-10-09: the service
-- returned 35,857 points; the county-partitioned load's own upsert, keyed
-- on (county_fips, full_addr, unit) with ON CONFLICT DO UPDATE, stored
-- only 35,690 rows -- 167 points lost across 86 colliding (full_addr,
-- unit) groups. None of the 86 groups share coordinates (e.g. "2903 N US
-- 281" exists at two points ~21 km apart in Burnet; "1107 CR 264" has
-- buildings 1-7 at different points, and `building` is not part of the
-- key). ON CONFLICT last-write-wins means some of the 35,690 stored rows
-- are at the WRONG point for their label. The CLI's own `rowsInserted`
-- counter made this invisible too: it counted batch length, so a
-- conflict-UPDATE was reported as an insert (the same run logged
-- "35,750 rows inserted" against 35,690 rows actually stored). That
-- counting bug is fixed separately in lib/cad-ingest/src/address/ingest.ts
-- (this migration only fixes the key).
--
-- WHY object_id IS SAFE NOW. `object_id` is the service's OBJECTID,
-- explicitly kept-but-not-keyed-on by 0056 because "it churns across
-- vintages" statewide. That churn is real for a BARE, cross-county
-- object_id (confirmed: 24,411 OBJECTIDs repeat across different Texas
-- counties, because each county's slice was loaded at a different time
-- from a different vintage of the statewide layer) -- but it is not a
-- problem for a key SCOPED to (county_fips, object_id). Measured live
-- 2026-10-09 across all 1,724,640 rows currently stored in the 7 loaded
-- counties: object_id is NEVER null, and (county_fips, object_id) has
-- ZERO duplicate groups. The cross-vintage churn 0056 was keying around
-- does not reach this table either way, because `address/ingest.ts`
-- replaces a county WHOLESALE (DELETE then insert) on every run -- a
-- fresher vintage's OBJECTIDs never have to coexist in this table with a
-- stale vintage's OBJECTIDs for the SAME county.
--
-- full_addr/unit are KEPT (not dropped) -- they remain the join surface
-- to CAD situs via the normalized-expression index already built in 0058
-- (`txgio_address_fulladdr_norm_idx`, on `(county_fips, <normalized
-- full_addr>)`). This migration does NOT add a plain index on
-- (county_fips, full_addr, unit): checked first, per the rule that an
-- index with no query behind it is not a fix. No code does a literal
-- (non-normalized) equality lookup on (full_addr, unit) -- the resolver
-- (artifacts/api-server/src/lib/txgioAddressResolve.ts) uses
-- `normalizedColumnExpr("full_addr")` throughout (0058 is the index for
-- that path), and the only other non-test references to these two
-- columns outside this table's own ingest path are a SELECT projection.
-- 0058 already indexes the lookup that is actually run.
--
-- LOCK / HOW THIS IS APPLIED. `lib/db/scripts/migrate-prod.mjs` wraps
-- every file in ONE transaction (BEGIN ... COMMIT around the whole
-- file), so CREATE INDEX CONCURRENTLY cannot be used here -- the same
-- constraint 0058's and 0108's headers already document for this
-- migration runner. Both statements below take ACCESS EXCLUSIVE on
-- txgio_address for their duration:
--   1. SET NOT NULL scans the table to verify no NULLs. Production has
--      zero nulls today (measured above), so this is a verification
--      scan, not a backfill.
--   2. ADD CONSTRAINT ... PRIMARY KEY builds a new unique btree index on
--      (county_fips, object_id) and validates uniqueness -- also zero
--      conflicts today (measured above), so this is index-build time,
--      not data repair.
-- txgio_address measures 573 MB (table) / 766 MB (total with indexes,
-- measured read-only 2026-10-09) -- far smaller than the 14.9M-row/29 GB
-- txgio_parcel table 0108 sized its own ACCESS EXCLUSIVE window against;
-- expect a low-single-digit-second lock on a table this size, not
-- minutes. The table IS read live (the resolver, and address
-- autocomplete/search), so a request landing inside that window waits
-- for the lock rather than erroring. Apply in a low-traffic window if
-- one is available, same as any other ACCESS EXCLUSIVE DDL against a
-- live-read table in this repo.
--
-- `SET statement_timeout = 0` guards against a future non-zero default
-- killing the migration mid-way, same reasoning as 0058/0108.

-- SET LOCAL, not SET (W3 review): migrate-prod.mjs runs this file inside BEGIN/COMMIT, so LOCAL
-- covers every statement here and ends with the transaction. A plain SET would outlive the COMMIT
-- and, through a Neon -pooler host, leak onto a shared server connection (2026-10-07 incident).
SET LOCAL statement_timeout = 0;

ALTER TABLE "txgio_address" ALTER COLUMN "object_id" SET NOT NULL;

ALTER TABLE "txgio_address"
  DROP CONSTRAINT IF EXISTS "txgio_address_county_fips_full_addr_unit_pk";

ALTER TABLE "txgio_address"
  ADD CONSTRAINT "txgio_address_county_fips_object_id_pk"
    PRIMARY KEY ("county_fips", "object_id");
