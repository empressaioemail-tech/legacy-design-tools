/**
 * Zoning stamp run-record tests (migration 0112, Burnet stage-3 gap record
 * section 5): hauska-factory's gate 1 needs an independent reference to
 * reconcile stored `txgio_parcel` zoning rows against, per city. These tests
 * cover the two pieces that make that possible:
 *
 *   1. `buildZoningStampRunRow` — the pure mapping from a completed
 *      `ZoningStampSummary` to the run-record row, including the
 *      `matched`/`codeHistogram` folds (planned-development + unrecognised).
 *   2. The no-district-on-layer attribution write (`flushNoDistrictBatch`,
 *      reached through `stampCountyZoning`) — the BLANK-code bucket
 *      (Horseshoe Bay 69366/106280-shaped) now writes
 *      `zoning_no_district_layer` on a non-dry run, where before this change
 *      it wrote nothing and was indistinguishable in storage from a parcel
 *      outside every wired layer.
 *   3. `writeZoningStampRun` — the INSERT itself, against a fake that proves
 *      the SQL carries the right bound values (never a dry run; see the
 *      `dry_run` literal in the statement).
 *
 * The existing `zoningStamp.test.ts` "parcelIdIndex — Bug 2" suite only ever
 * runs `stampCountyZoning` with `dryRun: true`, so it never reaches either
 * write path this file exercises — these are genuinely new coverage, not a
 * duplicate of what dry-run already proves.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GeoJsonGeometry } from "../txgio/geo";
import { buildParcelIdIndex, buildZoningIndex } from "../txgio/zoning-stamp";
import {
  buildZoningStampRunRow,
  stampCountyZoning,
  writeZoningStampRun,
  type ZoningStampDb,
  type ZoningStampSummary,
} from "../txgio/zoning-stamp-db";

const dialect = new PgDialect();

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

function squareFeature(code: string, west: number, south: number, size: number) {
  const e = west + size;
  const n = south + size;
  return {
    code,
    description: `${code} district`,
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [west, south],
          [e, south],
          [e, n],
          [west, n],
          [west, south],
        ],
      ],
    },
  };
}

describe("buildZoningStampRunRow", () => {
  const baseSummary: ZoningStampSummary = {
    parcelsRead: 2495,
    accountBearingFeatures: 2495,
    accountsRead: 2495,
    parcelsMatched: 2470,
    parcelsUnmatched: 5,
    parcelsNoDistrictOnLayer: 23,
    parcelsIdGeometryMismatch: 18,
    parcelsSkippedNoAccount: 0,
    skippedNoAccountByReason: { zero: 0, empty: 0, null: 0 },
    parcelsUnrecognised: 3,
    parcelsPlannedDevelopment: 2,
    parcelsInterim: 0,
    parcelsInterimPlannedDevelopment: 0,
    interimBaseHistogram: {},
    interimValueHistogram: {},
    codeHistogram: { "R-1": 2000, "A-1": 300, "C-2": 170 },
    unrecognisedHistogram: { DR: 2, PD: 1 },
    overlayHistogram: {},
    rowsUpdated: 2495,
  };

  it("folds parcelsMatched + parcelsPlannedDevelopment + parcelsUnrecognised into `matched`", () => {
    const row = buildZoningStampRunRow({
      countyFips: "48053",
      cityKey: "horseshoe-bay-tx",
      layerUrl: "https://horseshoebaygis.newedgeservices.com/arcgis/rest/services/Public/Zoning/FeatureServer/2",
      layerReadAt: new Date("2026-10-09T12:00:00Z"),
      summary: baseSummary,
    });
    // 2470 + 2 + 3 = 2475: every bucket that writes SOME code counts.
    expect(row.matched).toBe(2475);
    expect(row.noDistrictOnLayer).toBe(23);
    expect(row.parcelsNull).toBe(5);
    expect(row.idGeometryMismatch).toBe(18);
    expect(row.featuresRead).toBe(2495);
  });

  it("merges codeHistogram with unrecognisedHistogram — the full written vocabulary, not just the base subset", () => {
    const row = buildZoningStampRunRow({
      countyFips: "48053",
      cityKey: "horseshoe-bay-tx",
      layerUrl: "https://example.test/layer",
      layerReadAt: new Date("2026-10-09T12:00:00Z"),
      summary: baseSummary,
    });
    expect(row.codeHistogram).toEqual({
      "R-1": 2000,
      "A-1": 300,
      "C-2": 170,
      DR: 2,
      PD: 1,
    });
  });

  it("sums counts on a code present in BOTH histograms (never drops or double-reports the overlap incorrectly)", () => {
    const summary: ZoningStampSummary = {
      ...baseSummary,
      codeHistogram: { "R-1": 10 },
      unrecognisedHistogram: { "R-1": 5 },
    };
    const row = buildZoningStampRunRow({
      countyFips: "48053",
      cityKey: "marble-falls-tx",
      layerUrl: "https://example.test/layer",
      layerReadAt: new Date(),
      summary,
    });
    expect(row.codeHistogram).toEqual({ "R-1": 15 });
  });
});

describe("stampCountyZoning (no-district-on-layer attribution write, migration 0112)", () => {
  const CITY = "horseshoe-bay-tx";
  const COUNTY = "48053";
  const neighbourIndex = buildZoningIndex([squareFeature("C-2", -97.72, 30.715, 0.01)]);
  const ownGeometry = parcelSquare(-97.715, 30.72);

  interface Row {
    countyFips: string;
    featureIndex: number;
    tileKey: string;
    propId: string | null;
    geometry: GeoJsonGeometry;
    zoningDistrict: string | null;
    zoningJurisdiction: string | null;
    zoningNoDistrictLayer: string | null;
  }

  /**
   * A fake whose `execute` dispatches on the SQL text, because this module
   * now issues TWO differently-shaped UPDATEs (`flushBatch`'s VALUES-joined
   * multi-column update, `flushNoDistrictBatch`'s single-column
   * `= ANY(...)` update) plus `writeZoningStampRun`'s INSERT — unlike
   * `zoningStamp.test.ts`'s `makeFakeDb`, which only ever needs to decode
   * the first shape because its "Bug 2" suite runs exclusively `dryRun`.
   */
  function makeFakeDb(rows: Row[]) {
    const table = rows.map((r) => ({ ...r }));
    const insertedRuns: Record<string, unknown>[] = [];
    const db = {
      selectDistinctOn() {
        const chain = {
          from() {
            return chain;
          },
          where(whereClause: SQL) {
            const { params } = dialect.sqlToQuery(whereClause);
            const county = params[0] as string;
            const filtered = table.filter((r) => r.countyFips === county);
            return {
              orderBy() {
                return Promise.resolve(
                  filtered
                    .slice()
                    .sort((a, b) => a.featureIndex - b.featureIndex)
                    .map((r) => ({
                      featureIndex: r.featureIndex,
                      geometry: r.geometry,
                      propId: r.propId,
                    })),
                );
              },
            };
          },
        };
        return chain;
      },
      execute(query: SQL) {
        const { sql: sqlText, params } = dialect.sqlToQuery(query);
        if (sqlText.includes("INSERT INTO")) {
          // writeZoningStampRun — record the row, return a fake id.
          insertedRuns.push({ sqlText, params });
          return Promise.resolve({ rows: [{ id: insertedRuns.length }] });
        }
        if (sqlText.includes("zoning_no_district_layer")) {
          // flushNoDistrictBatch template order: cityKey, countyFips, then the
          // feature-index list as ONE array-typed param (`sql.param(...)`,
          // confirmed live: a bare `${arr}` instead produces `ANY((1,2,3))`,
          // which Postgres rejects casting to integer[] -- "cannot cast type
          // record to integer[]").
          const [cityKey, county, featureIndexArray] = params as [string, string, number[]];
          const featureIndexes = new Set((featureIndexArray ?? []).map(Number));
          let rowCount = 0;
          for (const r of table) {
            if (r.countyFips !== county) continue;
            if (!featureIndexes.has(r.featureIndex)) continue;
            r.zoningNoDistrictLayer = cityKey;
            rowCount += 1;
          }
          return Promise.resolve({ rowCount });
        }
        // flushBatch's matched-pair shape: (feature_index, code, jurisdiction,
        // interim) tuples then a trailing county param.
        const county = params[params.length - 1] as string;
        const tupleParams = params.slice(0, params.length - 1);
        const stampByFeature = new Map<number, { code: string; jurisdiction: string }>();
        for (let i = 0; i < tupleParams.length; i += 4) {
          stampByFeature.set(Number(tupleParams[i]), {
            code: String(tupleParams[i + 1]),
            jurisdiction: String(tupleParams[i + 2]),
          });
        }
        let rowCount = 0;
        for (const r of table) {
          if (r.countyFips !== county) continue;
          const stamp = stampByFeature.get(r.featureIndex);
          if (stamp === undefined) continue;
          r.zoningDistrict = stamp.code;
          r.zoningJurisdiction = stamp.jurisdiction;
          rowCount += 1;
        }
        return Promise.resolve({ rowCount });
      },
    } as unknown as ZoningStampDb;
    return { db, rows: table, insertedRuns };
  }

  it("a non-dry run writes zoning_no_district_layer for the blank-own-feature bucket, leaving zoning_district/zoning_jurisdiction NULL", async () => {
    const parcelIdIndex = buildParcelIdIndex([
      { parcelId: "200", code: null, description: null, geometry: ownGeometry },
    ]);
    const fake = makeFakeDb([
      {
        countyFips: COUNTY,
        featureIndex: 201,
        tileKey: "c1",
        propId: "200",
        geometry: ownGeometry,
        zoningDistrict: null,
        zoningJurisdiction: null,
        zoningNoDistrictLayer: null,
      },
    ]);

    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      parcelIdIndex,
      // NOT dryRun — this is the write path dryRun: true never reaches.
    });

    expect(summary.parcelsNoDistrictOnLayer).toBe(1);
    const row = fake.rows[0];
    expect(row.zoningNoDistrictLayer).toBe(CITY);
    // The existing columns' contract is untouched by this path.
    expect(row.zoningDistrict).toBeNull();
    expect(row.zoningJurisdiction).toBeNull();
  });

  it("dryRun writes nothing for the no-district bucket either (zoningNoDistrictLayer stays NULL)", async () => {
    const parcelIdIndex = buildParcelIdIndex([
      { parcelId: "200", code: null, description: null, geometry: ownGeometry },
    ]);
    const fake = makeFakeDb([
      {
        countyFips: COUNTY,
        featureIndex: 201,
        tileKey: "c1",
        propId: "200",
        geometry: ownGeometry,
        zoningDistrict: null,
        zoningJurisdiction: null,
        zoningNoDistrictLayer: null,
      },
    ]);

    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      parcelIdIndex,
      dryRun: true,
    });

    expect(summary.parcelsNoDistrictOnLayer).toBe(1);
    expect(fake.rows[0].zoningNoDistrictLayer).toBeNull();
  });
});

describe("writeZoningStampRun", () => {
  it("inserts with dry_run literal false and returns the new id", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    const db = {
      execute(query: SQL) {
        const dialect2 = new PgDialect();
        const { sql: text, params } = dialect2.sqlToQuery(query);
        capturedSql = text;
        capturedParams = params;
        return Promise.resolve({ rows: [{ id: 42 }] });
      },
    } as unknown as ZoningStampDb;

    const result = await writeZoningStampRun(db, {
      countyFips: "48053",
      cityKey: "marble-falls-tx",
      layerUrl: "https://mfgis.marblefallstx.gov/arcgis/rest/services/Planning/PDS/MapServer/16",
      layerReadAt: new Date("2026-10-09T10:00:00Z"),
      featuresRead: 4264,
      matched: 4264,
      noDistrictOnLayer: 0,
      parcelsNull: 0,
      idGeometryMismatch: 0,
      codeHistogram: { NR: 1 },
    });

    expect(result.id).toBe(42);
    expect(capturedSql).toContain("INSERT INTO");
    expect(capturedSql).toContain("zoning_stamp_run");
    // dry_run is a literal `false` in the statement text, never a bound
    // param — this run-record writer can never be asked to record a dry run.
    expect(capturedSql).toMatch(/,\s*false\s*\)/);
    expect(capturedParams).not.toContain(false);
    expect(capturedParams).toContain("48053");
    expect(capturedParams).toContain("marble-falls-tx");
    expect(capturedParams).toContain(4264);
  });
});
