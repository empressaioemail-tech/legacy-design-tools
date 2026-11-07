/**
 * A re-stamp must not leave a code on a parcel the city's current layer no
 * longer puts in any district.
 *
 * Measured 2026-11-05 on Bastrop (48021): prop 28413 is stamped IND and props
 * 61247 and 65702 are stamped PDD, all with zoning_jurisdiction
 * 'bastrop-city-tx'. But no current Zoned_Parcels/83 polygon holds their
 * representative points: overlap with the city's polygons is 0.7% for 28413
 * and 0% for the other two. The ledger reads them as unincorporated or
 * unzoned. The stamp writer only ever UPDATEs matched rows, so a re-stamp
 * kept the old codes.
 *
 * FALSIFIER: on main the stale row keeps "IND" after a clearStale run (the
 * option does not exist there). Controls: the default run is unchanged, a
 * row another city stamped is never touched, a dry run writes nothing, and
 * a partial run refuses clearStale.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GeoJsonGeometry } from "../txgio/geo";
import { buildZoningIndex } from "../txgio/zoning-stamp";
import { stampCountyZoning, type ZoningStampDb } from "../txgio/zoning-stamp-db";

const dialect = new PgDialect();
const CITY = "bastrop-city-tx";
const FIPS = "48021";

function square(x: number, y: number, d: number): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
  } as GeoJsonGeometry;
}

interface Row {
  featureIndex: number;
  propId: string;
  geometry: GeoJsonGeometry;
  zoningDistrict: string | null;
  zoningJurisdiction: string | null;
  zoningDistrictInterim: boolean | null;
}

/**
 * In-memory txgio_parcel. Dispatches `execute` on the compiled SQL text:
 * the stamp UPDATE (VALUES join), the stale SELECT, and the stale clear.
 */
function fakeDb(rows: Row[]) {
  const table = rows.map((r) => ({ ...r }));
  const writes: string[] = [];
  const db = {
    selectDistinctOn() {
      const chain = {
        from: () => chain,
        where: () => ({
          orderBy: () =>
            Promise.resolve(
              table.map((r) => ({ featureIndex: r.featureIndex, geometry: r.geometry, propId: r.propId })),
            ),
        }),
      };
      return chain;
    },
    execute(query: SQL) {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (/^\s*SELECT DISTINCT feature_index/.test(text)) {
        const [county, city] = params as string[];
        return Promise.resolve({
          rows: table
            .filter((r) => county === FIPS && r.zoningJurisdiction === city)
            .map((r) => ({ feature_index: r.featureIndex, prop_id: r.propId, zoning_district: r.zoningDistrict })),
        });
      }
      if (/SET zoning_district = NULL/.test(text)) {
        writes.push("clear");
        const [county, city, ...idx] = params as (string | number)[];
        let rowCount = 0;
        for (const r of table) {
          if (county !== FIPS || r.zoningJurisdiction !== city || !idx.map(Number).includes(r.featureIndex)) continue;
          r.zoningDistrict = null;
          r.zoningJurisdiction = null;
          r.zoningDistrictInterim = null;
          rowCount += 1;
        }
        return Promise.resolve({ rowCount });
      }
      // Stamp UPDATE: (featureIndex, code, jurisdiction, interim) tuples, then county.
      writes.push("stamp");
      const tuples = params.slice(0, params.length - 1);
      let rowCount = 0;
      for (let i = 0; i < tuples.length; i += 4) {
        const r = table.find((t) => t.featureIndex === Number(tuples[i]));
        if (!r) continue;
        r.zoningDistrict = String(tuples[i + 1]);
        r.zoningJurisdiction = String(tuples[i + 2]);
        r.zoningDistrictInterim = tuples[i + 3] === true;
        rowCount += 1;
      }
      return Promise.resolve({ rowCount });
    },
  } as unknown as ZoningStampDb;
  return { db, table, writes };
}

// One IND polygon. Parcel 1 sits inside it; 2, 3 and 4 sit well outside.
const index = buildZoningIndex([{ code: "IND", geometry: square(-97.31, 30.09, 0.002) }]);

function fixture(): Row[] {
  return [
    { featureIndex: 1, propId: "100", geometry: square(-97.3095, 30.0905, 0.0005), zoningDistrict: null, zoningJurisdiction: null, zoningDistrictInterim: null },
    // Stale: stamped IND for this city by an earlier run, no polygon holds it now.
    { featureIndex: 2, propId: "28413", geometry: square(-97.2, 30.2, 0.0005), zoningDistrict: "IND", zoningJurisdiction: CITY, zoningDistrictInterim: false },
    // Another city's stamp: never touched by this city's run.
    { featureIndex: 3, propId: "12830", geometry: square(-97.1, 30.3, 0.0005), zoningDistrict: "S-P", zoningJurisdiction: "elgin-tx", zoningDistrictInterim: false },
    { featureIndex: 4, propId: "400", geometry: square(-97.0, 30.4, 0.0005), zoningDistrict: null, zoningJurisdiction: null, zoningDistrictInterim: null },
  ];
}

const byProp = (rows: Row[], p: string) => rows.find((r) => r.propId === p)!;

describe("zoning stamp clearStale: a parcel the current layer leaves out loses its old code", () => {
  it("FALSIFIER: clearStale clears the stale IND stamp, and only that one", async () => {
    const f = fakeDb(fixture());
    const s = await stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index, clearStale: true } as Parameters<typeof stampCountyZoning>[0]);
    expect(byProp(f.table, "28413").zoningDistrict).toBeNull();
    expect(byProp(f.table, "28413").zoningJurisdiction).toBeNull();
    expect(byProp(f.table, "100").zoningDistrict).toBe("IND");
    expect(byProp(f.table, "12830")).toMatchObject({ zoningDistrict: "S-P", zoningJurisdiction: "elgin-tx" });
    expect(s.staleFeatures).toBe(1);
    expect(s.staleRowsCleared).toBe(1);
    expect(s.staleSample).toEqual(["28413=IND"]);
  });

  it("control: the default run is unchanged and leaves the stale stamp", async () => {
    const f = fakeDb(fixture());
    const s = await stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index });
    expect(byProp(f.table, "28413").zoningDistrict).toBe("IND");
    expect(s.staleFeatures).toBeUndefined();
    expect(f.writes).not.toContain("clear");
  });

  it("control: a dry run counts and samples the stale stamp and writes nothing", async () => {
    const f = fakeDb(fixture());
    const s = await stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index, dryRun: true, clearStale: true } as Parameters<typeof stampCountyZoning>[0]);
    expect(s.staleFeatures).toBe(1);
    expect(s.staleRowsCleared).toBe(0);
    expect(byProp(f.table, "28413").zoningDistrict).toBe("IND");
    expect(f.writes).toEqual([]);
  });

  it("control: a --limit run refuses clearStale", async () => {
    const f = fakeDb(fixture());
    await expect(
      stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index, limit: 2, clearStale: true } as Parameters<typeof stampCountyZoning>[0]),
    ).rejects.toThrow(/whole-county run/);
  });

  it("control: a --prop-ids-file run refuses clearStale", async () => {
    const f = fakeDb(fixture());
    await expect(
      stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index, propIds: new Set(["28413"]), clearStale: true } as Parameters<typeof stampCountyZoning>[0]),
    ).rejects.toThrow(/whole-county run/);
  });

  it("control: an empty zoning index refuses clearStale", async () => {
    const f = fakeDb(fixture());
    await expect(
      stampCountyZoning({ db: f.db, countyFips: FIPS, cityKey: CITY, index: [], clearStale: true } as Parameters<typeof stampCountyZoning>[0]),
    ).rejects.toThrow(/index is empty/);
  });
});
