/**
 * Geometry-core tests: strip-union-difference inset, correctness gate, fixtures.
 *
 * Cites 27c WDLL 1 (geometry correctness) and WDLL 2 (mechanical gate).
 */

import { describe, it, expect } from "vitest";
import {
  insetPerEdge,
  ringAreaSqFt,
  ringContainsPoint,
  projectRing,
  feetToMeters,
  metersToFeet,
  geometryCorrectnessGate,
  stripReversalSpikes,
  BOOLEAN_RETRY_GRID_M,
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

  /**
   * RESTATED at P-235, from ~3,798 sqft to ~3,243 sqft. Read the reason before
   * "restoring" the old number.
   *
   * The 3,740..3,860 bound was asserted against what this function produced at
   * the time, and what it produced was wrong: the per-edge forbidden region was
   * a bare rectangle with no join at ring vertices, so at every REFLEX joint of
   * this curved frontage the rectangles splayed apart and left the buildable
   * region running back to the property line. Audited by pure trigonometry
   * (point-to-segment distance on a 3 cm grid, no boolean op, so it shares no
   * machinery with the code under test): of the old 3,797.1 sqft envelope,
   * 555.1 sqft lay INSIDE a setback and the worst vertex sat 25.00 ft inside
   * the 25 ft front setback — i.e. ON the front property line. The same audit
   * of the current output finds 1.1 sqft (the inscribed-arc residual) and a
   * worst intrusion of 0.03 ft. 3,797.1 - 555.1 = 3,242.0, which is the figure
   * below.
   *
   * The authority for the new number is the ordinance rule itself (no buildable
   * area within d feet of boundary edge d applies to), not this function's
   * output. `setbackJoinCoverage.test.ts` holds that rule as a standing check.
   */
  it("REGRESSION: real Simsbrook 48453:280239, as-is per-edge setbacks -> ~3,243 sqft", () => {
    const proj = projectRing(SIMSBROOK_280239)!;
    expect(proj.points.length).toBe(11);
    const feet = simsbrookAsIsFeet();
    const res = insetPerEdge(SIMSBROOK_280239, feet);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.ring).not.toBeNull();
    expect(res.areaSqFt).toBeGreaterThan(3_200);
    expect(res.areaSqFt).toBeLessThan(3_290);
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

/**
 * True when any vertex is a zero-width reversal: deviation-from-straight
 * beyond 160deg with the two legs rejoining inside 0.5 m.
 */
function ringHasReversalSpike(ring: Ring): boolean {
  const proj = projectRing(ring);
  if (!proj) return false;
  const pts = proj.points;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const ul = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const vl = Math.hypot(next.x - cur.x, next.y - cur.y);
    if (ul < 1e-9 || vl < 1e-9) return true; // duplicate vertex = degenerate
    const cos =
      ((cur.x - prev.x) * (next.x - cur.x) + (cur.y - prev.y) * (next.y - cur.y)) /
      (ul * vl);
    const devDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    const mouth = Math.hypot(next.x - prev.x, next.y - prev.y);
    if (devDeg > 160 && mouth < 0.5) return true;
  }
  return false;
}

describe("stripReversalSpikes — P60c zero-width spike cleanup at the source", () => {
  it("removes an injected zero-width out-and-back spike (violation direction)", () => {
    // 20x20 m square with a 7.6 m spike jammed into the south edge.
    const spiked = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10.01, y: -7.6 }, // spike tip: out-and-back, mouth 0.02 m
      { x: 10.02, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const out = stripReversalSpikes(spiked);
    expect(out.length).toBeLessThan(spiked.length);
    for (const p of out) expect(p.y).toBeGreaterThanOrEqual(0);
  });

  it("preserves a genuinely pointed lot corner (wide mouth)", () => {
    // Triangle-nosed lot: sharp corner but legs diverge > 0.5 m mouth.
    const pointed = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 34, y: 6 }, // ~41deg deviation, mouth huge — must survive
      { x: 30, y: 12 },
      { x: 0, y: 12 },
    ];
    expect(stripReversalSpikes(pointed)).toEqual(pointed);
  });

  it("REGRESSION: real Simsbrook inset rings carry no reversal spikes", () => {
    // Live 2026-08-24 defect: the wire ring for 48453:280239 carried a 7.61 m
    // zero-width excursion at every frontage chord junction; PE drew them as
    // perpendicular ladder strokes across the setback gap.
    const asIs = insetPerEdge(SIMSBROOK_280239, simsbrookAsIsFeet());
    expect(asIs.ring).not.toBeNull();
    expect(ringHasReversalSpike(asIs.ring!)).toBe(false);

    const uniform = insetPerEdge(
      SIMSBROOK_280239,
      Array.from({ length: 11 }, () => 7.5),
    );
    expect(uniform.ring).not.toBeNull();
    expect(ringHasReversalSpike(uniform.ring!)).toBe(false);
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

/**
 * P-372. The served ring for Kyle 48209:145880 (151 Fender Dr, Kyle TX 78640,
 * R-1-A), read live 2026-09-19 from the county-GIS parcel the route itself
 * serves (`scratch/ring-145880.json`: provider txgio, vintage
 * stratmap25-landparcels_48209_hays_202503). Four distinct vertices, closed,
 * no duplicate, positive area — a VALID ring, and the one whose clip threw.
 *
 * The per-edge feet are the route's own: `labelEdges` labels this ring from its
 * shape (signal "shape", no road reference at the sample point), giving
 * front=index 3 and the R-1-A table 25/10/15/10 in PROJECTED (CCW) edge order
 * as [10, 15, 10, 25] — exactly what `repro-out.json` recorded from the live
 * payload's own setbacks.
 */
const PARCEL_KYLE_145880: Ring = [
  [-97.88512793899997, 30.00097732100005],
  [-97.88554503899996, 30.000857747000055],
  [-97.88559389199997, 30.000997176000055],
  [-97.88518406699995, 30.001120211000057],
  [-97.88512793899997, 30.00097732100005],
];
const KYLE_R1A_FEET = [10, 15, 10, 25];

/**
 * The buildable area of Kyle's parcel as an INDEPENDENT instrument sees it:
 * `_scratch/analyze4.cjs` rasterised the membership definition the strips stand
 * for — `{p : dist(p, edge_i) <= d_i}` unioned over edges — on a 2 cm grid
 * (7,219,884 cells, 694.68 m² parcel, 537.636 m² forbidden) and put the buildable
 * region at 310.536 m². It shares no machinery with polygon-clipping. This is the
 * number the repaired answer is graded against, not the library's own output.
 */
const KYLE_BUILDABLE_ORACLE_M2 = 310.536;
/** `conservationEpsilonM2`'s absolute floor (m²). */
const CONSERVATION_EPSILON_M2 = 0.5;

/** Shift a lng/lat ring by metres east/north in the Kyle frame. */
function shiftKyleRing(ring: Ring, eastM: number, northM: number): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((30.000988113750054 * Math.PI) / 180);
  return ring.map(([lng, lat]): [number, number] => [
    lng! + eastM / mPerDegLng,
    lat! + northM / mPerDegLat,
  ]);
}

describe("insetPerEdge — P-372 parcel-minus-strips clip (Kyle 48209:145880)", () => {
  it("REGRESSION: the clip that threw on the as-constructed operands draws on the quantised retry", () => {
    const res = insetPerEdge(PARCEL_KYLE_145880, KYLE_R1A_FEET);
    expect(res.empty, res.emptyReason).toBe(false);
    expect(res.ring).not.toBeNull();
    // The repair is disclosed, not silent, and names the failure it recovered from.
    expect(res.clipRepair).toBeDefined();
    expect(res.clipRepair!.gridM).toBe(BOOLEAN_RETRY_GRID_M);
    expect(res.clipRepair!.firstError).toMatch(
      /parcel-minus-strips difference threw/,
    );
    expect(res.clipRepair!.firstError).toMatch(/Unable to complete output ring/);
    assertGatePass(PARCEL_KYLE_145880, res.ring!, KYLE_R1A_FEET);
  });

  it("the repair is BOUNDED: the area it induces stays inside the conservation epsilon of the raster oracle", () => {
    const res = insetPerEdge(PARCEL_KYLE_145880, KYLE_R1A_FEET);
    const m2 = res.areaSqFt / (FT_PER_M * FT_PER_M);
    const error = Math.abs(m2 - KYLE_BUILDABLE_ORACLE_M2);
    // Measured 1.5e-5 m² of 0.5 m² allowed; the assertion is the contract, the
    // measurement is what makes it a check rather than a hope.
    expect(error).toBeLessThan(CONSERVATION_EPSILON_M2);
    expect(res.areaSqFt).toBeGreaterThan(3341);
    expect(res.areaSqFt).toBeLessThan(3344);
    expect(res.parcelAreaSqFt).toBeCloseTo(7_477, -1);
  });

  it("FALSIFIER (repair beyond the tolerance): a 0.3 m displacement is rejected by the gate, not served", () => {
    // The other direction of the tolerance above. A repair that moved the ring
    // 0.3 m east would break the exclusion rule by 5.8 m² against a 3.47 m²
    // epsilon — the gate must refuse it. This is the same gate the repaired
    // answer passed, so the check is shown working in both directions.
    const res = insetPerEdge(PARCEL_KYLE_145880, KYLE_R1A_FEET);
    const displaced = geometryCorrectnessGate(
      PARCEL_KYLE_145880,
      shiftKyleRing(res.ring!, 0.3, 0),
      KYLE_R1A_FEET,
    );
    expect(displaced.pass).toBe(false);
    expect(displaced.reasons.some((r) => /overlaps forbidden setback strips/i.test(r))).toBe(
      true,
    );
  });

  it("FALSIFIER: a parcel ring that crosses itself declines at the source, never as a clip failure", () => {
    // Measured before the fix: this ring's clip threw on BOTH operand sets and
    // the payload declined as a clip failure — blaming the library for a ring
    // that is itself the defect. It must be named at the source instead.
    const res = insetPerEdge(SELF_INTERSECT_BOWTIE, [10, 10, 10, 10]);
    expect(res.empty).toBe(true);
    expect(res.ring).toBeNull();
    expect(res.emptyKind).toBe("invalid-input");
    expect(res.emptyReason).toMatch(/self-intersects/i);
    expect(res.emptyReason).toMatch(/served polygon/i);
    expect(res.emptyReason).not.toMatch(/clip failed/i);
  });

  it("parcels that already derived take NO repair and no reprojection drift", () => {
    const simsbrook = insetPerEdge(
      SIMSBROOK_280239,
      simsbrookAsIsFeet(),
    );
    expect(simsbrook.empty, simsbrook.emptyReason).toBe(false);
    expect(simsbrook.clipRepair).toBeUndefined();
    const spring = insetPerEdge(
      PARCEL_714_SPRING_33512,
      projectRing(PARCEL_714_SPRING_33512)!.points.map(() => 15),
    );
    expect(spring.clipRepair).toBeUndefined();
  });
});

describe("ringContainsPoint (P-339/P-366 residual: the point the identity already answers for)", () => {
  // A 1-degree square, closed (first vertex repeated). The test point is well
  // inside it; every probe below moves exactly one thing.
  const square: Ring = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ];
  const inside = { latitude: 0.5, longitude: 0.5 };

  it("true inside, false outside, and a point past every edge is outside", () => {
    expect(ringContainsPoint(square, inside)).toBe(true);
    expect(ringContainsPoint(square, { latitude: 2, longitude: 2 })).toBe(false);
    expect(ringContainsPoint(square, { latitude: 0.5, longitude: -0.5 })).toBe(false);
    expect(ringContainsPoint(square, { latitude: -0.5, longitude: 0.5 })).toBe(false);
  });

  it("a closed ring and the same ring open agree (the repeated first vertex is not a crossing)", () => {
    const open = square.slice(0, -1);
    expect(ringContainsPoint(open, inside)).toBe(ringContainsPoint(square, inside));
    expect(ringContainsPoint(open, inside)).toBe(true);
  });

  it("vertex order does not matter (a reversed ring answers the same)", () => {
    const reversed = [...square].reverse() as Ring;
    expect(ringContainsPoint(reversed, inside)).toBe(true);
    expect(ringContainsPoint(reversed, { latitude: 2, longitude: 2 })).toBe(false);
  });

  it("accepts a lng/lat tuple as well as a {latitude, longitude} point", () => {
    expect(ringContainsPoint(square, [0.5, 0.5])).toBe(true);
    expect(ringContainsPoint(square, [2, 2])).toBe(false);
  });

  it("THE COUNTY-LINE CASE: a point inside BOTH of two overlapping rings answers true for each", () => {
    // Two counties' parcel geometries overlap at the line: the Travis parcel's
    // record point lies inside its own ring AND inside a Hays parcel's ring
    // (measured on 48453:352594). Neither ring can be read as evidence against
    // the other from geometry alone, which is why the identity decides.
    const travis: Ring = [
      [-97.83, 30.09],
      [-97.82, 30.09],
      [-97.82, 30.11],
      [-97.83, 30.11],
      [-97.83, 30.09],
    ];
    const haysOverlap: Ring = [
      [-97.828, 30.099],
      [-97.818, 30.099],
      [-97.818, 30.101],
      [-97.828, 30.101],
      [-97.828, 30.099],
    ];
    const recordPoint = { latitude: 30.1003, longitude: -97.82734 };
    expect(ringContainsPoint(travis, recordPoint)).toBe(true);
    expect(ringContainsPoint(haysOverlap, recordPoint)).toBe(true);
  });

  it("degenerate and unusable rings answer false rather than throwing", () => {
    expect(ringContainsPoint(null, inside)).toBe(false);
    expect(ringContainsPoint(undefined, inside)).toBe(false);
    expect(ringContainsPoint([], inside)).toBe(false);
    expect(ringContainsPoint([[0, 0], [1, 1]], inside)).toBe(false);
    expect(
      ringContainsPoint(square, { latitude: Number.NaN, longitude: 0.5 }),
    ).toBe(false);
  });
});
