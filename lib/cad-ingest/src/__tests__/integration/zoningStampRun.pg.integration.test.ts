/**
 * REAL POSTGRES integration coverage for migration 0112 (`zoning_stamp_run` +
 * `txgio_parcel.zoning_no_district_layer`) and the two write paths that use them
 * (`flushNoDistrictBatch` via `stampCountyZoning`, and `writeZoningStampRun`).
 *
 * WHY A SEPARATE, MINIMAL-SCHEMA INTEGRATION TEST rather than `@workspace/db/testing`'s
 * `withTestSchema` (which this repo's OTHER integration tests use): that helper replays the full
 * committed `schema.sql.template`, which `CREATE EXTENSION postgis` as its first statement -- this
 * session's standalone Postgres (a fresh `initdb`, started and stopped by hand per the W3 brief,
 * because Docker's own daemon was unresponsive in this sandbox) has no PostGIS package available.
 * This file instead creates the two tables migration 0112 actually touches directly from the real
 * migration SQL file plus a MINIMAL hand-written `txgio_parcel` (every column the zoning-stamp
 * write path reads or writes; none of the geometry/postgis machinery neither write path touches),
 * so it proves the SAME migration file and the SAME production code path against a REAL server,
 * without requiring PostGIS to be present.
 *
 * SKIPS cleanly (does not fail CI) when `TEST_DATABASE_URL` is unset, exactly like
 * `@workspace/db/testing`'s own `databaseUrl()` convention.
 *
 * This is the test that actually caught a real bug during development: `flushNoDistrictBatch`'s
 * first draft interpolated a bare JS array into the `sql` template
 * (`ANY(${featureIndexes}::integer[])`), which drizzle expands into a parenthesized tuple
 * (`ANY(($1, $2, $3))`) rather than a single array-typed parameter -- Postgres rejects casting that
 * to `integer[]` ("cannot cast type record to integer[]"), confirmed against this same test
 * database before the fix (`sql.param(featureIndexes)`) was applied.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  buildZoningStampRunRow,
  stampCountyZoning,
  writeZoningStampRun,
  type ZoningStampDb,
} from "../../txgio/zoning-stamp-db";
import { buildParcelIdIndex, buildZoningIndex } from "../../txgio/zoning-stamp";
import type { GeoJsonGeometry } from "../../txgio/geo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "db",
    "drizzle",
    "0112_zoning_stamp_run.sql",
  ),
  "utf8",
);

const MINIMAL_TXGIO_PARCEL_DDL = `
CREATE TABLE IF NOT EXISTS "txgio_parcel" (
  "county_fips" text NOT NULL,
  "tile_key" text NOT NULL,
  "feature_index" integer NOT NULL,
  "prop_id" text,
  "zoning_district" text,
  "zoning_jurisdiction" text,
  "zoning_district_interim" boolean,
  "geometry" jsonb NOT NULL,
  "west_lng" double precision NOT NULL,
  "south_lat" double precision NOT NULL,
  "east_lng" double precision NOT NULL,
  "north_lat" double precision NOT NULL,
  "source_file" text NOT NULL,
  "source_vintage" text NOT NULL,
  "ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "txgio_parcel_county_fips_tile_key_feature_index_pk"
    PRIMARY KEY ("county_fips", "tile_key", "feature_index")
);`;

function parcelSquare(cx: number, cy: number, halfSize = 0.0005): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [cx - halfSize, cy - halfSize],
        [cx + halfSize, cy - halfSize],
        [cx + halfSize, cy + halfSize],
        [cx - halfSize, cy + halfSize],
        [cx - halfSize, cy - halfSize],
      ],
    ],
  };
}

describeIfDb("migration 0112 + zoning-stamp write paths, against a REAL Postgres", () => {
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
    await pool.query(MINIMAL_TXGIO_PARCEL_DDL);
    await pool.query(MIGRATION_SQL);
    db = drizzle(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE "zoning_stamp_run" RESTART IDENTITY');
    await pool.query('TRUNCATE "txgio_parcel"');
  });

  it("migration 0112 is idempotent: applying it a second time is a no-op, not an error", async () => {
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
  });

  it("flushNoDistrictBatch (via stampCountyZoning): writes zoning_no_district_layer for the blank-own-feature bucket, leaving zoning_district/zoning_jurisdiction NULL -- the real array-param bind, not a fake", async () => {
    const ownGeometry = parcelSquare(-97.715, 30.72);
    await pool.query(
      `INSERT INTO txgio_parcel (county_fips, tile_key, feature_index, prop_id, geometry, west_lng, south_lat, east_lng, north_lat, source_file, source_vintage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      ["48053", "c1", 201, "200", JSON.stringify(ownGeometry), -97.72, 30.71, -97.71, 30.73, "test.zip", "test-vintage"],
    );

    const neighbourIndex = buildZoningIndex([
      { code: "C-2", description: "C-2 district", geometry: parcelSquare(-97.72, 30.715, 0.02) },
    ]);
    const parcelIdIndex = buildParcelIdIndex([
      { parcelId: "200", code: null, description: null, geometry: ownGeometry },
    ]);

    const summary = await stampCountyZoning({
      db: db as unknown as ZoningStampDb,
      countyFips: "48053",
      cityKey: "horseshoe-bay-tx",
      index: neighbourIndex,
      parcelIdIndex,
      // NOT dryRun -- the real write path.
    });

    expect(summary.parcelsNoDistrictOnLayer).toBe(1);

    const { rows } = await pool.query(
      `SELECT zoning_district, zoning_jurisdiction, zoning_no_district_layer FROM txgio_parcel WHERE feature_index = 201`,
    );
    expect(rows[0].zoning_no_district_layer).toBe("horseshoe-bay-tx");
    expect(rows[0].zoning_district).toBeNull();
    expect(rows[0].zoning_jurisdiction).toBeNull();
  });

  it("flushNoDistrictBatch handles MORE than one feature in a single batch (proves the array param carries multiple values, not just one)", async () => {
    const ownGeometry1 = parcelSquare(-97.715, 30.72);
    const ownGeometry2 = parcelSquare(-97.600, 30.60);
    for (const [fi, propId, geom] of [
      [301, "500", ownGeometry1],
      [302, "501", ownGeometry2],
    ] as const) {
      await pool.query(
        `INSERT INTO txgio_parcel (county_fips, tile_key, feature_index, prop_id, geometry, west_lng, south_lat, east_lng, north_lat, source_file, source_vintage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        ["48053", `c${fi}`, fi, propId, JSON.stringify(geom), -97.9, 30.5, -97.5, 30.9, "test.zip", "test-vintage"],
      );
    }
    const neighbourIndex = buildZoningIndex([
      { code: "C-2", description: "C-2 district", geometry: parcelSquare(-97.72, 30.715, 0.3) },
    ]);
    const parcelIdIndex = buildParcelIdIndex([
      { parcelId: "500", code: null, description: null, geometry: ownGeometry1 },
      { parcelId: "501", code: null, description: null, geometry: ownGeometry2 },
    ]);
    const summary = await stampCountyZoning({
      db: db as unknown as ZoningStampDb,
      countyFips: "48053",
      cityKey: "horseshoe-bay-tx",
      index: neighbourIndex,
      parcelIdIndex,
    });
    expect(summary.parcelsNoDistrictOnLayer).toBe(2);
    const { rows } = await pool.query(
      `SELECT feature_index, zoning_no_district_layer FROM txgio_parcel WHERE feature_index IN (301, 302) ORDER BY feature_index`,
    );
    expect(rows.map((r: { zoning_no_district_layer: string }) => r.zoning_no_district_layer)).toEqual([
      "horseshoe-bay-tx",
      "horseshoe-bay-tx",
    ]);
  });

  it("writeZoningStampRun persists a real row, dry_run is literal false, and the CHECK constraint actually rejects a planted dry_run=true", async () => {
    const inserted = await writeZoningStampRun(db as unknown as ZoningStampDb, {
      countyFips: "48053",
      cityKey: "marble-falls-tx",
      layerUrl: "https://mfgis.marblefallstx.gov/arcgis/rest/services/Planning/PDS/MapServer/16",
      layerReadAt: new Date("2026-10-09T21:00:00Z"),
      featuresRead: 4264,
      matched: 4264,
      noDistrictOnLayer: 0,
      parcelsNull: 0,
      idGeometryMismatch: 0,
      codeHistogram: { NR: 4264 },
    });
    expect(inserted.id).toBeGreaterThan(0);

    const { rows } = await pool.query("SELECT * FROM zoning_stamp_run WHERE id = $1", [inserted.id]);
    expect(rows[0].city_key).toBe("marble-falls-tx");
    expect(rows[0].matched).toBe(4264);
    expect(rows[0].dry_run).toBe(false);
    expect(rows[0].code_histogram).toEqual({ NR: 4264 });

    // The CHECK constraint (schema-level invariant: this table never holds a dry run) actually
    // rejects an attempt to insert dry_run=true directly, proving it is real, not decorative.
    await expect(
      pool.query(
        `INSERT INTO zoning_stamp_run (county_fips, city_key, layer_url, layer_read_at, features_read, matched, no_district_on_layer, parcels_null, id_geometry_mismatch, code_histogram, dry_run)
         VALUES ('48053','marble-falls-tx','https://example.test','2026-10-09T00:00:00Z',1,1,0,0,0,'{}'::jsonb, true)`,
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("buildZoningStampRunRow -> writeZoningStampRun end to end, read back exactly", async () => {
    const summary = {
      parcelsRead: 2495,
      accountBearingFeatures: 2495,
      accountsRead: 2495,
      parcelsMatched: 2470,
      parcelsUnmatched: 5,
      parcelsNoDistrictOnLayer: 23,
      parcelsIdGeometryMismatch: 18,
      parcelsSkippedNoAccount: 0,
      skippedNoAccountByReason: { zero: 0, empty: 0, null: 0 },
      parcelsUnrecognised: 0,
      parcelsPlannedDevelopment: 0,
      parcelsInterim: 0,
      parcelsInterimPlannedDevelopment: 0,
      interimBaseHistogram: {},
      interimValueHistogram: {},
      codeHistogram: { "R-1": 2470 },
      unrecognisedHistogram: {},
      overlayHistogram: {},
      rowsUpdated: 2495,
    };
    const row = buildZoningStampRunRow({
      countyFips: "48053",
      cityKey: "horseshoe-bay-tx",
      layerUrl: "https://horseshoebaygis.newedgeservices.com/arcgis/rest/services/Public/Zoning/FeatureServer/2",
      layerReadAt: new Date("2026-10-09T21:05:00Z"),
      summary,
    });
    const inserted = await writeZoningStampRun(db as unknown as ZoningStampDb, row);
    const { rows } = await pool.query("SELECT * FROM zoning_stamp_run WHERE id = $1", [inserted.id]);
    expect(rows[0].matched).toBe(2470);
    expect(rows[0].no_district_on_layer).toBe(23);
    expect(rows[0].parcels_null).toBe(5);
    expect(rows[0].id_geometry_mismatch).toBe(18);
    expect(rows[0].code_histogram).toEqual({ "R-1": 2470 });
  });
});
