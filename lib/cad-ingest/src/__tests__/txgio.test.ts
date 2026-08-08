/**
 * TxGIO parcel-store unit tests — grid-cell tile bucketing, bbox math,
 * point-in-polygon (against a REAL Hays parcel), feature
 * normalization, the WGS84 .prj guard, county routing, and the
 * cad-ingest CLI micro-fixes (vintage URL-decode).
 */

import { describe, expect, it } from "vitest";
import {
  TEXAS_WGS84_BOUNDS,
  TXGIO_MAX_FEATURE_CELLS,
  TXGIO_TILE_GRID_DEG,
  bboxOfGeometry,
  bboxesIntersect,
  cellCountForBbox,
  cellKeyForPoint,
  cellKeysForBbox,
  isPlausibleTexasWgs84Bbox,
  pointInGeometry,
  type GeoJsonGeometry,
} from "../txgio/geo";
import {
  assertTexasWgs84Bbox,
  assertWgs84Prj,
  normalizeTxgioFeature,
  TxgioProjectionError,
  TXGIO_ENTRY_FILTER,
} from "../txgio/parse";
import {
  normalizeStatLandUse,
  normalizeStratMapLandUse,
} from "../txgio/landuse";
import {
  isTexasCountyFips,
  isTxgioCountyLoaded,
  resolveTxgioCounty,
  TXGIO_ABSENT_FROM_STRATMAP,
  TXGIO_COUNTIES,
  TXGIO_STATEWIDE_COUNTIES,
  txgioDownloadUrl,
} from "../txgio/counties";
import { deriveVintage } from "../download";
import { newCounters } from "../types";
import {
  HAYS_PARCEL_12310,
  HAYS_PARCEL_12310_INSIDE,
  HAYS_PARCEL_12310_OUTSIDE,
  HAYS_PRJ_WGS84,
  KING_48269_WEB_MERCATOR_BBOX,
  KING_48269_WEB_MERCATOR_PARCEL,
  TX_STATE_PLANE_PRJ,
  TXGIO_202505_WEB_MERCATOR_PRJ,
} from "./__fixtures__/txgioHaysParcel";

const HAYS_GEOMETRY = HAYS_PARCEL_12310.geometry as unknown as GeoJsonGeometry;

describe("grid-cell keys (tile bucketing)", () => {
  it("snaps a point down to its cell's lower-left corner (5dp, byte-stable)", () => {
    // -97.91274 / 0.02 = -4895.637 -> floor -4896 -> -97.92
    expect(cellKeyForPoint(-97.91274, 29.89535)).toBe("g0.02:-97.92000,29.88000");
    // Same cell for any point inside it.
    expect(cellKeyForPoint(-97.9001, 29.8999)).toBe("g0.02:-97.92000,29.88000");
    // Adjacent cell across the boundary.
    expect(cellKeyForPoint(-97.92001, 29.88)).toBe("g0.02:-97.94000,29.88000");
  });

  it("covers a bbox with every intersecting cell, iterated without float drift", () => {
    const keys = cellKeysForBbox({
      westLng: -97.93,
      southLat: 29.89,
      eastLng: -97.9,
      northLat: 29.91,
    });
    // lng cells: -97.94, -97.92, -97.90 (3); lat cells: 29.88, 29.90 (2).
    expect(keys).toHaveLength(6);
    expect(keys).toContain("g0.02:-97.94000,29.88000");
    expect(keys).toContain("g0.02:-97.90000,29.90000");
    // Every key the point helper would produce inside the bbox is covered.
    expect(keys).toContain(cellKeyForPoint(-97.905, 29.895));
  });

  it("returns null above maxCells so readers can fall back to a bbox scan", () => {
    const bbox = { westLng: -98.5, southLat: 29.5, eastLng: -97.5, northLat: 30.5 };
    expect(cellKeysForBbox(bbox, TXGIO_TILE_GRID_DEG, 256)).toBeNull();
    expect(cellKeysForBbox(bbox, TXGIO_TILE_GRID_DEG)).not.toBeNull();
  });

  it("buckets the real Hays parcel into exactly one cell (typical parcel << cell)", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    const keys = cellKeysForBbox(bbox)!;
    expect(keys).toEqual(["g0.02:-97.92000,29.88000"]);
    // ...which is the same cell the point-lookup read will scan.
    expect(keys[0]).toBe(
      cellKeyForPoint(
        HAYS_PARCEL_12310_INSIDE.longitude,
        HAYS_PARCEL_12310_INSIDE.latitude,
      ),
    );
  });
});

describe("bboxOfGeometry / bboxesIntersect", () => {
  it("computes the real parcel's bbox", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    expect(bbox.westLng).toBeCloseTo(-97.91313552599996, 10);
    expect(bbox.southLat).toBeCloseTo(29.895076204000077, 10);
    expect(bbox.eastLng).toBeCloseTo(-97.91233033799995, 10);
    expect(bbox.northLat).toBeCloseTo(29.895773322000025, 10);
  });

  it("returns null for empty geometry", () => {
    expect(bboxOfGeometry({ type: "Polygon", coordinates: [] })).toBeNull();
  });

  it("intersection test covers touch and containment", () => {
    const a = { westLng: 0, southLat: 0, eastLng: 2, northLat: 2 };
    expect(bboxesIntersect(a, { westLng: 2, southLat: 0, eastLng: 3, northLat: 1 })).toBe(true);
    expect(bboxesIntersect(a, { westLng: 0.5, southLat: 0.5, eastLng: 1, northLat: 1 })).toBe(true);
    expect(bboxesIntersect(a, { westLng: 2.1, southLat: 0, eastLng: 3, northLat: 1 })).toBe(false);
  });
});

describe("pointInGeometry (ray cast) — real Hays parcel 12310", () => {
  it("contains an interior point and rejects an exterior one", () => {
    expect(
      pointInGeometry(
        HAYS_PARCEL_12310_INSIDE.longitude,
        HAYS_PARCEL_12310_INSIDE.latitude,
        HAYS_GEOMETRY,
      ),
    ).toBe(true);
    expect(
      pointInGeometry(
        HAYS_PARCEL_12310_OUTSIDE.longitude,
        HAYS_PARCEL_12310_OUTSIDE.latitude,
        HAYS_GEOMETRY,
      ),
    ).toBe(false);
    // Every polygon vertex is outside-or-boundary; a point epsilon past
    // the east edge must be out.
    expect(pointInGeometry(-97.9123, 29.8956, HAYS_GEOMETRY)).toBe(false);
  });

  it("handles holes via the even-odd rule", () => {
    const donut: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
        [
          [4, 4],
          [6, 4],
          [6, 6],
          [4, 6],
          [4, 4],
        ],
      ],
    };
    expect(pointInGeometry(2, 2, donut)).toBe(true);
    expect(pointInGeometry(5, 5, donut)).toBe(false); // inside the hole
    expect(pointInGeometry(11, 5, donut)).toBe(false);
  });

  it("handles MultiPolygon parts independently", () => {
    const two: GeoJsonGeometry = {
      type: "MultiPolygon",
      coordinates: [
        [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
        ],
        [
          [
            [5, 5],
            [6, 5],
            [6, 6],
            [5, 6],
            [5, 5],
          ],
        ],
      ],
    };
    expect(pointInGeometry(0.5, 0.5, two)).toBe(true);
    expect(pointInGeometry(5.5, 5.5, two)).toBe(true);
    expect(pointInGeometry(3, 3, two)).toBe(false);
  });

  it("rejects non-polygon geometry types", () => {
    expect(
      pointInGeometry(0, 0, { type: "Point", coordinates: [0, 0] }),
    ).toBe(false);
  });
});

describe("normalizeTxgioFeature", () => {
  it("normalizes the real Hays feature (situs whitespace collapsed, tile keys bucketed)", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      1,
      HAYS_PARCEL_12310 as never,
      counters,
    );
    expect(rec).not.toBeNull();
    expect(rec!.countyFips).toBe("48209");
    expect(rec!.featureIndex).toBe(1);
    expect(rec!.propId).toBe("12310");
    expect(rec!.geoId).toBe("10-0017-2347-00000-3");
    expect(rec!.ownerName).toBe("DELEON FELIX");
    // The genuine double space in the source collapses to one.
    expect(rec!.situsAddress).toBe("707 UHLAND RD, SAN MARCOS, TX 78666");
    expect(rec!.situsCity).toBe("SAN MARCOS");
    expect(rec!.situsState).toBe("TX");
    expect(rec!.situsZip).toBe("78666");
    expect(rec!.tileKeys).toEqual(["g0.02:-97.92000,29.88000"]);
    expect(counters.rowsSkipped).toBe(0);
  });

  it("skips features without polygon geometry, with a counted sample", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48209",
      7,
      { geometry: null, properties: { Prop_ID: "1" } },
      counters,
    );
    expect(rec).toBeNull();
    expect(counters.rowsSkipped).toBe(1);
    expect(counters.skipSamples[0]).toContain("feature 7");
  });

  it("maps blank/absent attribute strings to null", () => {
    const counters = newCounters();
    const rec = normalizeTxgioFeature(
      "48091",
      0,
      { geometry: HAYS_PARCEL_12310.geometry as never, properties: { SITUS_ADDR: "   " } },
      counters,
    );
    expect(rec!.propId).toBeNull();
    expect(rec!.situsAddress).toBeNull();
    expect(rec!.ownerName).toBeNull();
  });
});

describe("StratMap STAT_LAND_ -> property_use_code", () => {
  it("takes the first non-blank comma segment (repeated-code parcel)", () => {
    // The overwhelmingly common Bexar form: same PTAD code per segment.
    expect(normalizeStatLandUse("A1,A1")).toBe("A1");
    expect(normalizeStatLandUse("F1,F1")).toBe("F1");
    expect(normalizeStatLandUse("A1")).toBe("A1");
  });

  it("takes the first-listed code on a genuine mixed-use parcel", () => {
    // ~1,793 of 709,541 Bexar rows carry two different codes; the
    // choropleth needs one, so the parcel's first-listed real code wins.
    expect(normalizeStatLandUse("A1,F1")).toBe("A1");
    expect(normalizeStatLandUse("B1,B2")).toBe("B1");
  });

  it("uppercases and trims, and skips a leading empty segment", () => {
    expect(normalizeStatLandUse(" a1 ")).toBe("A1");
    expect(normalizeStatLandUse(",A1")).toBe("A1");
    expect(normalizeStatLandUse("A,A1,")).toBe("A");
  });

  it("returns null for a blank field — never a fabricated code", () => {
    expect(normalizeStatLandUse("")).toBeNull();
    expect(normalizeStatLandUse("   ")).toBeNull();
    expect(normalizeStatLandUse(",")).toBeNull();
    expect(normalizeStatLandUse(null)).toBeNull();
    expect(normalizeStatLandUse(undefined)).toBeNull();
  });
});

describe("normalizeStratMapLandUse -> cad_property row", () => {
  // A real Bexar DBF attribute row shape (situs/value fields as the DBF
  // carries them, verified against the 48029 header 2026-07-20).
  const BEXAR_ROW = {
    Prop_ID: "105294",
    STAT_LAND_: "A1,A1",
    LOC_LAND_U: "RES",
    OWNER_NAME: "DOE JANE",
    SITUS_ADDR: "504  LAMAR , SAN ANTONIO, TX 78202",
    SITUS_CITY: "SAN ANTONIO",
    SITUS_ZIP: "78202",
    LEGAL_DESC: "NCB 1234 BLK 5 LOT 6",
    LAND_VALUE: "2.68880000000e+05",
    IMP_VALUE: "1.50000000000e+05",
    MKT_VALUE: "4.18880000000e+05",
    TAX_YEAR: "2025",
    FIPS: "48029",
  };

  it("maps STAT_LAND_ to a clean property_use_code and lands values as whole dollars", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse("48029", 0, BEXAR_ROW, counters);
    expect(rec).not.toBeNull();
    expect(rec!.countyFips).toBe("48029");
    expect(rec!.propId).toBe("105294");
    expect(rec!.taxYear).toBe(2025);
    expect(rec!.propertyUseCode).toBe("A1"); // A1,A1 collapsed
    expect(rec!.ownerName).toBe("DOE JANE");
    // situs whitespace collapsed (matches the parse.ts str() normalizer).
    expect(rec!.situsAddress).toBe("504 LAMAR , SAN ANTONIO, TX 78202");
    expect(rec!.situsCity).toBe("SAN ANTONIO");
    expect(rec!.landValue).toBe(268880);
    expect(rec!.improvementValue).toBe(150000);
    expect(rec!.marketValue).toBe(418880);
    // Fields StratMap does not carry stay null.
    expect(rec!.exemptionCodes).toBeNull();
    expect(rec!.yearBuilt).toBeNull();
    expect(rec!.landAcres).toBeNull();
    expect(counters.rowsSkipped).toBe(0);
  });

  it("strips leading zeros on all-numeric prop_id (matches normalizeCadPropId join key)", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, Prop_ID: "0000105294" },
      counters,
    );
    expect(rec!.propId).toBe("105294");
  });

  it("leaves property_use_code null when STAT_LAND_ is blank (commitment #1)", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, STAT_LAND_: "" },
      counters,
    );
    expect(rec).not.toBeNull(); // row still lands (owner/situs/value)
    expect(rec!.propertyUseCode).toBeNull();
  });

  it("drops zero/absent values to null rather than storing $0", () => {
    const counters = newCounters();
    const rec = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, LAND_VALUE: "0.00000000000e+00", MKT_VALUE: undefined },
      counters,
    );
    expect(rec!.landValue).toBeNull();
    expect(rec!.marketValue).toBeNull();
    expect(rec!.improvementValue).toBe(150000);
  });

  it("uses the fallback tax year only when the DBF row's TAX_YEAR is blank", () => {
    const counters = newCounters();
    const withRow = normalizeStratMapLandUse(
      "48029",
      0,
      { ...BEXAR_ROW, TAX_YEAR: "2024" },
      counters,
      2025,
    );
    expect(withRow!.taxYear).toBe(2024); // in-row wins
    const blank = normalizeStratMapLandUse(
      "48029",
      1,
      { ...BEXAR_ROW, TAX_YEAR: "" },
      counters,
      2025,
    );
    expect(blank!.taxYear).toBe(2025); // fallback used
  });

  it("skips a row with no Prop_ID or no resolvable tax year, with a counted sample", () => {
    const counters = newCounters();
    const noProp = normalizeStratMapLandUse(
      "48029",
      3,
      { ...BEXAR_ROW, Prop_ID: "   " },
      counters,
    );
    expect(noProp).toBeNull();
    const noYear = normalizeStratMapLandUse(
      "48029",
      4,
      { ...BEXAR_ROW, TAX_YEAR: "" },
      counters, // no fallback provided
    );
    expect(noYear).toBeNull();
    expect(counters.rowsSkipped).toBe(2);
    expect(counters.skipSamples[0]).toContain("feature 3");
  });
});

describe("WGS84 .prj guard", () => {
  it("accepts the real stratmap25 geographic .prj", () => {
    expect(() => assertWgs84Prj(HAYS_PRJ_WGS84, "hays.prj")).not.toThrow();
  });

  it("refuses a state-plane .prj instead of storing non-WGS84 coordinates", () => {
    // Caught by the PROJCS branch — a projected CRS is refused before
    // the datum is even considered, which is the correct order.
    expect(() => assertWgs84Prj(TX_STATE_PLANE_PRJ, "bad.prj")).toThrow(
      /PROJECTED coordinate system/,
    );
  });

  it("REGRESSION: refuses the real 202505 Web Mercator .prj whose nested GEOGCS says GCS_WGS_1984", () => {
    // This exact WKT ships on 12 of 12 sampled 202505 counties (57 of
    // 254 statewide). Its nested GEOGCS contains the `GCS_WGS_1984`
    // substring, so the pre-2026-08-08 datum-only guard PASSED on
    // coordinates in meters. It must now be refused.
    expect(TXGIO_202505_WEB_MERCATOR_PRJ.toUpperCase()).toContain(
      "GCS_WGS_1984",
    );
    expect(() =>
      assertWgs84Prj(TXGIO_202505_WEB_MERCATOR_PRJ, "king_48269.prj"),
    ).toThrow(/PROJECTED coordinate system/);
  });

  it("still refuses a geographic CRS on the wrong datum", () => {
    expect(() =>
      assertWgs84Prj(
        'GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983"]]',
        "nad83.prj",
      ),
    ).toThrow(/not GCS_WGS_1984/);
  });

  it("tolerates leading whitespace before PROJCS", () => {
    expect(() =>
      assertWgs84Prj(`\n  ${TXGIO_202505_WEB_MERCATOR_PRJ}`, "padded.prj"),
    ).toThrow(/PROJECTED coordinate system/);
  });
});

describe("Texas WGS84 coordinate-range assertion (the durable guard)", () => {
  it("accepts the real Hays parcel's bbox", () => {
    const bbox = bboxOfGeometry(HAYS_GEOMETRY)!;
    expect(isPlausibleTexasWgs84Bbox(bbox)).toBe(true);
    expect(() => assertTexasWgs84Bbox(bbox, "hays")).not.toThrow();
  });

  it("REGRESSION: rejects the real King 48269 (202505) Web Mercator header bbox", () => {
    // Real .shp header bbox, meters. xmin=-11189891.31 where a
    // legitimate value for that county is about -100.2 degrees.
    expect(isPlausibleTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX)).toBe(false);
    expect(() =>
      assertTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX, "king 48269"),
    ).toThrow(TxgioProjectionError);
    expect(() =>
      assertTexasWgs84Bbox(KING_48269_WEB_MERCATOR_BBOX, "king 48269"),
    ).toThrow(/outside the plausible Texas WGS84 envelope/);
  });

  it("catches a swapped lat/lng axis order", () => {
    // Hays coordinates with the pair transposed: lng 29.9, lat -97.9.
    expect(() =>
      assertTexasWgs84Bbox(
        { westLng: 29.895, southLat: -97.913, eastLng: 29.896, northLat: -97.912 },
        "swapped",
      ),
    ).toThrow(/outside the plausible Texas WGS84 envelope/);
  });

  it("rejects non-finite coordinates", () => {
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: NaN,
        southLat: 30,
        eastLng: -97,
        northLat: 31,
      }),
    ).toBe(false);
  });

  it("accepts the true corners of Texas but not a degree past the padded envelope", () => {
    // El Paso's western tip (~-106.65) and the Panhandle top (~36.50)
    // are comfortably inside.
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: -106.65,
        southLat: 25.84,
        eastLng: -93.51,
        northLat: 36.5,
      }),
    ).toBe(true);
    // Just past the padded envelope is out.
    expect(
      isPlausibleTexasWgs84Bbox({
        westLng: TEXAS_WGS84_BOUNDS.westLng - 0.001,
        southLat: 30,
        eastLng: -97,
        northLat: 31,
      }),
    ).toBe(false);
  });

  it("rejects a bbox that is in-range but spans an implausible number of cells", () => {
    // Whole-state extent: plausible degrees, but no PARCEL is that big.
    // (~730 x 600 cells, far above the per-feature ceiling.)
    const statewide = {
      westLng: -106,
      southLat: 26,
      eastLng: -94,
      northLat: 36,
    };
    expect(isPlausibleTexasWgs84Bbox(statewide)).toBe(true);
    expect(cellCountForBbox(statewide)).toBeGreaterThan(
      TXGIO_MAX_FEATURE_CELLS,
    );
    expect(() => assertTexasWgs84Bbox(statewide, "statewide")).toThrow(
      /per-feature ceiling/,
    );
  });
});

describe("normalizeTxgioFeature — projection fail-closed", () => {
  it("THROWS (does not skip) on a 202505-shaped Web Mercator feature", () => {
    const counters = newCounters();
    // Pre-fix this returned a record whose tileKeys were meter-space
    // keys, after attempting ~9.1e12 of them.
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        0,
        KING_48269_WEB_MERCATOR_PARCEL as never,
        counters,
      ),
    ).toThrow(TxgioProjectionError);
    // A projection error is a whole-county property, so it must NOT be
    // absorbed into the per-feature skip counter and reported as success.
    expect(counters.rowsSkipped).toBe(0);
  });

  it("names the county and feature index in the failure", () => {
    const counters = newCounters();
    expect(() =>
      normalizeTxgioFeature(
        "48269",
        417,
        KING_48269_WEB_MERCATOR_PARCEL as never,
        counters,
      ),
    ).toThrow(/county 48269 feature 417/);
  });
});

describe("cellKeysForBbox hardening", () => {
  it("throws rather than attempting an absurd key set when uncapped", () => {
    // The exact pre-fix failure path: ingest calls with maxCells
    // undefined, so the cap never engaged and the run died on memory.
    expect(() => cellKeysForBbox(KING_48269_WEB_MERCATOR_BBOX)).toThrow(
      /hard ceiling/,
    );
  });

  it("throws on non-finite coordinates instead of looping forever", () => {
    expect(() =>
      cellKeysForBbox({
        westLng: -Infinity,
        southLat: 29,
        eastLng: -97,
        northLat: 30,
      }),
    ).toThrow(/non-finite cell count/);
  });

  it("leaves the reader's maxCells fallback contract intact", () => {
    // A large-but-legitimate viewport still returns null (not a throw)
    // so api-server's bbox-column fallback keeps working.
    const viewport = {
      westLng: -98.5,
      southLat: 29.5,
      eastLng: -97.5,
      northLat: 30.5,
    };
    expect(cellKeysForBbox(viewport, TXGIO_TILE_GRID_DEG, 256)).toBeNull();
    expect(cellKeysForBbox(viewport, TXGIO_TILE_GRID_DEG)).not.toBeNull();
  });

  it("cellCountForBbox agrees with the materialized key count", () => {
    const bbox = {
      westLng: -97.93,
      southLat: 29.89,
      eastLng: -97.9,
      northLat: 29.91,
    };
    expect(cellCountForBbox(bbox)).toBe(cellKeysForBbox(bbox)!.length);
  });
});

describe("TxGIO county registry + zip entry filter", () => {
  it("resolves the loaded counties by fips and name, returning the registry object by identity", () => {
    expect(resolveTxgioCounty("48209")?.name).toBe("Hays");
    expect(resolveTxgioCounty("comal")?.fips).toBe("48091");
    expect(resolveTxgioCounty("48453")?.name).toBe("Travis");
    expect(resolveTxgioCounty("mclennan")?.fips).toBe("48309");
    expect(resolveTxgioCounty("48187")?.name).toBe("Guadalupe");
    // Identity matters: jurisdictions.ts composes these exact objects.
    expect(resolveTxgioCounty("48209")).toBe(TXGIO_COUNTIES["48209"]);
    expect(resolveTxgioCounty("travis")).toBe(TXGIO_COUNTIES["48453"]);
  });

  it("resolves UNLOADED counties too — the 19-county allowlist no longer gates the CLI", () => {
    // The blocker: these counties could not previously be resolved at
    // all, so the ingest CLI failed closed before any network call and
    // an unloaded county could not even be dry-run.
    const king = resolveTxgioCounty("48269");
    expect(king?.name).toBe("King");
    expect(king?.downloadUrl).toBe(txgioDownloadUrl("48269"));
    expect(resolveTxgioCounty("harris")?.fips).toBe("48201");
    expect(resolveTxgioCounty("48035")?.name).toBe("Bosque");
    // ...and they are correctly reported as NOT loaded.
    expect(isTxgioCountyLoaded("48269")).toBe(false);
    expect(isTxgioCountyLoaded("48209")).toBe(true);
  });

  it("carries all 254 Texas counties, and only real ones", () => {
    expect(Object.keys(TXGIO_STATEWIDE_COUNTIES)).toHaveLength(254);
    // Texas county codes are the odd numbers 001..507, exactly.
    for (const fips of Object.keys(TXGIO_STATEWIDE_COUNTIES)) {
      expect(fips).toMatch(/^48\d{3}$/);
      const code = Number(fips.slice(2));
      expect(code % 2).toBe(1);
      expect(code).toBeGreaterThanOrEqual(1);
      expect(code).toBeLessThanOrEqual(507);
    }
    // Every loaded county is a real one, with a matching name.
    for (const [fips, entry] of Object.entries(TXGIO_COUNTIES)) {
      expect(TXGIO_STATEWIDE_COUNTIES[fips]).toBe(entry.name);
    }
  });

  it("still fails closed on a typo, a non-county, or an out-of-state FIPS", () => {
    // 48999 and 48200 are not Texas counties (999 out of range; 200 even).
    expect(resolveTxgioCounty("48999")).toBeUndefined();
    expect(resolveTxgioCounty("48200")).toBeUndefined();
    expect(resolveTxgioCounty("49037")).toBeUndefined(); // San Juan, UT
    expect(resolveTxgioCounty("notacounty")).toBeUndefined();
    expect(isTexasCountyFips("48999")).toBe(false);
    expect(isTexasCountyFips("48269")).toBe(true);
  });

  it("names Donley 48129 as an honest absence rather than pretending it fetches", () => {
    // Resolvable (it IS a Texas county) but its StratMap archive 404s,
    // so the CLI refuses with an explanation instead of a stack trace.
    expect(resolveTxgioCounty("48129")?.name).toBe("Donley");
    expect(TXGIO_ABSENT_FROM_STRATMAP["48129"]).toMatch(/404/);
    expect(TXGIO_ABSENT_FROM_STRATMAP["48269"]).toBeUndefined();
  });

  it("builds the collection resource URL", () => {
    expect(txgioDownloadUrl("48209")).toBe(
      "https://data.geographic.texas.gov/0fa04328-872e-481c-b453-126a74777593/resources/stratmap25-landparcels_48209_lp.zip",
    );
  });

  it("extracts only the shapefile sidecars we parse", () => {
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.shp")).toBe(true);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.dbf")).toBe(true);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.prj")).toBe(true);
    // The 251MB fgdb copy and the .sbn/.xml sidecars stay in the zip.
    expect(TXGIO_ENTRY_FILTER("fgdb/stratmap25.gdb/a00000001.gdbtable")).toBe(false);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.shp.xml")).toBe(false);
    expect(TXGIO_ENTRY_FILTER("shp/stratmap25-landparcels_48209_hays_202503.sbn")).toBe(false);
  });
});

describe("cad-ingest CLI micro-fix: deriveVintage", () => {
  it("URL-decodes percent escapes instead of storing them (Travis regression)", () => {
    expect(
      deriveVintage(
        "https://traviscad.org/wp-content/largefiles/2026%20preliminary%20appraisal%20export%20supp%200_07072026.zip",
      ),
    ).toBe("2026-preliminary-appraisal-export-supp-0_07072026");
  });

  it("strips query/hash and extension, lowercases, dashes whitespace", () => {
    expect(deriveVintage("https://x.test/Drops/DATA-EXPORT-2026.zip?dl=1#frag")).toBe(
      "data-export-2026",
    );
    expect(deriveVintage("C:\\drops\\Hays Property 2026.TXT")).toBe(
      "hays-property-2026",
    );
  });

  it("keeps the raw basename on malformed percent escapes", () => {
    expect(deriveVintage("https://x.test/bad%zzname.zip")).toBe("bad%zzname");
  });
});
