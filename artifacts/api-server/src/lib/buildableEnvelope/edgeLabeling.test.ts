/**
 * Edge-labeling tests (the crux). Verifies the front edge is picked from the
 * best available signal and that a no-signal parcel degrades to a LOW-confidence
 * shape heuristic (flagged approximate downstream).
 */

import { describe, it, expect } from "vitest";
import { feetToMeters, projectRing, type Ring } from "./geometry";
import { labelEdges, insetFeetForLabeling } from "./edgeLabeling";

/** 100ft (E-W) x 200ft (N-S) rect centered at (lng0, lat0). */
function rectRing(lng0: number, lat0: number, wFt = 100, hFt = 200): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((lat0 * Math.PI) / 180);
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

const LNG0 = -97.31;
const LAT0 = 30.11;

describe("labelEdges — road signal (HIGH confidence)", () => {
  it("picks the parcel edge nearest+parallel to the road as front", () => {
    const ring = rectRing(LNG0, LAT0);
    // A road running E-W just south of the lot (~20 ft below the south edge).
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat; // south edge
    const roadLat = southEdgeLat - feetToMeters(20) / mPerDegLat;
    const road: [number, number][] = [
      [LNG0 - 0.002, roadLat],
      [LNG0 + 0.002, roadLat],
    ];
    const result = labelEdges({ ring, road })!;
    expect(result.signal).toBe("road");
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    // The front edge midpoint should be the SOUTH (lower-y) horizontal edge.
    const proj = projectRing(ring)!;
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    const a = proj.points[frontEdge.index]!;
    const b = proj.points[(frontEdge.index + 1) % proj.points.length]!;
    const midY = (a.y + b.y) / 2;
    expect(midY).toBeLessThan(0); // southern edge
    // Exactly one front, one rear, rest sides.
    expect(result.edges.filter((e) => e.label === "front")).toHaveLength(1);
    expect(result.edges.filter((e) => e.label === "rear")).toHaveLength(1);
    expect(result.edges.filter((e) => e.label === "side")).toHaveLength(2);
  });

  it("ignores a road that is too far to trust, falling to shape", () => {
    const ring = rectRing(LNG0, LAT0);
    // Road 500 ft away — beyond the trust gate.
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const farLat = LAT0 - feetToMeters(500) / mPerDegLat;
    const road: [number, number][] = [
      [LNG0 - 0.002, farLat],
      [LNG0 + 0.002, farLat],
    ];
    const result = labelEdges({ ring, road, refPoint: null })!;
    // No trustworthy road, no point -> shape heuristic, low confidence.
    expect(result.signal).toBe("shape");
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("labelEdges — point signal (MEDIUM)", () => {
  it("picks the edge nearest the geocoded point when no road", () => {
    const ring = rectRing(LNG0, LAT0);
    // Geocoded point near the NORTH edge.
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const northLat = LAT0 + feetToMeters(90) / mPerDegLat;
    const result = labelEdges({
      ring,
      road: null,
      refPoint: { lng: LNG0, lat: northLat },
    })!;
    expect(result.signal).toBe("point");
    expect(result.confidence).toBeGreaterThan(0.4);
    expect(result.confidence).toBeLessThan(0.7); // medium, not high
    const proj = projectRing(ring)!;
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    const a = proj.points[frontEdge.index]!;
    const b = proj.points[(frontEdge.index + 1) % proj.points.length]!;
    const midY = (a.y + b.y) / 2;
    expect(midY).toBeGreaterThan(0); // northern edge (nearest the point)
  });
});

describe("labelEdges — shape fallback (LOW confidence, flagged)", () => {
  it("degrades to a low-confidence shape heuristic with no signals", () => {
    const ring = rectRing(LNG0, LAT0);
    const result = labelEdges({ ring, road: null, refPoint: null })!;
    expect(result.signal).toBe("shape");
    expect(result.confidence).toBeLessThan(0.5);
    // Front should be one of the SHORT (100ft E-W) edges.
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    expect(frontEdge.lengthM).toBeLessThan(
      // shorter than the 200ft edges
      feetToMeters(150),
    );
  });
});

describe("insetFeetForLabeling", () => {
  it("maps labels to front/side/rear feet aligned to ring order", () => {
    const ring = rectRing(LNG0, LAT0);
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const roadLat = LAT0 - feetToMeters(120) / mPerDegLat;
    const labeling = labelEdges({
      ring,
      road: [
        [LNG0 - 0.002, roadLat],
        [LNG0 + 0.002, roadLat],
      ],
    })!;
    const feet = insetFeetForLabeling(labeling, {
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
    });
    expect(feet).toHaveLength(labeling.edges.length);
    // Front edge gets 25, rear gets 20, sides get 7.5.
    labeling.edges.forEach((e, i) => {
      if (e.label === "front") expect(feet[i]).toBe(25);
      if (e.label === "rear") expect(feet[i]).toBe(20);
      if (e.label === "side") expect(feet[i]).toBe(7.5);
    });
  });
});
