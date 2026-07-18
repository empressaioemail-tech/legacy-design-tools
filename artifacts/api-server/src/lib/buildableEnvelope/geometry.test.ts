/**
 * Geometry-core tests: per-edge inset correctness, empty-envelope handling.
 *
 * Uses a rectangular lot at a known latitude and checks the buildable area
 * matches the closed-form (W - 2*sideOrFrontRear) product within a small
 * tolerance (the equirectangular projection introduces sub-0.1% error at
 * parcel scale).
 */

import { describe, it, expect } from "vitest";
import {
  insetPerEdge,
  ringAreaSqFt,
  projectRing,
  feetToMeters,
  metersToFeet,
  type Ring,
} from "./geometry";

const FT_PER_M = 3.280839895;

/**
 * Build a rectangular ring `wFt` wide (E-W) x `hFt` tall (N-S) centered at
 * (lng0, lat0). Returned CLOSED and in CCW-ish input order; projectRing
 * re-orients internally.
 */
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

describe("feet/meter round-trip", () => {
  it("converts consistently", () => {
    expect(metersToFeet(feetToMeters(100))).toBeCloseTo(100, 6);
  });
});

describe("ringAreaSqFt", () => {
  it("computes a rectangle's area", () => {
    // 100ft x 200ft = 20,000 sqft.
    const ring = rectRing(-97.31, 30.11, 100, 200);
    expect(ringAreaSqFt(ring)).toBeCloseTo(20_000, -1); // within ~10 sqft
  });
});

describe("insetPerEdge — rectangular lot", () => {
  it("shrinks by front/side/rear correctly", () => {
    // 100 (E-W) x 200 (N-S). CCW opened order from projectRing determines edge
    // indices; we set every edge to its geometric setback so the result is the
    // deterministic (100-2*side) x (200-front-rear) rectangle regardless of
    // which specific edge got front vs rear.
    const ring = rectRing(-97.31, 30.11, 100, 200);
    const proj = projectRing(ring)!;
    // Identify each edge as horizontal (E-W, top/bottom) or vertical (sides).
    const insetFeet = proj.points.map((_p, i) => {
      const a = proj.points[i]!;
      const b = proj.points[(i + 1) % proj.points.length]!;
      const horizontal = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);
      // horizontal edges are front/rear (25 + 20 total across the pair),
      // vertical edges are sides (7.5 each).
      if (horizontal) {
        // Assign front=25 to the southern (lower y) edge, rear=20 to northern.
        const midY = (a.y + b.y) / 2;
        return midY < 0 ? 25 : 20;
      }
      return 7.5;
    });
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(false);
    expect(res.ring).not.toBeNull();
    // Expected buildable = (100 - 15) x (200 - 45) = 85 x 155 = 13,175 sqft.
    expect(res.areaSqFt).toBeCloseTo(13_175, -2); // within ~100 sqft
    expect(res.parcelAreaSqFt).toBeCloseTo(20_000, -1);
    // Buildable must be strictly smaller than the parcel.
    expect(res.areaSqFt).toBeLessThan(res.parcelAreaSqFt);
  });

  it("returns empty when setbacks exceed the lot", () => {
    // 40ft x 40ft lot, uniform 25ft setback -> nothing left.
    const ring = rectRing(-97.31, 30.11, 40, 40);
    const proj = projectRing(ring)!;
    const insetFeet = proj.points.map(() => 25);
    const res = insetPerEdge(ring, insetFeet);
    expect(res.empty).toBe(true);
    expect(res.ring).toBeNull();
    expect(res.areaSqFt).toBe(0);
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
    expect(res.ring).toBeNull();
  });

  it("flags a mismatch between edge count and setback array", () => {
    const ring = rectRing(-97.31, 30.11, 100, 200);
    // Wrong-length setback array.
    const res = insetPerEdge(ring, [25, 20]);
    expect(res.empty).toBe(true);
    expect(res.emptyReason).toMatch(/mismatch/i);
  });

  it("a uniform inset shrinks area monotonically with distance", () => {
    const ring = rectRing(-97.31, 30.11, 120, 120);
    const proj = projectRing(ring)!;
    const small = insetPerEdge(
      ring,
      proj.points.map(() => 10),
    );
    const large = insetPerEdge(
      ring,
      proj.points.map(() => 25),
    );
    expect(small.areaSqFt).toBeGreaterThan(large.areaSqFt);
    // 120-20=100 -> 10,000; 120-50=70 -> 4,900.
    expect(small.areaSqFt).toBeCloseTo(10_000, -2);
    expect(large.areaSqFt).toBeCloseTo(4_900, -2);
  });
});
