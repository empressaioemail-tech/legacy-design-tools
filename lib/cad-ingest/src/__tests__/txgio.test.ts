/**
 * TxGIO parcel-store unit tests — grid-cell tile bucketing, bbox math,
 * point-in-polygon (against a REAL Hays parcel), feature
 * normalization, the WGS84 .prj guard, county routing, and the
 * cad-ingest CLI micro-fixes (vintage URL-decode).
 */

import { describe, expect, it } from "vitest";
import {
  TXGIO_TILE_GRID_DEG,
  bboxOfGeometry,
  bboxesIntersect,
  cellKeyForPoint,
  cellKeysForBbox,
  pointInGeometry,
  type GeoJsonGeometry,
} from "../txgio/geo";
import {
  assertWgs84Prj,
  normalizeTxgioFeature,
  TXGIO_ENTRY_FILTER,
} from "../txgio/parse";
import {
  normalizeStatLandUse,
  normalizeStratMapLandUse,
} from "../txgio/landuse";
import { resolveTxgioCounty, txgioDownloadUrl } from "../txgio/counties";
import { deriveVintage } from "../download";
import { newCounters } from "../types";
import {
  HAYS_PARCEL_12310,
  HAYS_PARCEL_12310_INSIDE,
  HAYS_PARCEL_12310_OUTSIDE,
  HAYS_PRJ_WGS84,
  TX_STATE_PLANE_PRJ,
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
  it("accepts the real stratmap25 .prj", () => {
    expect(() => assertWgs84Prj(HAYS_PRJ_WGS84, "hays.prj")).not.toThrow();
  });

  it("refuses a state-plane .prj instead of storing non-WGS84 coordinates", () => {
    expect(() => assertWgs84Prj(TX_STATE_PLANE_PRJ, "bad.prj")).toThrow(
      /not GCS_WGS_1984/,
    );
  });
});

describe("TxGIO county registry + zip entry filter", () => {
  it("resolves by fips and name across all ten Central-TX counties", () => {
    expect(resolveTxgioCounty("48209")?.name).toBe("Hays");
    expect(resolveTxgioCounty("comal")?.fips).toBe("48091");
    // Wave D2: the metro-5 + gap counties are now bulk-loaded here so
    // the PMTiles bake has one uniform source. Travis (formerly
    // live-GIS-only) now resolves.
    expect(resolveTxgioCounty("48453")?.name).toBe("Travis");
    expect(resolveTxgioCounty("mclennan")?.fips).toBe("48309");
    expect(resolveTxgioCounty("48187")?.name).toBe("Guadalupe");
    // An out-of-scope county still resolves to undefined.
    expect(resolveTxgioCounty("48999")).toBeUndefined();
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
