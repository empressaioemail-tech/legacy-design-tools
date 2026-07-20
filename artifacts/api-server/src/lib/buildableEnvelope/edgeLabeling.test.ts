/**
 * Edge-labeling tests (the crux). Verifies the front edge is picked from the
 * best available signal and that a no-signal parcel degrades to a LOW-confidence
 * shape heuristic (flagged approximate downstream).
 */

import { describe, it, expect } from "vitest";
import { feetToMeters, projectRing, type Ring } from "./geometry";
import {
  labelEdges,
  insetFeetForLabeling,
  normalizeStreetName,
  streetNameFromSitus,
  type RoadCandidate,
} from "./edgeLabeling";

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

describe("normalizeStreetName + streetNameFromSitus", () => {
  it("canonicalizes suffix + directional so situs matches OSM full name", () => {
    expect(normalizeStreetName("NOLAN DR")).toBe("nolan drive");
    expect(normalizeStreetName("Nolan Drive")).toBe("nolan drive");
    // Both sides normalize equal -> a valid match.
    expect(normalizeStreetName("120 NOLAN DR")).toBe("nolan drive");
    expect(normalizeStreetName("W Oak St")).toBe("west oak street");
    expect(normalizeStreetName("Live Oak Blvd")).toBe("live oak boulevard");
  });

  it("extracts the street from a full situs (first comma part)", () => {
    expect(streetNameFromSitus("120 NOLAN DR, KYLE, TX 78640")).toBe(
      "nolan drive",
    );
    expect(streetNameFromSitus("501 W OAK ST, KYLE, TX")).toBe(
      "west oak street",
    );
  });

  it("returns empty for null/blank/unparseable situs", () => {
    expect(streetNameFromSitus(null)).toBe("");
    expect(streetNameFromSitus("")).toBe("");
    expect(streetNameFromSitus("   ")).toBe("");
  });
});

describe("labelEdges — situs-named road preference (cul-de-sac defense)", () => {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  // South edge is 100ft below LAT0 (rect is 200ft tall, centered).
  const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat;
  const northEdgeLat = LAT0 + feetToMeters(100) / mPerDegLat;

  function roadAtLat(lat: number): [number, number][] {
    return [
      [LNG0 - 0.002, lat],
      [LNG0 + 0.002, lat],
    ];
  }

  it("prefers the SITUS-named cul-de-sac (south) over a longer through-street (north)", () => {
    const ring = rectRing(LNG0, LAT0);
    // A LONGER through street just north of the lot (would win by length/nearest
    // if only roads[0] were passed), and a SHORTER situs-named cul-de-sac just
    // south. Both within the trust gate.
    const throughStreet: RoadCandidate = {
      name: "Center Street",
      polyline: roadAtLat(northEdgeLat + feetToMeters(15) / mPerDegLat),
    };
    const culDeSac: RoadCandidate = {
      name: "Nolan Drive",
      polyline: roadAtLat(southEdgeLat - feetToMeters(15) / mPerDegLat),
    };
    // Order deliberately puts the through-street first (the old roads[0] bug).
    const result = labelEdges({
      ring,
      roads: [throughStreet, culDeSac],
      situsAddress: "120 NOLAN DR, KYLE, TX 78640",
    })!;
    expect(result.signal).toBe("road");
    expect(result.note).toContain("situs-named");
    // Front edge must be the SOUTH edge (matching Nolan Drive), not the north.
    const proj = projectRing(ring)!;
    const front = result.edges.find((e) => e.label === "front")!;
    const a = proj.points[front.index]!;
    const b = proj.points[(front.index + 1) % proj.points.length]!;
    expect((a.y + b.y) / 2).toBeLessThan(0); // southern edge
  });

  it("falls back to NEAREST across all candidates when situs name has no match", () => {
    const ring = rectRing(LNG0, LAT0);
    // Neither road matches the situs name; the closer one (south) should win —
    // and it's NOT the longest, proving all candidates are considered.
    const farNorth: RoadCandidate = {
      name: "Center Street",
      polyline: roadAtLat(northEdgeLat + feetToMeters(30) / mPerDegLat),
    };
    const nearSouth: RoadCandidate = {
      name: "Some Other Way",
      polyline: roadAtLat(southEdgeLat - feetToMeters(8) / mPerDegLat),
    };
    const result = labelEdges({
      ring,
      roads: [farNorth, nearSouth],
      situsAddress: "120 NOLAN DR, KYLE, TX 78640", // no matching road
    })!;
    expect(result.signal).toBe("road");
    expect(result.note).not.toContain("situs-named");
    const proj = projectRing(ring)!;
    const front = result.edges.find((e) => e.label === "front")!;
    const a = proj.points[front.index]!;
    const b = proj.points[(front.index + 1) % proj.points.length]!;
    expect((a.y + b.y) / 2).toBeLessThan(0); // nearer (south) edge
  });

  it("all-roads pass: the shorter SIDE-street frontage beats the longer nearby way", () => {
    const ring = rectRing(LNG0, LAT0);
    // Old bug: only roads[0] (longest) was passed, so a lot fronting a short
    // side street matched the wrong (longer) road. Here the longest way is far
    // north (fails/loses), the true frontage is a short south way, no situs.
    const longFar: RoadCandidate = {
      name: null,
      polyline: [
        [LNG0 - 0.01, northEdgeLat + feetToMeters(120) / mPerDegLat],
        [LNG0 + 0.01, northEdgeLat + feetToMeters(120) / mPerDegLat],
      ],
    };
    const shortNear: RoadCandidate = {
      name: null,
      polyline: roadAtLat(southEdgeLat - feetToMeters(12) / mPerDegLat),
    };
    const result = labelEdges({ ring, roads: [longFar, shortNear] })!;
    expect(result.signal).toBe("road");
    const proj = projectRing(ring)!;
    const front = result.edges.find((e) => e.label === "front")!;
    const a = proj.points[front.index]!;
    const b = proj.points[(front.index + 1) % proj.points.length]!;
    expect((a.y + b.y) / 2).toBeLessThan(0); // south (the real frontage)
  });

  it("still degrades to point when NO road candidate passes the trust gate", () => {
    const ring = rectRing(LNG0, LAT0);
    const farAway: RoadCandidate = {
      name: "Nolan Drive",
      polyline: roadAtLat(LAT0 - feetToMeters(500) / mPerDegLat),
    };
    const result = labelEdges({
      ring,
      roads: [farAway],
      situsAddress: "120 NOLAN DR, KYLE, TX",
      refPoint: { lng: LNG0, lat: northEdgeLat + feetToMeters(20) / mPerDegLat },
    })!;
    // Road too far -> honest degradation to the point signal (fallback intact).
    expect(result.signal).toBe("point");
  });

  it("back-compat: a single `road` polyline still labels as before", () => {
    const ring = rectRing(LNG0, LAT0);
    const result = labelEdges({
      ring,
      road: roadAtLat(southEdgeLat - feetToMeters(15) / mPerDegLat),
    })!;
    expect(result.signal).toBe("road");
    expect(result.note).not.toContain("situs-named");
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
