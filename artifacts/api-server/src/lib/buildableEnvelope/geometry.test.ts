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
    const proj = projectRing(PARCEL_714_SPRING_33512)!;
    const insetFeet = proj.points.map(() => 15);
    const gate = geometryCorrectnessGate(
      PARCEL_714_SPRING_33512,
      INJECTED_PARCEL_AS_INSET_714_SPRING,
      insetFeet,
    );
    expect(gate.pass).toBe(false);
    expect(gate.reasons.some((r) => /offset|implausible/i.test(r))).toBe(true);
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
