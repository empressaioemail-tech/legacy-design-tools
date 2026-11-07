-- P-479 (OPS-16). Locality -> county resolution stops being a sequential scan.
--
-- WHAT WAS WRONG. hauska-engine's coverage check
-- (`services/retrieval-api/src/coverage-check.ts`) answers "is this locality
-- served" by grouping `txgio_parcel` rows by county for a given situs ZIP
-- and/or situs city. Nothing indexed either column, so every uncached
-- locality ran a parallel sequential scan of this 29 GB / 14.9M-row table.
-- Measured live 2026-09-26 against https://retrieval.hauska.dev, one
-- never-before-resolved locality called twice on the same process:
--
--   cold (pays the scan)                 71_348 ms
--   warm (in-process localityCache)         229 ms
--
-- 311x. The service's own in-memory cache has a 24h TTL but dies with the
-- process, and hauska-retrieval-api is a single droplet, so every deploy or
-- restart puts the next customer of every locality back on the 71 s path.
-- That is what made the Find box answer `coverage_check_unavailable` for
-- Austin where `no-hit` was owed: PE's budget is 9 s, and the answer needed
-- 71. The verdict logic was correct the whole time; only the cost was wrong.
--
-- EXPLAIN (no ANALYZE, so reading the plan cost nothing) on 2026-09-26:
--   zip+city  -> Parallel Seq Scan on txgio_parcel  cost=0.00..2490050.39
--   zip only  -> Parallel Seq Scan on txgio_parcel  cost=0.00..2490039.34
--   city only -> Parallel Seq Scan on txgio_parcel  cost=0.00..2505571.41
--
-- Precedent: migration 0058 fixed this same defect class on this same table
-- (37,800 ms -> 0.30 ms). The coverage-check module header already named an
-- index as the correct fix and recorded that building one was outside that
-- lane's scope; P-479 is the row that removes the scope limit.
--
-- WHY THESE TWO SHAPES.
--
-- 1. `situs_zip` index carries county_fips AND situs_city IN THE KEY, so both
--    the zip-only branch and the one-scan zip+city branch are satisfiable by
--    an INDEX ONLY SCAN with no heap access. That matters because ZIP row
--    counts are wildly uneven: `situs_zip` has 1,234 distinct values over
--    14.9M rows and the hottest ('00000') holds ~2.4% of the table, ~363k
--    rows. A non-covering index would leave the fat ZIPs doing hundreds of
--    thousands of random heap fetches -- fast for a thin ZIP, slow for a fat
--    one, which is the kind of fix that passes its own test and fails a
--    customer. `pg_class.relallvisible` equals `relpages` (2,412,379 of
--    2,412,379, 100%) on this ingest-only table, so index-only scans are
--    actually reachable rather than theoretically available.
--
-- 2. `situs_city` is stored RAW in the ZIP index, not as `upper(situs_city)`.
--    The query computes `upper()` on the value the index returns. 0058's own
--    header warns that an expression index must be BYTE-IDENTICAL to the
--    query expression or Postgres silently declines to use it; keeping the
--    hot path off an expression removes that coupling entirely. The
--    city-only branch does need the expression, and gets its own index.
--
-- 3. Both are PARTIAL. `situs_zip` is 39.8% NULL and `situs_city` 42.5%
--    (pg_stats, 2026-09-26), so `WHERE ... IS NOT NULL` drops ~6M dead
--    entries from each index. An equality predicate implies NOT NULL, so the
--    planner can still use a partial index for `situs_zip = $1` and for
--    `upper(situs_city) = $1`.
--
-- `upper()` is IMMUTABLE, so the expression is index-valid.
--
-- Plain CREATE INDEX (not CONCURRENTLY), IF NOT EXISTS for idempotent
-- re-runs, and `SET statement_timeout = 0` -- all three exactly as 0058 does,
-- and for its reasons: the prod migration runner wraps each file in ONE
-- transaction and CREATE INDEX CONCURRENTLY cannot run inside one, while
-- CREATE INDEX is ACTIVE work so `idle_in_transaction_session_timeout` does
-- not fire during it. The build takes ACCESS EXCLUSIVE on txgio_parcel;
-- that table is ingest-only with no live writers on the request path, so the
-- lock blocks a concurrent ingest and nothing a customer is waiting on.

SET statement_timeout = 0;

CREATE INDEX IF NOT EXISTS "txgio_parcel_situs_zip_locality_idx"
  ON "txgio_parcel" ("situs_zip", "county_fips", "situs_city")
  WHERE "situs_zip" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "txgio_parcel_situs_city_upper_idx"
  ON "txgio_parcel" ((upper("situs_city")), "county_fips")
  WHERE "situs_city" IS NOT NULL;
