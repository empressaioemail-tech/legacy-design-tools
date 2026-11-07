/**
 * P-235 — the drawn envelope must never enter a setback at a ring joint.
 *
 * THE PREDICATE, and why it is meaning shaped. The envelope ring comes out of
 * the boolean clip (polygon-clipping over the per-edge forbidden regions). This
 * test re-derives the SAME question a completely different way — point-to-
 * segment distance, plain trigonometry, no boolean op — and asks whether the
 * two agree. That is the second, independent derivation the enforcement
 * doctrine requires: no sentinel, no defaulted field, and no single party can
 * satisfy both halves. The conservation gate already in `geometry.ts` cannot do
 * this job, because BOTH of its inputs are computed from `buildForbiddenStrips`
 * — it is internal consistency, and it passed happily while the envelope ran
 * all the way to the front property line.
 *
 * THE RULE BEING CHECKED is the ordinance's own: no part of the buildable area
 * lies within `d_i` feet of boundary edge `i`. So for every envelope vertex `v`
 * and every parcel edge `i`, `dist(v, edge_i) >= d_i`.
 *
 * THE INSTRUMENT IS VERIFIED BY VIOLATION in the final case below: the same
 * predicate is run against the parcel ring passed off as its own envelope and
 * must FAIL. A check observed only passing has not been observed working.
 */

import { describe, expect, it } from "vitest";
import { feetToMeters, insetPerEdge, projectRing, type Ring } from "./geometry";
import {
  PARCEL_1700_SYLVAN_285377,
  PARCEL_2407_PRINCETON_289990,
  PARCEL_704_WICKFORD_CIR_284527,
} from "./fixtures/parcelRings";

/**
 * Slack allowed between the applied setback and the measured clearance, in
 * metres. The end caps inscribe the true arc, so a joint can fall short by at
 * most d*(1-cos(3 deg)) ~ 1 cm on a 25 ft setback; 5 cm covers that plus clip
 * noise. The defect this guards against measured 7.62 m, so the tolerance is
 * nowhere near load bearing.
 */
const CLEARANCE_TOLERANCE_M = 0.05;

interface XY {
  x: number;
  y: number;
}

function distToSegment(p: XY, a: XY, b: XY): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  let t = len2 < 1e-12 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}

/**
 * For every vertex of `candidateRing`, the WORST shortfall against the per-edge
 * setback of `parcelRing`, in feet. Positive means the candidate intrudes into
 * a setback by that many feet. Returns the worst offender so a failure names
 * the edge and the depth rather than just reporting false.
 */
function worstSetbackIntrusionFt(
  parcelRing: Ring,
  candidateRing: Ring,
  insetFeetPerEdge: number[],
): { ft: number; edge: number; appliedFt: number; clearanceFt: number } {
  const proj = projectRing(parcelRing);
  if (!proj) throw new Error("parcel ring did not project");
  const P = proj.points;
  const n = P.length;
  if (insetFeetPerEdge.length !== n) {
    throw new Error(
      `fixture setback count ${insetFeetPerEdge.length} != ring edges ${n}`,
    );
  }
  const C: XY[] = candidateRing.map(([lng, lat]) => ({
    x: (lng - proj.originLng) * proj.mPerDegLng,
    y: (lat - proj.originLat) * proj.mPerDegLat,
  }));

  let worst = { ft: -Infinity, edge: -1, appliedFt: 0, clearanceFt: 0 };
  for (const v of C) {
    for (let i = 0; i < n; i++) {
      const requiredM = feetToMeters(insetFeetPerEdge[i]!);
      if (requiredM <= 0) continue;
      const clearanceM = distToSegment(v, P[i]!, P[(i + 1) % n]!);
      const shortfallFt = (requiredM - clearanceM) * 3.280839895;
      if (shortfallFt > worst.ft) {
        worst = {
          ft: shortfallFt,
          edge: i,
          appliedFt: insetFeetPerEdge[i]!,
          clearanceFt: clearanceM * 3.280839895,
        };
      }
    }
  }
  return worst;
}

/** Ring edges either side of a reflex joint — the digitized arc of a curve. */
function curvedRunEdges(ring: Ring): number[] {
  const P = projectRing(ring)!.points;
  const n = P.length;
  const out = new Set<number>();
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n]!;
    const v = P[i]!;
    const b = P[(i + 1) % n]!;
    const u1 = { x: v.x - a.x, y: v.y - a.y };
    const u2 = { x: b.x - v.x, y: b.y - v.y };
    if (Math.hypot(u1.x, u1.y) < 1e-9 || Math.hypot(u2.x, u2.y) < 1e-9) continue;
    if (u1.x * u2.y - u1.y * u2.x < 0) {
      out.add((i - 1 + n) % n);
      out.add(i);
    }
  }
  return [...out].sort((x, y) => x - y);
}

function wickfordFrontEdges(): number[] {
  return curvedRunEdges(PARCEL_704_WICKFORD_CIR_284527);
}

function wickfordSetbacks(): number[] {
  const proj = projectRing(PARCEL_704_WICKFORD_CIR_284527)!;
  const front = new Set(wickfordFrontEdges());
  return proj.points.map((_, i) => (front.has(i) ? 25 : 5));
}

/**
 * Austin SF-3 as the live route resolves it (front 25 / side 5 / rear 10),
 * mapped onto each fixture ring. Held as literals (or as a stated structural
 * rule) so this test measures the GEOMETRY and nothing else: a labeling change
 * cannot quietly move it.
 */
const CASES: {
  name: string;
  ring: Ring;
  insetFeet: number[];
  frontEdges: number[];
}[] = [
  {
    // The named P-235 parcel. Princeton Drive curves here and the frontage is
    // digitized as four near-collinear chords (ring edges 2,3,4,5) with a
    // REFLEX joint at vertex 4 — the joint the old rectangle-only forbidden
    // region failed to cover. These labels are the ones the live road-signal
    // labeler produced for this ring.
    name: "48453:289990 2407 Princeton Dr (curved frontage, reflex joint)",
    ring: PARCEL_2407_PRINCETON_289990,
    insetFeet: [5, 5, 25, 25, 25, 25, 5, 10, 10],
    frontEdges: [2, 3, 4, 5],
  },
  {
    // Straight-frontage control: four vertices, ZERO reflex joints. The end
    // caps are provably inert here, so this ring must be untouched by the fix.
    name: "48453:285377 1700 Sylvan Dr (straight frontage control)",
    ring: PARCEL_1700_SYLVAN_285377,
    insetFeet: [25, 5, 10, 5],
    frontEdges: [0],
  },
  {
    // Second curved frontage, chosen structurally (highest total reflex turn
    // among residential-scale parcels in an 869-parcel screen of south Austin),
    // not by resemblance to the first. A radius street: 44 ring vertices, 17
    // reflex joints totalling 171 degrees.
    name: "48453:284527 704 Wickford Cir (radius street, 17 reflex joints)",
    ring: PARCEL_704_WICKFORD_CIR_284527,
    insetFeet: wickfordSetbacks(),
    frontEdges: wickfordFrontEdges(),
  },
];

describe("P-235 — per-edge setback regions must join at ring vertices", () => {
  for (const c of CASES) {
    it(`${c.name}: the drawn envelope clears every setback`, () => {
      const out = insetPerEdge(c.ring, c.insetFeet);
      expect(out.empty).toBe(false);
      expect(out.ring).not.toBeNull();

      const worst = worstSetbackIntrusionFt(c.ring, out.ring!, c.insetFeet);
      const detail =
        `worst intrusion ${worst.ft.toFixed(2)} ft at ring edge ${worst.edge} ` +
        `(applied ${worst.appliedFt} ft, measured clearance ` +
        `${worst.clearanceFt.toFixed(2)} ft); front edges ${c.frontEdges.join(",")}`;
      expect(worst.ft, detail).toBeLessThanOrEqual(
        CLEARANCE_TOLERANCE_M * 3.280839895,
      );
    });
  }

  it("the predicate is not vacuous: the parcel ring fails its own setbacks", () => {
    // Verify by violation. The parcel boundary passed off as its own envelope
    // is 0 ft from every edge, so a working predicate must report the full
    // front setback as the intrusion. If this ever passes, the cases above are
    // measuring nothing.
    const worst = worstSetbackIntrusionFt(
      PARCEL_2407_PRINCETON_289990,
      PARCEL_2407_PRINCETON_289990,
      [5, 5, 25, 25, 25, 25, 5, 10, 10],
    );
    expect(worst.ft).toBeGreaterThan(24);
  });
});
