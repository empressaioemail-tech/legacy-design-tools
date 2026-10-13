/**
 * City containment by AREA SHARE (area-share-3083-v1): the rule, the
 * EPSG:3083 measurement, the containment resolvers that use it, the served
 * DTO and the record parser.
 */

import { describe, expect, it } from "vitest";
import {
  AREA_SHARE_METHOD,
  cityAreaShareSql,
  decideByAreaShare,
  formatShare,
  geometryAreaM2,
  groupCityAreaShareRows,
  isSliverPiece,
  measureJurisdictionPieces,
  projectEpsg3083,
} from "../boundary/areaShare";
import {
  buildCityBoundaryIndex,
  buildCountyBoundaryIndex,
  representativePoint,
  resolveCityContainment,
  resolveCountyContainment,
} from "../boundary/containment";
import {
  cityLimitsFactFromContainment,
  parseCityLimitsAreaShare,
} from "../boundary/cityLimitsFact";
import { pointInGeometry, type GeoJsonGeometry } from "../txgio/geo";

const UNINC = "unincorporated";

function rect(w: number, s: number, e: number, n: number): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

describe("decideByAreaShare — the rule", () => {
  it("a city holding the majority wins; a 54% city is the city, with the split disclosed", () => {
    const d = decideByAreaShare(1000, [{ id: "4834862", name: "Horseshoe Bay", areaM2: 540 }], UNINC)!;
    expect(d.method).toBe(AREA_SHARE_METHOD);
    expect(d.rule).toBe("majority");
    expect(d.winner.kind).toBe("jurisdiction");
    expect(d.winner.kind === "jurisdiction" && d.winner.name).toBe("Horseshoe Bay");
    expect(d.split).toBe(true);
    expect(d.disclosure).toBe("54% in Horseshoe Bay, 46% unincorporated");
  });

  it("the unincorporated remainder competes as a piece: 12% in a city is unincorporated, split disclosed", () => {
    const d = decideByAreaShare(4600, [{ id: "4807876", name: "Bertram", areaM2: 552 }], UNINC)!;
    expect(d.winner.kind).toBe("remainder");
    expect(d.rule).toBe("majority");
    expect(d.split).toBe(true);
    expect(d.disclosure).toBe("88% unincorporated, 12% in Bertram");
  });

  it("no majority: the largest piece wins (plurality), never a default to unincorporated", () => {
    const d = decideByAreaShare(
      1000,
      [
        { id: "A", name: "City A", areaM2: 450 },
        { id: "B", name: "City B", areaM2: 400 },
      ],
      UNINC,
    )!;
    expect(d.rule).toBe("plurality");
    expect(d.winner.kind === "jurisdiction" && d.winner.name).toBe("City A");
    expect(d.split).toBe(true);
    expect(d.disclosure).toBe("45% in City A, 40% in City B, 15% unincorporated");
  });

  it("a remainder that is a sliver (< 1% AND < 50 m²) is not a split", () => {
    const d = decideByAreaShare(2000, [{ id: "X", name: "City X", areaM2: 1990 }], UNINC)!;
    expect(d.winner.share).toBeCloseTo(0.995, 6);
    expect(d.pieces[1]!.sliver).toBe(true);
    expect(d.split).toBe(false);
    expect(d.disclosure).toBeNull();
  });

  it("a winner at or above 99% is never a split, even when the minority piece is large in m²", () => {
    // 0.5% of a 100,000 m² parcel is 500 m²: not a sliver, but the winner holds 99.5%.
    const d = decideByAreaShare(100000, [{ id: "X", name: "City X", areaM2: 99500 }], UNINC)!;
    expect(d.pieces[1]!.sliver).toBe(false);
    expect(d.split).toBe(false);
  });

  it("a 98% winner with a non-sliver 2% piece is a split", () => {
    const d = decideByAreaShare(10000, [{ id: "X", name: "City X", areaM2: 9800 }], UNINC)!;
    expect(d.split).toBe(true);
    expect(d.disclosure).toBe("98% in City X, 2% unincorporated");
  });

  it("a split lists only non-sliver pieces", () => {
    const d = decideByAreaShare(
      1000,
      [
        { id: "X", name: "City X", areaM2: 900 },
        { id: "Y", name: "City Y", areaM2: 5 },
      ],
      UNINC,
    )!;
    expect(d.split).toBe(true);
    expect(d.disclosure).toBe("90% in City X, 10% unincorporated");
    expect(d.pieces.find((p) => p.kind === "jurisdiction" && p.id === "Y")!.sliver).toBe(true);
  });

  it("the sliver rule needs BOTH conditions (flood ruling D1)", () => {
    expect(isSliverPiece(0.005, 49)).toBe(true);
    expect(isSliverPiece(0.005, 50)).toBe(false);
    expect(isSliverPiece(0.01, 10)).toBe(false);
  });

  it("a city that fully covers the parcel is 100% with no remainder piece (float noise dropped)", () => {
    const d = decideByAreaShare(1234.5, [{ id: "X", name: "City X", areaM2: 1234.5 - 1e-9 }], UNINC)!;
    expect(d.pieces).toHaveLength(1);
    expect(d.split).toBe(false);
  });

  it("sums repeated ids (subdivided pieces) and drops touches", () => {
    const d = decideByAreaShare(
      1000,
      [
        { id: "X", name: "City X", areaM2: 300 },
        { id: "X", name: "City X", areaM2: 300 },
        { id: "Y", name: "City Y", areaM2: 0 },
      ],
      UNINC,
    )!;
    expect(d.pieces).toHaveLength(2);
    expect(d.winner.share).toBeCloseTo(0.6, 9);
  });

  it("no measurable parcel area is no decision (the caller's unmeasured)", () => {
    expect(decideByAreaShare(0, [], UNINC)).toBeNull();
    expect(decideByAreaShare(Number.NaN, [], UNINC)).toBeNull();
  });

  it("a parcel no city touches is 100% unincorporated, not split", () => {
    const d = decideByAreaShare(500, [], UNINC)!;
    expect(d.winner.kind).toBe("remainder");
    expect(d.winner.share).toBe(1);
    expect(d.split).toBe(false);
  });

  it("formats shares without rounding a real piece to 0% or a partial winner to 100%", () => {
    expect(formatShare(0.004)).toBe("<1%");
    expect(formatShare(0.9971)).toBe(">99%");
    expect(formatShare(0.93)).toBe("93%");
    expect(formatShare(1)).toBe("100%");
  });
});

describe("EPSG:3083 measurement", () => {
  // Reference values from PostGIS on the production store (read-only, 2026-10-13):
  // ST_Transform(ST_SetSRID(ST_Point(lng, lat), 4326), 3083) and
  // ST_Area(ST_Transform(<polygon>, 3083)).
  it("projects like PostGIS ST_Transform(…, 3083) to well under a millimetre", () => {
    const cases: Array<[number, number, number, number]> = [
      [-98.0, 30.5, 1691597.9420197145, 7377250.058698973],
      [-106.4, 31.8, 895542.3276047418, 7537437.871915937],
      [-94.0, 26.5, 2098582.752846216, 6948093.703861444],
    ];
    for (const [lng, lat, x, y] of cases) {
      const [px, py] = projectEpsg3083(lng, lat);
      expect(Math.abs(px - x)).toBeLessThan(1e-3);
      expect(Math.abs(py - y)).toBeLessThan(1e-3);
    }
  });

  it("measures area like PostGIS ST_Area(ST_Transform(…, 3083)), holes subtracted", () => {
    expect(geometryAreaM2(rect(-97.72, 30.26, -97.719, 30.261))).toBeCloseTo(10668.1181818709, 3);
    const holed: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [-98.27, 30.55],
          [-98.2, 30.55],
          [-98.2, 30.6],
          [-98.27, 30.6],
          [-98.27, 30.55],
        ],
        [
          [-98.25, 30.56],
          [-98.22, 30.56],
          [-98.22, 30.58],
          [-98.25, 30.58],
          [-98.25, 30.56],
        ],
      ],
    };
    expect(Math.abs(geometryAreaM2(holed) - 30839657.005337562)).toBeLessThan(0.1);
  });

  it("measures a straddling parcel's pieces in process", () => {
    const parcel = rect(-98.0, 30.5, -97.999, 30.501);
    const city = rect(-97.9995, 30.49, -97.99, 30.51); // covers the east half
    const m = measureJurisdictionPieces(parcel, [
      { id: "C", name: "City C", geometry: city, bbox: { westLng: -97.9995, southLat: 30.49, eastLng: -97.99, northLat: 30.51 } },
    ])!;
    expect(m.pieces).toHaveLength(1);
    expect(m.pieces[0]!.areaM2 / m.parcelM2).toBeCloseTo(0.5, 3);
  });

  it("unions overlapping parcel parts before measuring (no double-counted area)", () => {
    const twice: GeoJsonGeometry = {
      type: "MultiPolygon",
      coordinates: [
        rect(-98.0, 30.5, -97.999, 30.501).coordinates,
        rect(-98.0, 30.5, -97.999, 30.501).coordinates,
      ],
    };
    const m = measureJurisdictionPieces(twice, [])!;
    expect(m.parcelM2).toBeCloseTo(geometryAreaM2(rect(-98.0, 30.5, -97.999, 30.501)), 3);
  });

  it("no polygonal parcel is no measurement", () => {
    expect(measureJurisdictionPieces({ type: "Point", coordinates: [-98, 30.5] }, [])).toBeNull();
  });
});

describe("resolveCityContainment(geometry) decides by area share", () => {
  // City polygon covering lng >= -98.0 within a box.
  const cityIndex = buildCityBoundaryIndex([
    { geoId: "4834862", cityName: "Horseshoe Bay", gnis: "2410797", geometry: rect(-98.0, 30.4, -97.9, 30.6) },
  ]);

  it("a parcel 54% inside the city is in the city, split disclosed in the basis and on the fact", () => {
    // Parcel spans lng -98.00046 .. -97.99946: 54% east of -98.0.
    const parcel = rect(-98.00046, 30.5, -97.99946, 30.501);
    const r = resolveCityContainment(parcel, cityIndex);
    expect(r.status).toBe("incorporated");
    if (r.status !== "incorporated") return;
    expect(r.cityName).toBe("Horseshoe Bay");
    expect(r.areaShare?.split).toBe(true);
    expect(r.areaShare?.disclosure).toBe("54% in Horseshoe Bay, 46% unincorporated");
    expect(r.basis).toMatch(/area share against tx_city_boundary in EPSG:3083/);
    expect(r.basis).toMatch(/split: 54% in Horseshoe Bay, 46% unincorporated/);
    const fact = cityLimitsFactFromContainment(r);
    expect(fact.areaShare?.disclosure).toBe("54% in Horseshoe Bay, 46% unincorporated");
    expect(fact.areaShare?.pieces.map((p) => p.cityName)).toEqual(["Horseshoe Bay", null]);
  });

  it("a parcel 15% inside the city is unincorporated whatever a point inside it would say", () => {
    // Centroid and first vertex both ignored: the decision is the area.
    const parcel = rect(-98.00085, 30.5, -97.99985, 30.501);
    const r = resolveCityContainment(parcel, cityIndex);
    expect(r.status).toBe("unincorporated");
    if (r.status !== "unincorporated") return;
    expect(r.areaShare?.disclosure).toBe("85% unincorporated, 15% in Horseshoe Bay");
  });

  it("a parcel wholly inside is incorporated and not split", () => {
    const r = resolveCityContainment(rect(-97.95, 30.5, -97.949, 30.501), cityIndex);
    expect(r.status).toBe("incorporated");
    if (r.status === "incorporated") expect(r.areaShare?.split).toBe(false);
  });

  it("an empty index is still unmeasured, never unincorporated", () => {
    expect(resolveCityContainment(rect(-97.95, 30.5, -97.949, 30.501), []).status).toBe("unmeasured");
  });

  it("a bare point is still a point-in-polygon answer with no areaShare", () => {
    const r = resolveCityContainment({ longitude: -97.95, latitude: 30.5 }, cityIndex);
    expect(r.status).toBe("incorporated");
    expect("areaShare" in r).toBe(false);
  });
});

describe("resolveCountyContainment(geometry) uses the same rule", () => {
  const countyIndex = buildCountyBoundaryIndex([
    { countyFips: "48053", countyName: "Burnet County", geometry: rect(-98.5, 30.4, -98.0, 31.0) },
    { countyFips: "48299", countyName: "Llano County", geometry: rect(-99.0, 30.4, -98.5, 31.0) },
  ]);
  it("the county holding the majority of the parcel's area wins", () => {
    // 70% west of -98.5 (Llano), 30% east (Burnet).
    const r = resolveCountyContainment(rect(-98.5007, 30.5, -98.4997, 30.501), countyIndex);
    expect(r.status).toBe("resolved");
    if (r.status === "resolved") {
      expect(r.countyFips).toBe("48299");
      expect(r.areaShare?.disclosure).toBe("70% in Llano County, 30% in Burnet County");
    }
  });
});

describe("representativePoint never returns a boundary vertex", () => {
  it("a parcel whose centroid is outside it gets a point proven inside it", () => {
    // A thin U: centroid falls in the notch, outside the parcel.
    const u: GeoJsonGeometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [3, 0],
          [3, 3],
          [2, 3],
          [2, 1],
          [1, 1],
          [1, 3],
          [0, 3],
          [0, 0],
        ],
      ],
    };
    const pt = representativePoint(u)!;
    expect(pt).not.toEqual([0, 0]);
    expect(pointInGeometry(pt[0], pt[1], u)).toBe(true);
  });
});

describe("parseCityLimitsAreaShare — the record's stored decision", () => {
  const stored = {
    method: AREA_SHARE_METHOD,
    pieces: [
      { cityName: "Horseshoe Bay", geoId: "4834862", share: 0.93, areaM2: 930 },
      { cityName: null, geoId: null, share: 0.07, areaM2: 70 },
    ],
  };

  it("re-derives rule, split, slivers and the sentence from the stored pieces", () => {
    const a = parseCityLimitsAreaShare(stored, { cityName: "Horseshoe Bay" })!;
    expect(a.rule).toBe("majority");
    expect(a.winnerShare).toBe(0.93);
    expect(a.split).toBe(true);
    expect(a.disclosure).toBe("93% in Horseshoe Bay, 7% unincorporated");
  });

  it("a stored `split: false` cannot hide a real split (derived, not trusted)", () => {
    const a = parseCityLimitsAreaShare({ ...stored, split: false, disclosure: null }, { cityName: "Horseshoe Bay" })!;
    expect(a.split).toBe(true);
  });

  it("drops a decision whose winner is not the cell's own answer", () => {
    expect(parseCityLimitsAreaShare(stored, { cityName: null })).toBeNull();
    expect(parseCityLimitsAreaShare(stored, { cityName: "Marble Falls" })).toBeNull();
  });

  it("drops a malformed or foreign decision", () => {
    expect(parseCityLimitsAreaShare(null, { cityName: "Horseshoe Bay" })).toBeNull();
    expect(parseCityLimitsAreaShare({ ...stored, method: "covers-v1" }, { cityName: "Horseshoe Bay" })).toBeNull();
    expect(parseCityLimitsAreaShare({ ...stored, pieces: [] }, { cityName: "Horseshoe Bay" })).toBeNull();
    expect(
      parseCityLimitsAreaShare(
        { method: AREA_SHARE_METHOD, pieces: [{ cityName: "Horseshoe Bay", share: 1.7, areaM2: 10 }] },
        { cityName: "Horseshoe Bay" },
      ),
    ).toBeNull();
  });

  it("an unincorporated cell's decision has the remainder as its winner", () => {
    const a = parseCityLimitsAreaShare(
      {
        method: AREA_SHARE_METHOD,
        pieces: [
          { cityName: null, share: 0.88, areaM2: 4048 },
          { cityName: "Bertram", geoId: "4807876", share: 0.12, areaM2: 552 },
        ],
      },
      { cityName: null },
    )!;
    expect(a.disclosure).toBe("88% unincorporated, 12% in Bertram");
  });
});

describe("cityAreaShareSql — the county-scale measurement", () => {
  it("measures in EPSG:3083 against subdivided cities chosen spatially, and never SETs", () => {
    const sql = cityAreaShareSql();
    expect(sql).toMatch(/ST_Transform\([^)]*3083\)/);
    expect(sql).toMatch(/ST_Subdivide\(/);
    expect(sql).toMatch(/ST_Union\(t\.geom\)/);
    expect(sql).toMatch(/prop_id <> '0'/);
    expect(sql).not.toMatch(/\bSET\b/i);
    expect(sql).not.toMatch(/area_deg2/);
    expect(cityAreaShareSql({ withDegreeAreas: true })).toMatch(/area_deg2/);
  });

  it("groups rows into decideByAreaShare input", () => {
    const g = groupCityAreaShareRows([
      { prop_id: "1", parcel_m2: "1000", geo_id: "A", city_name: "City A", gnis: null, area_m2: "600" },
      { prop_id: "1", parcel_m2: "1000", geo_id: "B", city_name: "City B", gnis: null, area_m2: "100" },
      { prop_id: "2", parcel_m2: "50", geo_id: null, city_name: null, gnis: null, area_m2: null },
    ]);
    expect(g.get("1")!.pieces).toHaveLength(2);
    expect(g.get("2")!.pieces).toHaveLength(0);
    const d = decideByAreaShare(g.get("1")!.parcelM2, g.get("1")!.pieces, UNINC)!;
    expect(d.disclosure).toBe("60% in City A, 30% unincorporated, 10% in City B");
  });
});
