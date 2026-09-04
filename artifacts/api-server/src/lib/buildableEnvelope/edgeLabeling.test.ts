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
  expandGroupLabelsToEdges,
  type EdgeLabel,
  type RoadCandidate,
} from "./edgeLabeling";
import { BASTROP_P5_ROAD_CLASS_SETBACKS } from "./roadClassSetbacks";
import { PARCEL_714_SPRING_33512 } from "./fixtures/parcelRings";

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
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    expect(frontEdge.lengthM).toBeLessThan(feetToMeters(150));
  });

  it("ignores survey-artifact sliver edges on jagged rings (WDLL 5)", () => {
    const latRad = (LAT0 * Math.PI) / 180;
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const mPerDegLng = mPerDegLat * Math.cos(latRad);
    const hw = feetToMeters(50) / mPerDegLng;
    const hd = feetToMeters(100) / mPerDegLat;
    const sliver = feetToMeters(0.8) / mPerDegLng;
    const ring: Ring = [
      [LNG0 - hw, LAT0 - hd / 2],
      [LNG0 + hw, LAT0 - hd / 2],
      [LNG0 + hw + sliver, LAT0 - hd / 2 + feetToMeters(0.5) / mPerDegLat],
      [LNG0 + hw, LAT0 + hd / 2],
      [LNG0 - hw, LAT0 + hd / 2],
      [LNG0 - hw, LAT0 - hd / 2],
    ];
    const result = labelEdges({ ring, road: null, refPoint: null })!;
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    expect(frontEdge.lengthM).toBeGreaterThan(1.5);
    expect(frontEdge.lengthM).toBeLessThan(feetToMeters(120));
  });

  it("714 Spring St shape fallback does not pick globally shortest edge (WDLL 5)", () => {
    const result = labelEdges({
      ring: PARCEL_714_SPRING_33512,
      road: null,
      refPoint: null,
    })!;
    expect(result.signal).toBe("shape");
    const frontEdge = result.edges.find((e) => e.label === "front")!;
    const minLen = Math.min(...result.edges.map((e) => e.lengthM));
    expect(frontEdge.lengthM).toBeGreaterThan(minLen + 1e-6);
    expect(frontEdge.lengthM).toBeGreaterThan(15);
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
    // Two named roads on opposite edges → corner geometry (side_corner on north).
    expect(result.cornerLot).toBe(true);
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(true);
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

  it("not_specified axes inset 0 (silence ≠ real zero entitlement at display)", () => {
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
      side_ft: 0,
      rear_ft: 0,
      not_specified: { side: true, rear: true },
    });
    labeling.edges.forEach((e, i) => {
      if (e.label === "front") expect(feet[i]).toBe(25);
      if (e.label === "side" || e.label === "rear") expect(feet[i]).toBe(0);
    });
  });
});

describe("labelEdges — corner lot (2 named street frontages)", () => {
  it("labels a second named road edge as side_corner and applies side_corner_ft", () => {
    const ring = rectRing(LNG0, LAT0);
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
    const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat;
    const southRoadLat = southEdgeLat - feetToMeters(15) / mPerDegLat;
    // West road just outside the west frontage.
    const westLng = LNG0 - feetToMeters(60) / mPerDegLng;
    const roads: RoadCandidate[] = [
      {
        name: "Pecan Street",
        polyline: [
          [LNG0 - 0.002, southRoadLat],
          [LNG0 + 0.002, southRoadLat],
        ],
      },
      {
        name: "Main Avenue",
        polyline: [
          [westLng, LAT0 - 0.002],
          [westLng, LAT0 + 0.002],
        ],
      },
    ];
    const result = labelEdges({ ring, roads, situsAddress: "703 PECAN ST" })!;
    expect(result.signal).toBe("road");
    expect(result.cornerLot).toBe(true);
    expect(result.note).toMatch(/situs-named|nearest street/i);
    expect(result.note).toMatch(/corner lot/i);
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(true);
    const feet = insetFeetForLabeling(result, {
      front_ft: 25,
      side_ft: 5,
      rear_ft: 10,
      side_corner_ft: 15,
    });
    result.edges.forEach((e, i) => {
      if (e.label === "front") expect(feet[i]).toBe(25);
      if (e.label === "side_corner") expect(feet[i]).toBe(15);
      if (e.label === "side") expect(feet[i]).toBe(5);
    });
  });

  it("does not fabricate side_corner when second named frontage is unresolved", () => {
    const ring = rectRing(LNG0, LAT0);
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat;
    const southRoadLat = southEdgeLat - feetToMeters(15) / mPerDegLat;
    // Two named roads both map to the same south edge — no distinct corner edge.
    const roads: RoadCandidate[] = [
      {
        name: "Pecan Street",
        polyline: [
          [LNG0 - 0.002, southRoadLat],
          [LNG0 + 0.002, southRoadLat],
        ],
      },
      {
        name: "Pecan Court",
        polyline: [
          [LNG0 - 0.0015, southRoadLat - 0.00001],
          [LNG0 + 0.0015, southRoadLat - 0.00001],
        ],
      },
    ];
    const result = labelEdges({ ring, roads })!;
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(false);
    // Either single-front (same edge) or cornerUnresolved — never invent.
    expect(result.cornerLot).not.toBe(true);
  });
});

// === Segmented street frontage + corner adjacency (WDLL P-60b items 3 + 5) ===

/**
 * Real parcel 48453:280239 (17005 Simsbrook Drive, Pflugerville TX), captured
 * live 2026-08-23 from the Travis County parcel service into
 * P:/tmp/simsbrook_forensics/parcel_by_propid.json. The Simsbrook Drive
 * frontage is a gentle curve digitized as SEVEN chords (one 2.4 ft + six
 * 9.0 ft, each joint turning ~0.6°); real corners on the ring turn 89.8–92.7°;
 * the two rear edges are exactly collinear (0.00° joint).
 */
const SIMSBROOK_RING: Ring = [
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
 * Real Overpass response for the same parcel (roads_overpass.json in the
 * forensics dir), in production order (namedRoadsFromOverpass sorts longest
 * first): two unnamed sidewalks, then Simsbrook Drive (nearest frontage edge
 * at 7.5 m) and Dashwood Creek Drive (nearest edge 9 at 43.3 m — ACROSS the
 * block, 142 ft from the parcel; it does not adjoin).
 */
const SIMSBROOK_ROADS: RoadCandidate[] = [
  {
    name: null,
    highway: "footway",
    classification: "unclassified",
    polyline: [
      [-97.6357348, 30.4602548],
      [-97.6357321, 30.4602086],
      [-97.6356672, 30.4597176],
      [-97.6356229, 30.4593211],
      [-97.6356194, 30.4591188],
      [-97.6356299, 30.4589799],
      [-97.6356649, 30.4587716],
      [-97.6357104, 30.4585975],
      [-97.6357536, 30.4584797],
      [-97.6358354, 30.4583016],
      [-97.6359451, 30.4581044],
      [-97.6365258, 30.4572005],
      [-97.6365289, 30.4571812],
      [-97.6365166, 30.4571673],
      [-97.6363733, 30.4570989],
      [-97.6361084, 30.4569482],
      [-97.6360896, 30.4569121],
      [-97.635999, 30.4568155],
      [-97.6359823, 30.4568092],
      [-97.6359722, 30.4568086],
      [-97.6359454, 30.4568109],
      [-97.6358938, 30.4568566],
      [-97.6357677, 30.4570363],
      [-97.6357208, 30.4571242],
      [-97.635702, 30.4571363],
      [-97.6355638, 30.4573687],
      [-97.6355478, 30.4573727],
      [-97.6354901, 30.4574797],
    ],
  },
  {
    name: null,
    highway: "footway",
    classification: "unclassified",
    polyline: [
      [-97.6348485, 30.4602976],
      [-97.63474, 30.4594236],
      [-97.6347329, 30.45923],
      [-97.6347329, 30.459103],
      [-97.6347481, 30.4588682],
      [-97.6347725, 30.4587148],
      [-97.6348172, 30.4585291],
      [-97.6348498, 30.4583986],
      [-97.634925, 30.4582014],
      [-97.6350175, 30.4579833],
      [-97.6351191, 30.4577905],
      [-97.6353996, 30.4573735],
      [-97.6358241, 30.4567134],
      [-97.6358441, 30.4566855],
    ],
  },
  {
    name: "Simsbrook Drive",
    highway: "residential",
    classification: "residential",
    polyline: [
      [-97.6366447, 30.4571234],
      [-97.6359149, 30.4582554],
      [-97.6358039, 30.4584991],
      [-97.6357307, 30.4587386],
      [-97.6356851, 30.4590384],
      [-97.6356856, 30.4593321],
      [-97.6358071, 30.4603513],
    ],
  },
  {
    name: "Dashwood Creek Drive",
    highway: "residential",
    classification: "residential",
    polyline: [
      [-97.6354228, 30.4574519],
      [-97.6351246, 30.457897],
      [-97.6350277, 30.4581045],
      [-97.6349429, 30.458333],
      [-97.6348737, 30.4585693],
      [-97.6348191, 30.4587858],
      [-97.634797, 30.4590206],
      [-97.6347952, 30.4592555],
      [-97.6349232, 30.4604399],
    ],
  },
];

const SIMSBROOK_SITUS = "17005 SIMSBROOK DR, PFLUGERVILLE, TX 78660";

describe("labelEdges — Simsbrook 48453:280239 segmented frontage (WDLL P-60b 3+5)", () => {
  it("labels all seven frontage-curve edges front and merges the collinear rear pair", () => {
    const result = labelEdges({
      ring: SIMSBROOK_RING,
      roads: SIMSBROOK_ROADS,
      situsAddress: SIMSBROOK_SITUS,
    })!;
    expect(result.signal).toBe("road");
    expect(result.edges).toHaveLength(11);
    const labels = result.edges.map((e) => e.label);
    // Edges 0–6: the digitized frontage curve — the WHOLE curve is one street
    // frontage (front setback applies along the entire frontage, not to one
    // arbitrary 9 ft chord of it).
    expect(labels.slice(0, 7)).toEqual(Array<EdgeLabel>(7).fill("front"));
    // Edges 8+9 are exactly collinear (0.00° joint) — one logical rear edge.
    expect(labels[8]).toBe("rear");
    expect(labels[9]).toBe("rear");
    // Edges 7 and 10 are the two ~113 ft sides.
    expect(labels[7]).toBe("side");
    expect(labels[10]).toBe("side");
    expect(result.note).toMatch(/entire frontage/i);
  });

  it("does not fabricate a corner from non-adjoining Dashwood Creek (43.3 m)", () => {
    const result = labelEdges({
      ring: SIMSBROOK_RING,
      roads: SIMSBROOK_ROADS,
      situsAddress: SIMSBROOK_SITUS,
    })!;
    // Dashwood Creek passes the 45 m PRIMARY trust gate but sits 142 ft from
    // the parcel — it does not adjoin, so this is NOT a corner lot, the note
    // must not claim one, and it must not even read "possible corner".
    expect(result.cornerLot).not.toBe(true);
    expect(result.cornerUnresolved).not.toBe(true);
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(false);
    expect(result.note).not.toMatch(/corner/i);
  });

  it("produces the SF-S feet array aligned 1:1 with the original 11 ring edges", () => {
    const result = labelEdges({
      ring: SIMSBROOK_RING,
      roads: SIMSBROOK_ROADS,
      situsAddress: SIMSBROOK_SITUS,
    })!;
    const feet = insetFeetForLabeling(result, {
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
      side_corner_ft: 15,
    });
    expect(feet).toHaveLength(11);
    expect(feet).toEqual([25, 25, 25, 25, 25, 25, 25, 7.5, 20, 20, 7.5]);
  });
});

describe("expandGroupLabelsToEdges — 1:1 alignment contract (violation tests)", () => {
  it("expands group labels back to per-edge labels in original ring order", () => {
    // Groups start mid-ring (the circular walk starts after the first corner).
    const groups = [[2, 3], [4], [0], [1]];
    const labels: EdgeLabel[] = ["front", "side", "rear", "side"];
    expect(expandGroupLabelsToEdges(groups, labels, 5)).toEqual([
      "rear",
      "side",
      "front",
      "front",
      "side",
    ]);
  });

  it("throws when a group omits an edge (misaligned expansion is caught)", () => {
    expect(() =>
      expandGroupLabelsToEdges([[0, 1], [2]], ["front", "side"], 4),
    ).toThrow(/3 edges labeled, expected 4/);
  });

  it("throws when two groups claim the same edge", () => {
    expect(() =>
      expandGroupLabelsToEdges(
        [
          [0, 1],
          [1, 2],
        ],
        ["front", "side"],
        3,
      ),
    ).toThrow(/assigned by two groups/);
  });

  it("throws on a group/label count mismatch", () => {
    expect(() =>
      expandGroupLabelsToEdges([[0], [1]], ["front"], 2),
    ).toThrow(/2 groups but 1 labels/);
  });

  it("throws on an out-of-range member index", () => {
    expect(() =>
      expandGroupLabelsToEdges([[0], [7]], ["front", "side"], 2),
    ).toThrow(/outside \[0\.\.2\)/);
  });
});

describe("labelEdges — segmented-curve synthetic (grouping)", () => {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);

  /**
   * 100 ft x 200 ft rectangle whose SOUTH edge is digitized as 8 sub-segments
   * along a very shallow arc (each joint turns well under 1°) — the synthetic
   * twin of the Simsbrook frontage curve.
   */
  function rectWithSegmentedSouthEdge(): Ring {
    const halfWM = feetToMeters(50);
    const halfHM = feetToMeters(100);
    const bowM = 0.25; // max arc depth — keeps every joint turn < 1°
    const ring: Ring = [];
    // South edge, west -> east, as 8 chords of a shallow arc (9 vertices).
    for (let k = 0; k <= 8; k++) {
      const x = -halfWM + (k / 8) * 2 * halfWM;
      const y = -halfHM + bowM * Math.sin((Math.PI * k) / 8);
      ring.push([LNG0 + x / mPerDegLng, LAT0 + y / mPerDegLat]);
    }
    // NE and NW corners, then close (CCW).
    ring.push([LNG0 + halfWM / mPerDegLng, LAT0 + halfHM / mPerDegLat]);
    ring.push([LNG0 - halfWM / mPerDegLng, LAT0 + halfHM / mPerDegLat]);
    ring.push([ring[0]![0], ring[0]![1]]);
    return ring;
  }

  it("labels all 8 sub-segments front when the road faces that side", () => {
    const ring = rectWithSegmentedSouthEdge();
    const roadLat = LAT0 - (feetToMeters(100) + 5) / mPerDegLat; // 5 m south
    const result = labelEdges({
      ring,
      road: [
        [LNG0 - 0.002, roadLat],
        [LNG0 + 0.002, roadLat],
      ],
    })!;
    expect(result.signal).toBe("road");
    // 8 south sub-segments + east + north + west = 11 edges.
    expect(result.edges).toHaveLength(11);
    expect(result.edges.filter((e) => e.label === "front")).toHaveLength(8);
    expect(result.edges.filter((e) => e.label === "rear")).toHaveLength(1);
    expect(result.edges.filter((e) => e.label === "side")).toHaveLength(2);
    // The front sub-segments are contiguous and all on the south side.
    const proj = projectRing(ring)!;
    for (const e of result.edges) {
      const a = proj.points[e.index]!;
      const b = proj.points[(e.index + 1) % proj.points.length]!;
      const midY = (a.y + b.y) / 2;
      if (e.label === "front") expect(midY).toBeLessThan(0);
      if (e.label === "rear") expect(midY).toBeGreaterThan(0);
    }
    // Feet array stays 1:1 with the original edges.
    const feet = insetFeetForLabeling(result, {
      front_ft: 25,
      side_ft: 7.5,
      rear_ft: 20,
    });
    expect(feet).toHaveLength(11);
    result.edges.forEach((e, i) => {
      if (e.label === "front") expect(feet[i]).toBe(25);
    });
  });

  it("does not merge real 90° corners (plain rectangle keeps 4 logical edges)", () => {
    const ring = rectRing(LNG0, LAT0);
    const mPerDegLatL = (Math.PI / 180) * 6_378_137;
    const roadLat = LAT0 - feetToMeters(120) / mPerDegLatL;
    const result = labelEdges({
      ring,
      road: [
        [LNG0 - 0.002, roadLat],
        [LNG0 + 0.002, roadLat],
      ],
    })!;
    expect(result.edges.filter((e) => e.label === "front")).toHaveLength(1);
    expect(result.edges.filter((e) => e.label === "rear")).toHaveLength(1);
    expect(result.edges.filter((e) => e.label === "side")).toHaveLength(2);
  });
});

describe("labelEdges — corner adjacency trust (WDLL P-60b item 5)", () => {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat;
  const southRoadLat = southEdgeLat - feetToMeters(15) / mPerDegLat;

  function cornerRoads(westRoadDistM: number): RoadCandidate[] {
    // West road at westRoadDistM beyond the west frontage (west edge is 50 ft
    // from center on the 100 ft wide fixture lot).
    const westLng = LNG0 - (feetToMeters(50) + westRoadDistM) / mPerDegLng;
    return [
      {
        name: "Pecan Street",
        polyline: [
          [LNG0 - 0.002, southRoadLat],
          [LNG0 + 0.002, southRoadLat],
        ],
      },
      {
        name: "Main Avenue",
        polyline: [
          [westLng, LAT0 - 0.002],
          [westLng, LAT0 + 0.002],
        ],
      },
    ];
  }

  it("still resolves a genuine corner lot (second road 12 m off the west frontage)", () => {
    const ring = rectRing(LNG0, LAT0);
    const result = labelEdges({
      ring,
      roads: cornerRoads(12),
      situsAddress: "703 PECAN ST",
    })!;
    expect(result.cornerLot).toBe(true);
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(true);
    expect(result.note).toMatch(/corner lot/i);
  });

  it("rejects a second road inside the 45 m trust gate but beyond adjacency (35 m)", () => {
    const ring = rectRing(LNG0, LAT0);
    // 35 m passed the OLD blanket gate (< 45 m) and fabricated a corner; a
    // road across the block is not a frontage. It must neither resolve a
    // corner nor leave "possible corner" wording behind.
    const result = labelEdges({
      ring,
      roads: cornerRoads(35),
      situsAddress: "703 PECAN ST",
    })!;
    expect(result.signal).toBe("road");
    expect(result.cornerLot).not.toBe(true);
    expect(result.cornerUnresolved).not.toBe(true);
    expect(result.edges.some((e) => e.label === "side_corner")).toBe(false);
    expect(result.note).not.toMatch(/corner/i);
  });
});

describe("insetFeetForLabeling — road-class-aware (R2)", () => {
  const LNG0 = -97.318;
  const LAT0 = 30.11;

  it("applies 15 ft street front and 5 ft alley rear on Bastrop P-5 fixture lot", () => {
    const ring = rectRing(LNG0, LAT0);
    const mPerDegLat = (Math.PI / 180) * 6_378_137;
    const southEdgeLat = LAT0 - feetToMeters(100) / mPerDegLat;
    const northEdgeLat = LAT0 + feetToMeters(100) / mPerDegLat;
    const southRoadLat = southEdgeLat - feetToMeters(15) / mPerDegLat;
    const northAlleyLat = northEdgeLat + feetToMeters(12) / mPerDegLat;
    const roads: RoadCandidate[] = [
      {
        name: "Spring Street",
        classification: "residential",
        polyline: [
          [LNG0 - 0.002, southRoadLat],
          [LNG0 + 0.002, southRoadLat],
        ],
      },
      {
        name: null,
        classification: "alley",
        highway: "service",
        polyline: [
          [LNG0 - 0.002, northAlleyLat],
          [LNG0 + 0.002, northAlleyLat],
        ],
      },
    ];
    const labeling = labelEdges({
      ring,
      roads,
      situsAddress: "714 SPRING ST",
    })!;
    expect(labeling.edges.some((e) => e.label === "front" && e.roadClass === "residential")).toBe(
      true,
    );
    expect(labeling.edges.some((e) => e.label === "rear" && e.roadClass === "alley")).toBe(true);

    const feet = insetFeetForLabeling(
      labeling,
      {
        front_ft: 15,
        side_ft: 0,
        rear_ft: 0,
        not_specified: { side: true, rear: true },
      },
      { districtCode: "P-5 Core", roadClassTable: BASTROP_P5_ROAD_CLASS_SETBACKS },
    );
    const frontIdx = labeling.edges.find((e) => e.label === "front")!.index;
    const rearIdx = labeling.edges.find((e) => e.label === "rear")!.index;
    expect(feet[frontIdx]).toBe(15);
    expect(feet[rearIdx]).toBe(5);
    expect(feet[rearIdx]).not.toBe(feet[frontIdx]);
  });
});
