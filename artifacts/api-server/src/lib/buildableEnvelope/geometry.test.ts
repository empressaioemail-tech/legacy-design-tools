/**
 * Geometry-core tests: strip-union-difference inset, correctness gate, fixtures.
 *
 * Cites 27c WDLL 1 (geometry correctness) and WDLL 2 (mechanical gate).
 */

import { describe, it, expect } from "vitest";
import {
  insetPerEdge,
  ringAreaSqFt,
  projectRing,
  feetToMeters,
  metersToFeet,
  geometryCorrectnessGate,
  type Ring,
} from "./geometry";
import {
  PARCEL_714_SPRING_33512,
  PARCEL_BASTROP_47728,
  INJECTED_PARCEL_AS_INSET_714_SPRING,
} from "./fixtures/parcelRings";

const FT_PER_M = 3.280839895;

function rectRing(
  lng0: number,
  lat0: number,
  wFt: number,
  hFt: number,
): Ring {
  const latRad = (lat0 * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  const halfW = feetToMeters(wFt) / 2 / mPerDegLng;
  const halfH = feetToMeters(hFt) / 2 / mPerDegLat;
  return [
    [lng0 - halfW, lat0 - halfH],
    [lng0 + halfW, lat0 - halfH],
    [lng0 + halfW, lat0 + halfH],
    [lng0 - halfW, lat0 + halfH],
    [lng0 - halfW, lat0 - halfH],
  ];
}

/** L-shaped concave lot (synthetic, ~120' arms). */
function lShapeRing(lng0: number, lat0: number): Ring {
  const latRad = (lat0 * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  const f = (eFt: number, nFt: number): [number, number] => [
    lng0 + feetToMeters(eFt) / mPerDegLng,
    lat0 + feetToMeters(nFt) / mPerDegLat,
  ];
  return [
    f(0, 0),
    f(120, 0),
    f(120, 60),
    f(60, 60),
    f(60, 120),
    f(0, 120),
    f(0, 0),
  ];
}

/** Corner lot: wider street frontage on south + east (synthetic). */
function cornerLotRing(lng0: number, lat0: number): Ring {
  const latRad = (lat0 * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  const f = (eFt: number, nFt: number): [number, number] => [
    lng0 + feetToMeters(eFt) / mPerDegLng,
    lat0 + feetToMeters(nFt) / mPerDegLat,
  ];
  return [
    f(0, 0),
    f(80, 0),
    f(100, 20),
    f(100, 100),
    f(0, 100),
    f(0, 0),
  ];
}

/** Obvious self-intersecting bowtie — gate must reject (RED fixture). */
export const SELF_INTERSECT_BOWTIE: Ring = [
  [-97.31, 30.11],
  [-97.309, 30.111],
  [-97.31, 30.111],
  [-97.309, 30.11],
  [-97.31, 30.11],
];

function assertGatePass(parcel: Ring, inset: Ring, setbacks: number[]) {
  const gate = geometryCorrectnessGate(parcel, inset, setbacks);
  expect(gate.pass, gate.reasons.join("; ")).toBe(true);
}

describe("feet/meter round-trip", () => {
  it("converts consistently", () => {
    expect(metersToFeet(feetToMeters(100))).toBeCloseTo(100, 6);
  });
});

describe("ringAreaSqFt", () => {
  it("computes a rectangle's area", () => {
    const ring = rectRing(-97.31, 30.11, 100, 200);
    expect(ringAreaSqFt(ring)).toBeCloseTo(20_000, -1);
  });
});

describe("insetPerEdge — rectangular lot", () => {
  it("shrinks by front/side/rear correctly", () => {
    const ring = rectRing(-97.31, 30.11, 100, 200);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map((_p, i) => {
      const a = proj.points[i]!;
      const b = proj.points[(i + 1) % proj.points.length]!;
      const horizontal = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
      if (horizontal) {
        const midY = (a.y + b.y) / 2;
        return midY < 0 ? 25 : 20;
      }
      return 7.5;
    });
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(false);
    expect(res.ring).not.toBeNull();
    expect(res.areaSqFt).toBeCloseTo(13_175, -2);
    assertGatePass(ring, res.ring!, insetFeet);
  });

  it("returns empty when setbacks exceed the lot", () => {
    const ring = rectRing(-97.31, 30.11, 40, 40);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map(() => 25);
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(true);
    expect(res.ring).toBeNull();
    expect(res.emptyReason).toMatch(/no buildable area|exceed/i);
    expect(res.emptyKind).toBe("consumed");
  });

  it("CONSUME-LOT TRUTH: 30x40 lot with 25 ft all around -> empty, consumed kind", () => {
    const ring = rectRing(-97.31, 30.11, 30, 40);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map(() => 25);
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(true);
    expect(res.ring).toBeNull();
    expect(res.emptyKind).toBe("consumed");
    expect(res.emptyReason).toMatch(/setbacks exceed the lot/i);
    expect(res.emptyReason).not.toMatch(/validation/i);
  });

  it("returns empty on a degenerate (non-polygon) ring", () => {
    const ring: Ring = [
      [-97.31, 30.11],
      [-97.31, 30.11],
      [-97.31, 30.11],
    ];
    const res = insetPerEdge(ring, [10, 10, 10]);
    expect(res.empty).toBe(true);
  });

  it("flags a mismatch between edge count and setback array", () => {
    const ring = rectRing(-97.31, 30.11, 100, 200);
    const res = insetPerEdge(ring, [25, 20]);
    expect(res.empty).toBe(true);
    expect(res.emptyReason).toMatch(/mismatch/i);
    expect(res.emptyKind).toBe("invalid-input");
  });

  it("a uniform inset shrinks area monotonically with distance", () => {
    const ring = rectRing(-97.31, 30.11, 120, 120);
    const proj = projectRing(ring)!;
    const small = insetPerEdge(ring, proj.points.map(() => 10));
    const large = insetPerEdge(ring, proj.points.map(() => 25));
    expect(small.areaSqFt).toBeGreaterThan(large.areaSqFt);
    expect(small.areaSqFt).toBeCloseTo(10_000, -2);
    expect(large.areaSqFt).toBeCloseTo(4_900, -2);
  });
});

describe("insetPerEdge — concave / corner / live Bastrop fixtures (WDLL 1)", () => {
  it("L-shape concave lot: contained, non-self-intersecting inset", () => {
    const ring = lShapeRing(-97.32, 30.12);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map(() => 10);
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(false);
    assertGatePass(ring, res.ring!, insetFeet);
    expect(res.areaSqFt).toBeGreaterThan(0);
    expect(res.areaSqFt).toBeLessThan(res.parcelAreaSqFt);
  });

  it("corner lot: valid inset under variable setbacks", () => {
    const ring = cornerLotRing(-97.32, 30.12);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map((_p, i) => {
      const a = proj.points[i]!;
      const b = proj.points[(i + 1) % proj.points.length]!;
      const midY = (a.y + b.y) / 2;
      const midX = (a.x + b.x) / 2;
      if (midY < proj.points[0]!.y + 1) return 10;
      if (midX > proj.points[0]!.x + 1) return 7.5;
      return 5;
    });
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(false);
    assertGatePass(ring, res.ring!, insetFeet);
  });

  it("714 Spring St (48021:33512): 15' uniform inset passes gate", () => {
    const proj = projectRing(PARCEL_714_SPRING_33512)!;
    const insetFeet = proj.points.map(() => 15);
    const res = insetPerEdge(PARCEL_714_SPRING_33512, insetFeet);
    expect(res.empty).toBe(false);
    expect(res.ring).not.toBeNull();
    assertGatePass(PARCEL_714_SPRING_33512, res.ring!, insetFeet);
    expect(res.areaSqFt).toBeGreaterThan(0);
    expect(res.areaSqFt).toBeLessThan(res.parcelAreaSqFt);
  });

  it("irregular Bastrop 47728: 10' uniform inset passes gate", () => {
    const proj = projectRing(PARCEL_BASTROP_47728)!;
    const insetFeet = proj.points.map(() => 10);
    const res = insetPerEdge(PARCEL_BASTROP_47728, insetFeet);
    expect(res.empty).toBe(false);
    assertGatePass(PARCEL_BASTROP_47728, res.ring!, insetFeet);
  });
});

describe("geometryCorrectnessGate — known-bad rings (WDLL 2 RED)", () => {
  it("rejects self-intersecting bowtie fixture", () => {
    const parcel = rectRing(-97.31, 30.11, 100, 100);
    const proj = projectRing(parcel)!;
    const gate = geometryCorrectnessGate(
      parcel,
      SELF_INTERSECT_BOWTIE,
      proj.points.map(() => 10),
    );
    expect(gate.pass).toBe(false);
    expect(gate.reasons.some((r) => /self-intersect/i.test(r))).toBe(true);
  });

  it("rejects injected parcel-as-inset (confident zero setback)", () => {
    // VIOLATION test for the conservation gate: the raw parcel ring passed
    // off as a 15' inset must fail on BOTH conservation grounds — it overlaps
    // the forbidden strips and its area does not match the clip remainder.
    // A check observed only passing has not been observed working.
    const proj = projectRing(PARCEL_714_SPRING_33512)!;
    const insetFeet = proj.points.map(() => 15);
    const gate = geometryCorrectnessGate(
      PARCEL_714_SPRING_33512,
      INJECTED_PARCEL_AS_INSET_714_SPRING,
      insetFeet,
    );
    expect(gate.pass).toBe(false);
    expect(
      gate.reasons.some((r) => /overlaps forbidden setback strips/i.test(r)),
    ).toBe(true);
    expect(
      gate.reasons.some((r) => /does not match the clip's dominant remainder/i.test(r)),
    ).toBe(true);
  });

  it("demonstrates RED: comment this expect to see CI fail", () => {
    const proj = projectRing(PARCEL_714_SPRING_33512)!;
    const gate = geometryCorrectnessGate(
      PARCEL_714_SPRING_33512,
      INJECTED_PARCEL_AS_INSET_714_SPRING,
      proj.points.map(() => 15),
    );
    expect(gate.pass).toBe(false);
  });
});

/**
 * Digitized rectangle: same shape as rectRing but each side subdivided into
 * collinear survey vertices (GIS parcels are digitized this way). Segment
 * counts 9/7/8/6 = 30 vertices, matching the P60b forensic repro.
 */
function digitizedRectRing(
  lng0: number,
  lat0: number,
  wFt: number,
  hFt: number,
  segs: [number, number, number, number] = [9, 7, 8, 6],
): Ring {
  const latRad = (lat0 * Math.PI) / 180;
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos(latRad);
  const f = (eFt: number, nFt: number): [number, number] => [
    lng0 + feetToMeters(eFt) / mPerDegLng,
    lat0 + feetToMeters(nFt) / mPerDegLat,
  ];
  const corners: [number, number][] = [
    [0, 0],
    [wFt, 0],
    [wFt, hFt],
    [0, hFt],
  ];
  const ring: Ring = [];
  for (let side = 0; side < 4; side++) {
    const a = corners[side]!;
    const b = corners[(side + 1) % 4]!;
    const k = segs[side]!;
    for (let i = 0; i < k; i++) {
      const t = i / k;
      ring.push(f(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
    }
  }
  ring.push(ring[0]!);
  return ring;
}

/** Front 25 (south) / rear 20 (north) / sides 7.5, per projected-edge midpoint. */
function frontRearSideFeet(ring: Ring): number[] {
  const proj = projectRing(ring)!;
  const n = proj.points.length;
  return proj.points.map((_p, i) => {
    const a = proj.points[i]!;
    const b = proj.points[(i + 1) % n]!;
    const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    if (horizontal) return (a.y + b.y) / 2 < 0 ? 25 : 20;
    return 7.5;
  });
}

/**
 * Real parcel 48453:280239 (17005 Simsbrook Dr, Pflugerville TX), captured
 * live 2026-08-23 from the Travis county cadastral service (P60b forensics,
 * P:/tmp/simsbrook_forensics/parcel_by_propid.json). Curved frontage
 * digitized as near-collinear short edges — the live false-empty repro.
 */
const SIMSBROOK_280239: Ring = [
  [-97.6352430942568, 30.4591069676234],
  [-97.6352520051467, 30.4590002733325],
  [-97.6352575934357, 30.4589333628894],
  [-97.6356142369004, 30.4589605231052],
  [-97.6356118197417, 30.4589850542453],
  [-97.6356096977318, 30.4590096036204],
  [-97.6356078728062, 30.4590341729904],
  [-97.635606341191, 30.4590587553998],
  [-97.635605108788, 30.4590833526916],
  [-97.6356041698402, 30.4591079578689],
  [-97.6356039948115, 30.459114634288],
  [-97.6352430942568, 30.4591069676234],
];

/**
 * As-is per-edge feet in PROJECTED (CCW) edge order, from the P60b forensic
 * labeling table: edges 0-2 side 7.5, 3 front 25, 4-7 side 7.5, 8 rear 20,
 * 9 side_corner 15, 10 side 7.5.
 */
function simsbrookAsIsFeet(): number[] {
  const feet = Array.from({ length: 11 }, () => 7.5);
  feet[3] = 25;
  feet[8] = 20;
  feet[9] = 15;
  return feet;
}

describe("insetPerEdge — P60b false-empty regressions (digitized/curved rings)", () => {
  it("REGRESSION: 30-collinear-vertex 60x113 rectangle, F25/R20/S7.5 -> ~3,060 sqft", () => {
    const ring = digitizedRectRing(-97.77, 30.27, 60, 113);
    const proj = projectRing(ring)!;
    expect(proj.points.length).toBe(30);
    const feet = frontRearSideFeet(ring);
    const res = insetPerEdge(ring, feet);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.ring).not.toBeNull();
    expect(res.areaSqFt).toBeGreaterThan(3_000);
    expect(res.areaSqFt).toBeLessThan(3_120);
    assertGatePass(ring, res.ring!, feet);
  });

  it("chamfered-corner rectangle (3 ft chamfer edge) -> non-empty, ~3,060 sqft", () => {
    const latRad = (30.27 * Math.PI) / 180;
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const mPerDegLng = mPerDegLat * Math.cos(latRad);
    const f = (eFt: number, nFt: number): [number, number] => [
      -97.77 + feetToMeters(eFt) / mPerDegLng,
      30.27 + feetToMeters(nFt) / mPerDegLat,
    ];
    const h = 3 / Math.SQRT2;
    const ring: Ring = [f(0, 0), f(60 - h, 0), f(60, h), f(60, 113), f(0, 113), f(0, 0)];
    const feet = [25, 7.5, 7.5, 20, 7.5];
    const res = insetPerEdge(ring, feet);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.areaSqFt).toBeGreaterThan(2_950);
    expect(res.areaSqFt).toBeLessThan(3_120);
    assertGatePass(ring, res.ring!, feet);
  });

  it("REGRESSION: real Simsbrook 48453:280239, as-is per-edge setbacks -> ~3,798 sqft", () => {
    const proj = projectRing(SIMSBROOK_280239)!;
    expect(proj.points.length).toBe(11);
    const feet = simsbrookAsIsFeet();
    const res = insetPerEdge(SIMSBROOK_280239, feet);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.ring).not.toBeNull();
    expect(res.areaSqFt).toBeGreaterThan(3_740);
    expect(res.areaSqFt).toBeLessThan(3_860);
    assertGatePass(SIMSBROOK_280239, res.ring!, feet);
  });

  it("REGRESSION: real Simsbrook 48453:280239, uniform 7.5 ft floor -> ~4,398 sqft", () => {
    const feet = Array.from({ length: 11 }, () => 7.5);
    const res = insetPerEdge(SIMSBROOK_280239, feet);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.areaSqFt).toBeGreaterThan(4_340);
    expect(res.areaSqFt).toBeLessThan(4_460);
    assertGatePass(SIMSBROOK_280239, res.ring!, feet);
  });
});

describe("insetPerEdge — throw-safety (WDLL 2 / R0.1)", () => {
  it("returns honest empty on non-finite inset feet (never throws)", () => {
    const proj = projectRing(PARCEL_714_SPRING_33512)!;
    const n = proj.points.length;
    const insetFeet = proj.points.map(() => 15);
    insetFeet[0] = Number.NaN;
    expect(() => insetPerEdge(PARCEL_714_SPRING_33512, insetFeet)).not.toThrow();
    const res = insetPerEdge(PARCEL_714_SPRING_33512, insetFeet);
    expect(res.empty).toBe(true);
    expect(res.ring).toBeNull();
    expect(res.emptyReason).toMatch(/non-finite/i);
    expect(res.emptyKind).toBe("invalid-input");
  });
});
