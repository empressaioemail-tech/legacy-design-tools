/**
 * Burnet County (48053) PER-PARCEL setbacks for Marble Falls and Horseshoe Bay (OPS-24 stage 6,
 * 2026-10-13; operator ruling "don't ship Burnet half way; do the districts").
 *
 * Every number asserted below is a pack E cell (doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_
 * browser_packE.csv), checked here against what burnet-parcel-standards.json (built from pack E by
 * scripts/build-burnet-parcel-standards.mjs) and the resolver serve. On origin/main none of this
 * exists: burnet-parcel-setbacks.ts, burnet-parcel-facts.ts, the standards file and the vendored
 * NHD lakes are all new, and every one of these districts refuses by code.
 */
import { describe, expect, it } from "vitest";
import {
  resolveBurnetParcelSetbacks,
  describeParcelSetbacks,
  MARBLE_FALLS_PARCEL_DISTRICTS,
  PLAT_NOTE,
  SETBACK_CONDITIONAL_SET,
  SETBACK_PARCEL_SERVED,
  SETBACK_SOURCE_PENDING,
  SETBACK_ZONE_COMBINATION_UNTABLED,
  SETBACK_ZONE_UNMAPPED,
  SETBACK_ZONE_UNRESOLVED,
  type ParcelSetbackResolution,
  type StandardSet,
} from "../local/setbacks/burnet-parcel-setbacks.js";
import {
  LOT_WIDTH_MARGIN_FT,
  WATER_NOT_ADJACENT_MIN_M,
  measureLotWidth,
  measureWaterAdjacency,
  measureWaterAdjacencyAgainst,
  ptadCategory,
  widthBandIntersects,
  type PolygonGeometry,
} from "../local/setbacks/burnet-parcel-facts.js";
import {
  SETBACK_EDITION_UNVERIFIED,
  SETBACK_NO_DIMENSIONAL_STANDARDS,
  SETBACK_REFUSAL_CODES,
  checkSetbackEditionCurrency,
  getSetbackTableForZoning,
  isSetbackRefusalError,
} from "../local/setbacks/index.js";
import standards from "../local/setbacks/burnet-parcel-standards.json" with { type: "json" };
import lakeMf from "../local/setbacks/water/nhd-lake-marble-falls.json" with { type: "json" };
import lakeLbj from "../local/setbacks/water/nhd-lake-lbj.json" with { type: "json" };

/* ------------------------------------- geometry helpers ------------------------------------- */

const M_PER_DEG_LAT = 110_850; // ~30.5 N; only used to BUILD fixtures, the code under test projects itself
const mPerDegLon = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** A w x d ft rectangle with its SW corner at (lon, lat), optionally rotated (degrees) about that corner. */
function rect(lon: number, lat: number, wFt: number, dFt: number, rotDeg = 0): PolygonGeometry {
  const w = wFt * 0.3048;
  const d = dFt * 0.3048;
  const t = (rotDeg * Math.PI) / 180;
  const pts: [number, number][] = [
    [0, 0],
    [w, 0],
    [w, d],
    [0, d],
    [0, 0],
  ].map(([x, y]) => {
    const xr = x * Math.cos(t) - y * Math.sin(t);
    const yr = x * Math.sin(t) + y * Math.cos(t);
    return [lon + xr / mPerDegLon(lat), lat + yr / M_PER_DEG_LAT];
  });
  return { type: "Polygon", coordinates: [pts] };
}

/** A small square (half-size in metres) centred on a lon/lat. */
function squareAt(lon: number, lat: number, halfM = 3): PolygonGeometry {
  const dx = halfM / mPerDegLon(lat);
  const dy = halfM / M_PER_DEG_LAT;
  return {
    type: "Polygon",
    coordinates: [[[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]],
  };
}

/** Far from both lakes (open land east of Marble Falls). */
const FAR = rect(-98.2, 30.6, 60, 120);
/** A parcel straddling a vertex of each vendored lake polygon (so it intersects the lake). */
const ON_LAKE_MF = squareAt(...((lakeMf as { geometry: PolygonGeometry }).geometry.coordinates[0][0] as [number, number]));
const ON_LAKE_LBJ = squareAt(...((lakeLbj as { geometry: PolygonGeometry }).geometry.coordinates[0][0] as [number, number]));

/* ----------------------------------------- helpers ----------------------------------------- */

const mf = (zoningDistrict: string, extra: Partial<Parameters<typeof resolveBurnetParcelSetbacks>[0]> = {}) =>
  resolveBurnetParcelSetbacks({ jurisdictionKey: "marble-falls-tx", zoningDistrict, geometry: FAR, ...extra });
const hsb = (zoningDistrict: string, zoningSubarea: string | null, extra: Partial<Parameters<typeof resolveBurnetParcelSetbacks>[0]> = {}) =>
  resolveBurnetParcelSetbacks({ jurisdictionKey: "horseshoe-bay-tx", zoningDistrict, zoningSubarea, geometry: FAR, ...extra });

/** front/side/rear/street-side as numbers (null for a rule cell). */
const four = (s: StandardSet) => [s.front.value, s.side.value, s.rear.value, s.streetSide.value];

function served(r: ParcelSetbackResolution): StandardSet {
  expect(r.outcome, JSON.stringify(r, null, 1).slice(0, 600)).toBe("served");
  if (r.outcome !== "served") throw new Error("not served");
  expect(r.code).toBe(SETBACK_PARCEL_SERVED);
  return r.standards;
}
function conditional(r: ParcelSetbackResolution) {
  expect(r.outcome, JSON.stringify(r, null, 1).slice(0, 600)).toBe("conditional");
  if (r.outcome !== "conditional") throw new Error("not conditional");
  expect(r.code).toBe(SETBACK_CONDITIONAL_SET);
  return r;
}
function declinedCode(r: ParcelSetbackResolution): string {
  expect(r.outcome).toBe("declined");
  return r.code;
}

/* ===================================== parcel facts ===================================== */

describe("burnet-parcel-facts: water adjacency bands", () => {
  // A synthetic 1 km square "lake" so each band is constructed exactly.
  const LAKE: PolygonGeometry = { type: "Polygon", coordinates: [[[-98, 30], [-97.99, 30], [-97.99, 30.009], [-98, 30.009], [-98, 30]]] };
  const eastEdge = -97.99;
  const west = (m: number) => eastEdge + m / mPerDegLon(30.0045);

  it("a parcel that crosses the lake edge is adjacent (distance 0)", () => {
    const w = measureWaterAdjacencyAgainst(rect(west(-5), 30.004, 40, 40), LAKE, "synthetic", "Test Lake");
    expect(w.state).toBe("adjacent");
    expect(w.distanceM).toBe(0);
  });

  it("a parcel 20 m off the shoreline is undetermined (inside the 0-60 m band)", () => {
    const w = measureWaterAdjacencyAgainst(rect(west(20), 30.004, 40, 40), LAKE, "synthetic", "Test Lake");
    expect(w.state).toBe("undetermined");
    expect(w.distanceM!).toBeGreaterThan(19);
    expect(w.distanceM!).toBeLessThan(21);
  });

  it(`a parcel ${WATER_NOT_ADJACENT_MIN_M + 5} m off the shoreline is not adjacent`, () => {
    const w = measureWaterAdjacencyAgainst(rect(west(WATER_NOT_ADJACENT_MIN_M + 5), 30.004, 40, 40), LAKE, "synthetic", "Test Lake");
    expect(w.state).toBe("not-adjacent");
  });

  it("a parcel wholly inside the mapped water is adjacent, and missing geometry is undetermined (never not-adjacent)", () => {
    expect(measureWaterAdjacencyAgainst(squareAt(-97.995, 30.0045), LAKE, "synthetic", "Test Lake").state).toBe("adjacent");
    expect(measureWaterAdjacencyAgainst(null, LAKE, "synthetic", "Test Lake").state).toBe("undetermined");
    expect(measureWaterAdjacencyAgainst({ type: "Point", coordinates: [0, 0] }, LAKE, "synthetic", "Test Lake").state).toBe("undetermined");
  });

  it("the vendored lakes are the named NHD High Resolution waterbodies, and measure as expected", () => {
    expect(lakeMf).toMatchObject({ name: "Lake Marble Falls", nhd: { permanent_identifier: "120026930", gnis_id: "01360852", resolution: 2 } });
    expect(lakeLbj).toMatchObject({ name: "Lake Lyndon B Johnson", nhd: { permanent_identifier: "69729583", gnis_id: "01374767", resolution: 2 } });
    expect(measureWaterAdjacency(ON_LAKE_MF, "lake-marble-falls").state).toBe("adjacent");
    expect(measureWaterAdjacency(ON_LAKE_LBJ, "lake-lbj").state).toBe("adjacent");
    expect(measureWaterAdjacency(FAR, "lake-marble-falls").state).toBe("not-adjacent");
    expect(measureWaterAdjacency(FAR, "lake-lbj").state).toBe("not-adjacent");
  });
});

describe("burnet-parcel-facts: lot width (Table 4.2.6.A)", () => {
  it("a 50 x 140 ft lot is bounded to [short - margin, long + margin] whichever way it is rotated", () => {
    for (const rot of [0, 33, 90]) {
      const w = measureLotWidth(rect(-98.27, 30.57, 50, 140, rot));
      expect(w.intervalFt![0]).toBeCloseTo(50 - LOT_WIDTH_MARGIN_FT, 0);
      expect(w.intervalFt![1]).toBeCloseTo(140 + LOT_WIDTH_MARGIN_FT, 0);
      expect(w.rectangularity!).toBeGreaterThan(0.99);
    }
  });

  it("an L-shaped (irregular) lot and a multi-part lot are not bounded", () => {
    const lat = 30.57, lon = -98.27, f = (ft: number) => (ft * 0.3048) / M_PER_DEG_LAT, g = (ft: number) => (ft * 0.3048) / mPerDegLon(lat);
    const L: PolygonGeometry = { type: "Polygon", coordinates: [[[lon, lat], [lon + g(100), lat], [lon + g(100), lat + f(30)], [lon + g(30), lat + f(30)], [lon + g(30), lat + f(100)], [lon, lat + f(100)], [lon, lat]]] };
    expect(measureLotWidth(L).intervalFt).toBeNull();
    const a = rect(lon, lat, 50, 50).coordinates;
    const b = rect(lon + 0.01, lat, 50, 50).coordinates;
    expect(measureLotWidth({ type: "MultiPolygon", coordinates: [a, b] }).intervalFt).toBeNull();
  });

  it("band intersection: [30,40) / [40,50) / [50,inf) against a measured interval", () => {
    expect(widthBandIntersects([50, null], [54, 141])).toBe(true);
    expect(widthBandIntersects([40, 50], [54, 141])).toBe(false);
    expect(widthBandIntersects([40, 50], [48.6, 141])).toBe(true);
    expect(widthBandIntersects([30, 40], [48.6, 141])).toBe(false);
    expect(widthBandIntersects([100, null], [48.6, 61])).toBe(false);
  });

  it("CAD category is the PTAD state category letter only", () => {
    expect(ptadCategory("F1")).toBe("F");
    expect(ptadCategory("fa")).toBe("F");
    expect(ptadCategory("A1")).toBe("A");
    expect(ptadCategory("B2")).toBe("B");
    expect(ptadCategory("M1")).toBe("M");
    expect(ptadCategory("C1")).toBe("other");
    expect(ptadCategory("")).toBe("none");
    expect(ptadCategory(null)).toBe("none");
  });
});

/* ===================================== Marble Falls ===================================== */

describe("Marble Falls: every stamped district resolves per parcel (served, conditional set, or a named decline)", () => {
  const STAMPED = ["ENZ.1", "ENZ.2", "ENZ.3", "ENZ.4", "ENZ.5", "NR", "GC", "DR", "NC", "DN", "TR", "DT", "RE", "BP", "FR", "MR", "IN"];

  it("the 10 per-parcel districts are exactly the ones the register refuses by code", () => {
    expect([...MARBLE_FALLS_PARCEL_DISTRICTS].sort()).toEqual(["DN", "DR", "DT", "FR", "GC", "MR", "NC", "NR", "RE", "TR"]);
    for (const code of MARBLE_FALLS_PARCEL_DISTRICTS) {
      expect(checkSetbackEditionCurrency({ city: "Marble Falls", districtCode: code }).code).toBe("SETBACK_CONDITIONAL_NOT_EVALUATED");
    }
  });

  it("no stamped district ever declines for a parcel with geometry (all 17 serve or return a conditional set)", () => {
    for (const code of STAMPED) {
      for (const puc of [null, "A1", "B2", "F1", "C1"]) {
        const r = mf(code, { propertyUseCode: puc });
        expect(["served", "conditional"], `${code}/${puc}`).toContain(r.outcome);
      }
    }
  });

  it("the 7 table districts serve the district table's own row, unchanged (ENZ.2 = 25/5/10/15)", () => {
    expect(four(served(mf("ENZ.2")))).toEqual([25, 5, 10, 15]);
    expect(four(served(mf("BP")))).toEqual([35, 15, 30, 25]);
    expect(four(served(mf("IN")))).toEqual([35, 20, 40, 25]);
  });

  it("PD (not stamped, Div. 4.4 not in pack E) still declines by its register code", () => {
    expect(declinedCode(mf("PD"))).toBe(SETBACK_EDITION_UNVERIFIED);
  });

  describe("FR / RE / NR / TR / MR: one row per building type (Table 4.2.2), plus the Table 4.3.1.B nonresidential row", () => {
    it("FR with no CAD use code: all 7 rows as branches, every value a pack E cell", () => {
      const r = conditional(mf("FR"));
      expect(r.branches.map((b) => four(b.standards))).toEqual([
        [90, 50, 150, 75],
        [90, 45, 125, 55],
        [75, 35, 90, 35],
        [75, 35, 90, 35],
        [15, 5, 15, 10],
        [15, 5, 15, 10],
        [55, 35, 60, 35],
      ]);
      expect(r.branches[0].condition).toBe("developed as: Farm and Ranch (Single-Family Detached)");
    });

    it("RE with a residential CAD category: the two single-family rows only (Estate 50/25/75/35, Estate Cluster 45/20/50/30)", () => {
      const r = conditional(mf("RE", { propertyUseCode: "A1" }));
      expect(r.branches.map((b) => four(b.standards))).toEqual([
        [50, 25, 75, 35],
        [45, 20, 50, 30],
      ]);
    });

    it.each([
      ["FR", [55, 35, 60, 35], 35, 25],
      ["RE", [55, 35, 60, 35], 35, 25],
      ["NR", [30, 15, 20, 25], 35, 70],
      ["TR", [30, 15, 20, 25], 35, 70],
      ["MR", [30, 15, 20, 25], 35, 70],
      ["DR", [30, 15, 20, 25], 35, 70],
    ])("%s with a CAD category F (commercial/industrial) improvement serves the Table 4.3.1.B nonresidential row", (code, setbacks, h, cov) => {
      const s = served(mf(code as string, { propertyUseCode: "F1" }));
      expect(four(s)).toEqual(setbacks);
      expect(s.maxHeightFt.value).toBe(h);
      expect(s.maxLotCoveragePct.value).toBe(cov);
      expect(s.citation).toContain("Table 4.3.1.B");
    });

    it("NR with a residential category: 8 building-type rows (3 single-family-detached rows differ), ZLL side kept as its printed text", () => {
      const r = conditional(mf("NR", { propertyUseCode: "A1" }));
      expect(r.branches).toHaveLength(8);
      expect(four(r.branches[0].standards)).toEqual([30, 10, 20, 20]); // Suburban
      expect(four(r.branches[1].standards)).toEqual([25, 5, 15, 10]); // Neighborhood
      expect(four(r.branches[2].standards)).toEqual([15, 5, 15, 10]); // Neighborhood (Rear-Loaded)
      const zll = r.branches.find((b) => b.standards.label === "Single-Family Zero Lot Line")!;
      expect(zll.standards.side).toEqual({ value: null, text: "0'/10'" });
    });

    it("TR with a multifamily category: 12 residential rows; MR with none: 10 rows (no SFD row at all)", () => {
      expect(conditional(mf("TR", { propertyUseCode: "B2" })).branches).toHaveLength(12);
      const r = conditional(mf("MR"));
      expect(r.branches).toHaveLength(10);
      expect(r.branches.some((b) => /Single-Family Detached/i.test(b.standards.label))).toBe(false);
    });
  });

  describe("DR: Table 4.2.6.A rows keyed by building type and Min. Lot Width", () => {
    it("a 60 x 140 ft lot keeps only rows whose width band can hold 59-141 ft (no 30'/40' tier rows)", () => {
      const r = conditional(mf("DR", { geometry: rect(-98.27, 30.57, 60, 140), propertyUseCode: "A1" }));
      const labels = r.branches.map((b) => b.standards.label);
      expect(labels).toContain("Single-Family Detached | Min. Lot Width 50'");
      // The tiered building types (Cottage / SFD / ZLL / SFA) lose their 30' and 40' rows; a one-row
      // type with a 40' minimum (Tiny House) is a [40, inf) band and stays.
      expect(labels.some((l) => /^(Cottage|Single-Family (Detached|Zero Lot Line|Attached)) \| Min\. Lot Width (30|40)'$/.test(l))).toBe(false);
      expect(labels).toContain("Tiny House Development | Min. Lot Width 40'");
      const sfd = r.branches.find((b) => b.standards.label === "Single-Family Detached | Min. Lot Width 50'")!;
      expect(four(sfd.standards)).toEqual([15, 5, 15, 10]);
      expect(r.facts.find((f) => f.fact === "lot-width")!.state).toMatch(/^\[59(\.\d)?, 14[01](\.\d)?\] ft$/);
    });

    it("a 45 x 120 ft lot: the SFD 40' row (street side 7.5) and the 50' row (10) both remain; the 30' row is excluded", () => {
      const r = conditional(mf("DR", { geometry: rect(-98.27, 30.57, 45, 120), propertyUseCode: "A1" }));
      const sfd = r.branches.filter((b) => b.standards.label.startsWith("Single-Family Detached"));
      expect(sfd.map((b) => [b.standards.label, b.standards.streetSide.value])).toEqual([
        ["Single-Family Detached | Min. Lot Width 40'", 7.5],
        ["Single-Family Detached | Min. Lot Width 50'", 10],
      ]);
    });

    it("an irregular lot keeps every tier (lot width undetermined)", () => {
      const lat = 30.57, lon = -98.27, f = (ft: number) => (ft * 0.3048) / M_PER_DEG_LAT, g = (ft: number) => (ft * 0.3048) / mPerDegLon(lat);
      const L: PolygonGeometry = { type: "Polygon", coordinates: [[[lon, lat], [lon + g(100), lat], [lon + g(100), lat + f(30)], [lon + g(30), lat + f(30)], [lon + g(30), lat + f(100)], [lon, lat + f(100)], [lon, lat]]] };
      const r = conditional(mf("DR", { geometry: L, propertyUseCode: "A1" }));
      expect(r.branches).toHaveLength(18);
      expect(r.facts.find((f) => f.fact === "lot-width")!.state).toBe("undetermined");
    });
  });

  describe("NC / GC / DN / DT: Table 4.3.1.B note 1 (adjacent to Lake Marble Falls)", () => {
    it.each([
      ["NC", [25, 5, 15, 25], 35, 70],
      ["GC", [25, 5, 15, 25], 45, 75],
    ])("%s not adjacent to the lake serves the first number of each 5'/10' and 15'/10' cell", (code, setbacks, h, cov) => {
      const s = served(mf(code as string));
      expect(four(s)).toEqual(setbacks);
      expect(s.maxHeightFt.value).toBe(h);
      expect(s.maxLotCoveragePct.value).toBe(cov);
    });

    it("NC adjacent to the lake: one branch whose side and rear are the note 1 rule, never a single number", () => {
      const r = conditional(mf("NC", { geometry: ON_LAKE_MF }));
      expect(r.branches).toHaveLength(1);
      expect(r.branches[0].condition).toBe("adjacent to Lake Marble Falls");
      expect(r.branches[0].standards.side.value).toBeNull();
      expect(r.branches[0].standards.side.text).toContain("10 feet (or the edge of the boardwalk)");
      expect(r.branches[0].standards.rear.text).toContain("otherwise: 15'");
      expect(r.branches[0].standards.notes.join(" ")).toContain("All properties in the NC, GC, DN, and DT districts adjacent to Lake Marble Falls");
    });

    it("GC whose lake adjacency is undetermined returns both branches", () => {
      // 20 m east of a Lake Marble Falls vertex, outside the lake: inside the 0-60 m band.
      const v = (lakeMf as { geometry: PolygonGeometry }).geometry.coordinates[0];
      const lon = Math.max(...v.map((p) => p[0])) + 20 / mPerDegLon(30.56);
      const lat = v.find((p) => p[0] === Math.max(...v.map((q) => q[0])))![1];
      const r = conditional(mf("GC", { geometry: squareAt(lon, lat, 2) }));
      expect(r.branches.map((b) => b.condition)).toEqual(["if the parcel is not adjacent to Lake Marble Falls", "if the parcel is adjacent to Lake Marble Falls"]);
      expect(four(r.branches[0].standards)).toEqual([25, 5, 15, 25]);
    });

    it("DN with a commercial improvement, not on the lake: 0/0/0/0 with the build-to text carried; DT: 0/0/10/10", () => {
      const dn = served(mf("DN", { propertyUseCode: "F1" }));
      expect(four(dn)).toEqual([0, 0, 0, 0]);
      expect(dn.front.text).toContain("required to be built to front and side property lines abutting a street");
      const dt = served(mf("DT", { propertyUseCode: "F1" }));
      expect(four(dt)).toEqual([0, 0, 10, 10]);
      expect(dt.front.text).toContain("built within 10 feet of the front property line");
    });

    it("DN / DT with no CAD category: the mixed-use row and the townhouse row (a residential category does NOT narrow to the townhouse row)", () => {
      for (const puc of [null, "A1"]) {
        const dn = conditional(mf("DN", { propertyUseCode: puc }));
        expect(dn.branches.map((b) => b.standards.label)).toEqual(["Nonresidential and Mixed-Use Development (Table 4.3.1.B row)", "Townhouse (Rear-Loaded)"]);
        const th = dn.branches[1].standards;
        expect(th.front).toMatchObject({ value: 0 });
        expect(th.side).toEqual({ value: null, text: "5'/0'" });
        const dt = conditional(mf("DT", { propertyUseCode: puc }));
        expect(dt.branches[1].standards.front.value).toBeNull(); // DT townhouse: build-to within 10 ft, not a setback
      }
    });
  });

  it("every numeric cell in the standards file prints its own number in its text (quote-complete)", () => {
    const d = (standards as unknown as { marble_falls: { districts: Record<string, { rows: Array<{ fields: Record<string, { value: number | null; text: string }> }> }> } }).marble_falls.districts;
    for (const [code, { rows }] of Object.entries(d)) {
      for (const row of rows) {
        for (const [field, cell] of Object.entries(row.fields)) {
          if (cell.value !== null) expect(cell.text, `${code} ${field}`).toContain(String(cell.value));
        }
      }
    }
  });
});

/* ===================================== Horseshoe Bay ===================================== */

describe("Horseshoe Bay: zone from the layer's SUBDIVISION, then (district, zone) standards", () => {
  describe("zone resolution declines", () => {
    it("no sub-area stamped yet -> SETBACK_ZONE_UNRESOLVED (never a zone guess)", () => {
      for (const code of ["R-1", "GH", "R-4", "R-2", "R-6", "A-1", "C-2", "GUI"]) {
        expect(declinedCode(hsb(code, null))).toBe(SETBACK_ZONE_UNRESOLVED);
        expect(declinedCode(hsb(code, "  "))).toBe(SETBACK_ZONE_UNRESOLVED);
      }
    });

    it("WEST is deliberately unmapped, and an unknown value is unmapped -> SETBACK_ZONE_UNMAPPED", () => {
      expect(declinedCode(hsb("R-1", "WEST"))).toBe(SETBACK_ZONE_UNMAPPED);
      expect(declinedCode(hsb("A-1", "WEST"))).toBe(SETBACK_ZONE_UNMAPPED);
      expect(declinedCode(hsb("R-1", "NOT A ZONE"))).toBe(SETBACK_ZONE_UNMAPPED);
    });

    it("a mapped zone with no reviewed (district, zone) entry -> SETBACK_ZONE_COMBINATION_UNTABLED", () => {
      const r = hsb("R-1", "ESCONDIDO");
      expect(declinedCode(r)).toBe(SETBACK_ZONE_COMBINATION_UNTABLED);
      expect(r.zone).toBe("9");
    });

    it("pending text (pack F): SOUTH R-1, SOUTH A-1 and MH-1 -> SETBACK_SOURCE_PENDING; MH-1 even with no zone", () => {
      expect(declinedCode(hsb("R-1", "SOUTH"))).toBe(SETBACK_SOURCE_PENDING);
      expect(declinedCode(hsb("A-1", "SOUTH"))).toBe(SETBACK_SOURCE_PENDING);
      expect(declinedCode(hsb("MH-1", "SOUTH"))).toBe(SETBACK_SOURCE_PENDING);
      expect(declinedCode(hsb("MH-1", null))).toBe(SETBACK_SOURCE_PENDING);
    });

    it("codes the register says carry no dimensional standards decline with that code whatever the zone", () => {
      expect(declinedCode(hsb("LA", "PROPER"))).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
      expect(declinedCode(hsb("PD", "PROPER"))).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
    });
  });

  describe("PENINSULA -> Zone 7 R-1 (§ 14.02.409)", () => {
    it("not on Lake LBJ: served 15/15/15/15, height 45, coverage 60, with the plat note", () => {
      const r = hsb("R-1", "PENINSULA");
      const s = served(r);
      expect(four(s)).toEqual([15, 15, 15, 15]);
      expect(s.maxHeightFt.value).toBe(45);
      expect(s.maxLotCoveragePct.value).toBe(60);
      expect(s.side.text).toContain("reviewed: ");
      expect(r.platNote).toContain(PLAT_NOTE);
      expect(r.zone).toBe("7");
    });

    it("a waterfront lot: rear 0 ft (§ 14.02.402(b)(15)(U)), still with the plat note", () => {
      const r = hsb("R-1", "PENINSULA", { geometry: ON_LAKE_LBJ });
      const s = served(r);
      expect(four(s)).toEqual([15, 15, 0, 15]);
      expect(s.rear.text).toContain("Rear setbacks for waterfront lots are zero (0) feet");
      expect(r.platNote).toContain(PLAT_NOTE);
    });
  });

  describe("PROPER -> Zones 3/4A (§ 14.02.406; mapping inferred, only codes whose 3 and 4A text is one entry)", () => {
    it("R-1 off Lighthouse Drive: conditional -- the side yard is a total (15 ft, 5 ft on one side), not a per-side number", () => {
      const r = conditional(hsb("R-1", "PROPER", { situsAddress: "1 BAY WEST BLVD" }));
      expect(r.branches).toHaveLength(1);
      expect(four(r.branches[0].standards)).toEqual([25, null, 15, 25]);
      expect(r.branches[0].standards.side.text).toContain("total side yards of not less than fifteen (15) feet");
      expect(r.platNote).toContain(PLAT_NOTE);
    });

    it("R-1 on Lighthouse Drive: served 25/5/15/25, height 32 (35 when waterfront, rear 0)", () => {
      const s = served(hsb("R-1", "PROPER", { situsAddress: "205 LIGHTHOUSE DR" }));
      expect(four(s)).toEqual([25, 5, 15, 25]);
      expect(s.maxHeightFt.value).toBe(32);
      const w = served(hsb("R-1", "PROPER", { situsAddress: "205 LIGHTHOUSE DR", geometry: ON_LAKE_LBJ }));
      expect(four(w)).toEqual([25, 5, 0, 25]);
      expect(w.maxHeightFt.value).toBe(35);
    });

    it.each([
      ["GH", [20, 5, 15, 15], 32, false],
      ["R-2", [25, 5, 15, 25], 32, true],
      ["R-4", [25, 5, 15, 25], 32, true],
      ["R-6", [20, 5, 15, 25], 32, true],
    ])("%s not on the lake: served %j, height %d; plat note %s", (code, setbacks, h, plat) => {
      const r = hsb(code as string, "PROPER");
      const s = served(r);
      expect(four(s)).toEqual(setbacks);
      expect(s.maxHeightFt.value).toBe(h);
      expect(Boolean(r.platNote)).toBe(plat);
    });

    it("R-4 with lake adjacency undetermined returns both branches (rear 15 / rear 0)", () => {
      const v = (lakeLbj as { geometry: PolygonGeometry }).geometry.coordinates[0];
      const maxLon = Math.max(...v.map((p) => p[0]));
      const lat = v.find((p) => p[0] === maxLon)![1];
      const r = conditional(hsb("R-4", "PROPER", { geometry: squareAt(maxLon + 25 / mPerDegLon(lat), lat, 2) }));
      expect(r.branches.map((b) => b.standards.rear.value)).toEqual([15, 0]);
    });

    it("C-2: the four alternatives § 14.02.406 / § 14.02.417 give (no setbacks stated; three PD-authorized tracts)", () => {
      const r = conditional(hsb("C-2", "PROPER"));
      expect(r.branches).toHaveLength(4);
      expect(four(r.branches[0].standards)).toEqual([null, null, null, null]);
      expect(r.branches[2].standards.front.value).toBe(20);
    });

    it("A-1 and GUI: conditional (side/rear change where the lot adjoins a residential classification)", () => {
      const a1 = conditional(hsb("A-1", "PROPER"));
      expect(a1.branches[0].standards.side.text).toContain("40' for any side(s) that adjoins residential");
      const gui = conditional(hsb("GUI", "PROPER"));
      expect(four(gui.branches[0].standards)).toEqual([25, null, null, 25]);
    });
  });

  it("SUMMIT ROCK -> Zone 12 A-1 (§ 14.02.414): conditional on the abutting-residential side rule", () => {
    const r = conditional(hsb("A-1", "SUMMIT ROCK"));
    expect(r.zone).toBe("12");
    expect(four(r.branches[0].standards)).toEqual([25, null, 25, 25]);
  });

  it("every (ZONING, SUBDIVISION) pair on a Burnet feature has an outcome (read off the layer 2026-10-13)", () => {
    const pairs: Array<[string, string]> = [
      ["R-1", "PENINSULA"], ["R-1", "PROPER"], ["GH", "PROPER"], ["R-2", "PROPER"], ["R-4", "PROPER"], ["R-6", "PROPER"],
      ["C-2", "PROPER"], ["A-1", "PROPER"], ["GUI", "PROPER"], ["A-1", "SOUTH"], ["MH-1", "SOUTH"], ["R-1", "SOUTH"],
      ["A-1", "SUMMIT ROCK"], ["A-1", "WEST"], ["R-1", "WEST"],
    ];
    for (const [code, sub] of pairs) {
      const r = hsb(code, sub);
      expect(r.outcome === "declined" ? [SETBACK_SOURCE_PENDING, SETBACK_ZONE_UNMAPPED] : [SETBACK_PARCEL_SERVED, SETBACK_CONDITIONAL_SET]).toContain(r.code);
    }
  });
});

describe("the district-code path is unchanged in kind: these districts still refuse by code", () => {
  it("getSetbackTableForZoning refuses a conditional MF code and an HSB code; MH-1 now refuses SETBACK_SOURCE_PENDING", () => {
    const code = (j: string, c: string) => {
      try {
        getSetbackTableForZoning(j, c);
        return null;
      } catch (err) {
        if (!isSetbackRefusalError(err)) throw err;
        return err.code;
      }
    };
    expect(code("marble-falls-tx", "NR")).toBe("SETBACK_CONDITIONAL_NOT_EVALUATED");
    expect(code("horseshoe-bay-tx", "R-1")).toBe("SETBACK_CONDITIONAL_NOT_EVALUATED");
    expect(code("horseshoe-bay-tx", "MH-1")).toBe(SETBACK_SOURCE_PENDING);
    expect(SETBACK_REFUSAL_CODES).toContain(SETBACK_SOURCE_PENDING);
  });
});

describe("describeParcelSetbacks (text for a caller that cannot render branches)", () => {
  it("prints one line per branch, the rule text where there is no number, and the plat note", () => {
    const lines = describeParcelSetbacks(hsb("R-1", "PROPER"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('side "');
    expect(lines[0]).toContain(PLAT_NOTE);
    expect(describeParcelSetbacks(hsb("R-1", "SOUTH"))[0]).toMatch(/^declined SETBACK_SOURCE_PENDING/);
  });
});
