#!/usr/bin/env node
/**
 * P-124 CTX-LEAVES2, defect 3: 48491:PRIVATE ROAD data correction.
 *
 * One `cad_property` row for Williamson (county_fips 48491) carries the
 * literal string `PRIVATE ROAD` where a `prop_id` belongs -- a StratMap
 * "leftover farm" lineage artifact (P-78 family): a right-of-way attribute
 * value from the source shapefile misread as a parcel account number by
 * `lib/cad-ingest/src/txgio/landuse.ts`'s `normalizeStratMapLandUse`, before
 * this card's `isParcelShapedPropId` guard existed. Live-confirmed
 * 2026-09-09/10 (read-only, CORTEX_DATABASE_URL): exactly one row, one
 * source_file (`stratmap25-landparcels_48491_lp.zip`), no collision with any
 * real account.
 *
 * This script REMOVES that row (option (a) of the two named in the
 * dispatch): `cad_property` has no "excluded" / "non-parcel" column to
 * re-classify onto (see `lib/db/src/schema/cadProperty.ts`), so a targeted
 * DELETE by the exact composite key is the available correction. It is
 * scoped as narrowly as the primary key allows (county_fips + prop_id, no
 * wildcard, no LIKE) and refuses to act on anything it did not first print
 * for review.
 *
 * Deliberately NOT run as part of this change -- per the dispatch, this
 * lane writes code and commits; it does not execute a live production
 * mutation. Run this explicitly, with DATABASE_URL pointed at cortex-prod's
 * neondb (the store `cad_property` actually lives on, per CTX-ACREAGE's
 * close -- NOT hauska-factory's FACTORY_DATABASE_URL, a different host):
 *
 *   DATABASE_URL=<cortex-prod neondb> node lib/db/scripts/p124-ctx-leaves2-private-road-correction.mjs           # dry run (default): prints matches, changes nothing
 *   DATABASE_URL=<cortex-prod neondb> node lib/db/scripts/p124-ctx-leaves2-private-road-correction.mjs --apply   # deletes the matched row(s)
 *
 * `landing_cad_property` (hauska-factory's own verbatim copy of this table,
 * a different Neon host) is NOT touched here -- this dispatch forbids
 * writing to hauska-factory, and `landing-import.mjs`'s streamCopy() is a
 * byte-for-byte copy job outside this script's scope; its own next run
 * inherits this correction from the source. Left named in the close's
 * leave_behind.
 *
 * GATE 4 / P4 (audit 2026-10-07): this is a cad_property WRITER (the
 * DELETE below), so it takes the same session advisory lock every other
 * cad_property writer takes before it writes -- CAD_PROPERTY_WRITE_LOCKED
 * refuses rather than racing a concurrent cad-ingest load or backfill run
 * on county 48491. This file is a standalone script outside the
 * @workspace/cad-ingest TS build (run with plain `node`, no tsx), so it
 * cannot `import` `@workspace/db/cadPropertyWriteLock`'s TypeScript
 * source; LOCK_NAMESPACE below is byte-for-byte that module's
 * `cadPropertyLockNamespace(countyFips)` (see its header), so this script
 * contends on the IDENTICAL advisory-lock key, not a parallel one.
 *
 * DIRECT HOST FOR --apply ONLY (2026-10-07, coordinator-verified): a
 * `DATABASE_URL` pointed at cortex-prod's pooled endpoint would make the
 * lock above refuse unconditionally (session-scoped locks cannot survive
 * a pooler returning the connection between statements). So an --apply
 * run derives the direct host from whatever `DATABASE_URL` was given,
 * the same way `@workspace/db/directNeonUrl` does (its own header has the
 * full reasoning and the search for an existing helper first) -- byte-for-
 * byte the same derivation, for the same "cannot import TS from plain
 * node" reason LOCK_NAMESPACE above is duplicated rather than imported.
 * A dry run (the default) is unaffected: it reads through whatever host
 * was configured, exactly as before.
 */
import pg from "pg";

const COUNTY_FIPS = "48491";
const PROP_ID = "PRIVATE ROAD";
// Must match @workspace/db's cadPropertyLockNamespace(COUNTY_FIPS) exactly.
const LOCK_NAMESPACE = `cad_property_write|${COUNTY_FIPS}`;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("DATABASE_URL is required (point at cortex-prod's neondb)");
}

const apply = process.argv.includes("--apply");

// Must match @workspace/db's directNeonUrl(dsn) exactly.
function directNeonUrl(dsn) {
  const url = new URL(dsn);
  const labels = url.hostname.split(".");
  const first = labels[0] ?? "";
  if (!first.endsWith("-pooler")) {
    return dsn;
  }
  labels[0] = first.slice(0, -"-pooler".length);
  url.hostname = labels.join(".");
  return url.toString();
}

const connectionUrl = apply ? directNeonUrl(databaseUrl) : databaseUrl;
const pool = new pg.Pool({ connectionString: connectionUrl });
// One pinned connection for the lock AND the queries below -- a bare
// pool.query() call can be served by a different physical connection each
// time, which cannot hold a session advisory lock across the run.
const client = await pool.connect();
let locked = false;
try {
  if (apply) {
    const { rows: lockRows } = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1 || '|' || current_schema(), 0)) AS locked",
      [LOCK_NAMESPACE],
    );
    locked = lockRows[0]?.locked === true;
    if (!locked) {
      console.error(
        JSON.stringify({
          event: "p124-ctx-leaves2-private-road.refused",
          code: "CAD_PROPERTY_WRITE_LOCKED",
          message:
            `another cad_property writer already holds the write lock for county ${COUNTY_FIPS}; ` +
            "wait for it to finish and retry.",
        }),
      );
      process.exit(2);
    }
  }

  // CAD_PROPERTY_MULTI_YEAR_INVENTORY — intentional; this is a targeted
  // removal by exact (county_fips, prop_id) identity, not a declared-vintage
  // read. The artifact's own source_vintage tier (stratmap-roll) predates
  // Williamson's current declared tier (cad-export), so a declared-vintage
  // filter would miss the very row this script exists to find.
  const { rows } = await client.query(
    `SELECT county_fips, prop_id, tax_year, source_file, source_vintage, land_acres, situs_address
       FROM cad_property
      WHERE county_fips = $1 AND prop_id = $2
      ORDER BY tax_year`,
    [COUNTY_FIPS, PROP_ID],
  );

  console.log(
    `[p124-ctx-leaves2-private-road] found ${rows.length} row(s) at (county_fips=${COUNTY_FIPS}, prop_id=${JSON.stringify(PROP_ID)}):`,
  );
  for (const r of rows) {
    console.log(`  ${JSON.stringify(r)}`);
  }

  if (rows.length === 0) {
    console.log("[p124-ctx-leaves2-private-road] nothing to do (already corrected, or never present on this store)");
  } else if (!apply) {
    console.log("[p124-ctx-leaves2-private-road] DRY RUN -- pass --apply to delete the row(s) printed above");
  } else {
    const del = await client.query(
      `DELETE FROM cad_property WHERE county_fips = $1 AND prop_id = $2`,
      [COUNTY_FIPS, PROP_ID],
    );
    console.log(`[p124-ctx-leaves2-private-road] deleted ${del.rowCount} row(s)`);
  }
} finally {
  if (locked) {
    await client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1 || '|' || current_schema(), 0))",
      [LOCK_NAMESPACE],
    );
  }
  client.release();
  await pool.end();
}
