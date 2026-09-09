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
 */
import pg from "pg";

const COUNTY_FIPS = "48491";
const PROP_ID = "PRIVATE ROAD";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("DATABASE_URL is required (point at cortex-prod's neondb)");
}

const apply = process.argv.includes("--apply");

const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const { rows } = await pool.query(
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
    const del = await pool.query(
      `DELETE FROM cad_property WHERE county_fips = $1 AND prop_id = $2`,
      [COUNTY_FIPS, PROP_ID],
    );
    console.log(`[p124-ctx-leaves2-private-road] deleted ${del.rowCount} row(s)`);
  }
} finally {
  await pool.end();
}
