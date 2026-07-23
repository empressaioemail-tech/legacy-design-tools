/**
 * Tier-2 node-facet bake — unit tests (pure, offline, no DB, no network).
 *
 * Covers the load-bearing guarantees the dispatch calls out:
 *   1. ENVELOPE UPGRADE — a road candidate lifts the front-edge signal from
 *      the Tier-1 shape guess (low) to the road signal (high), and higher
 *      confidence PROMOTES over a lower-confidence prior (monotonic guard).
 *   2. HONEST DEGRADATION — an empty road fetch degrades to the centroid
 *      (point) signal, and with no point falls to shape; the facet records
 *      which signal actually fired (never a fabricated road front).
 *   3. FEMA — a real NFHL hit attaches the zone (SFHA and non-SFHA); a clean
 *      empty result reads `outside-sfha` (a real answer); a FAILED fetch reads
 *      `unavailable` (honest absence, never a fabricated zone).
 *   4. MONOTONIC — a worse Tier-2 re-bake (a FEMA outage that would downgrade a
 *      real prior reading; a road fetch that this time failed) never overwrites
 *      the better prior.
 *   5. OWNER EXCLUSION — the Tier-2 payload shape carries no owner field.
 */

import { describe, it, expect } from "vitest";
import {
  computeTier2Envelope,
  buildFloodFacet,
  tier2FacetScore,
  type Tier2FloodFacet,
  type FemaQueryLike,
} from "./lib/nodeFacetBakeTier2";
import { shouldPromoteTier2 } from "./nodeFacetBakeTier2Cli";
import type { Ring } from "./lib/nodeFacetBakeTier1";
import type { RoadCandidate } from "./lib/buildableEnvelope/edgeLabeling";

// A ~100ft x 150ft rectangular lot in Bastrop, TX (bastrop-tx has a real
// codified setback table, so the envelope resolves to `ok`, not `declined`).
const LNG0 = -97.31;
const LAT0 = 30.11;
const D_LNG = 0.00032; // ~100 ft E-W (the two SHORT edges front/rear)
const D_LAT = 0.00041; // ~149 ft N-S (the two LONG edges = sides)
const BASTROP_LOT: Ring = [
  [LNG0, LAT0],
  [LNG0 + D_LNG, LAT0],
  [LNG0 + D_LNG, LAT0 + D_LAT],
  [LNG0, LAT0 + D_LAT],
  [LNG0, LAT0],
];

// A road running E-W just SOUTH of the lot's southern (short) edge, ~15 m off.
// The southern edge midpoint is at (LAT0, LNG0 + D_LNG/2); place the road ~15 m
// south of it (0.00013 deg lat ~ 14 m) so bestEdgeForRoad's 45 m trust gate
// passes and the south edge is chosen as the front.
const ROAD_SOUTH: RoadCandidate = {
  name: "Main Street",
  polyline: [
    [LNG0 - 0.0002, LAT0 - 0.00013],
    [LNG0 + D_LNG + 0.0002, LAT0 - 0.00013],
  ],
};

const envInput = (over: Partial<Parameters<typeof computeTier2Envelope>[0]> = {}) => ({
  ring: BASTROP_LOT,
  // Matched district so road/point/shape tests are not conflated with
  // absent-zoning honesty (null zoning → declined no-zoning-stamp).
  zoningCode: "R-MD" as string | null,
  situsCity: "BASTROP",
  situsState: "TX",
  situsAddress: "123 MAIN ST, BASTROP, TX 78602",
  roads: [] as RoadCandidate[],
  refPoint: { lng: LNG0 + D_LNG / 2, lat: LAT0 + D_LAT / 2 },
  roadFetchAttempted: true,
  ...over,
});

describe("Tier-2 envelope upgrade (road-based labeling)", () => {
  it("a nearby road fires the HIGH-confidence road signal and beats the shape guess", () => {
    const withRoad = computeTier2Envelope(envInput({ roads: [ROAD_SOUTH] }));
    const shapeOnly = computeTier2Envelope(
      envInput({ roads: [], refPoint: null }),
    );

    expect(withRoad.status).toBe("ok");
    expect(withRoad.edgeSignal).toBe("road");
    expect(withRoad.roadsPending).toBe(false);
    expect(withRoad.roadProvenance.roadSignalUsed).toBe(true);
    expect(withRoad.roadProvenance.candidateCount).toBe(1);

    expect(shapeOnly.edgeSignal).toBe("shape");
    // The whole point of Tier 2: the road-labeled envelope is MORE confident
    // than the Tier-1-grade shape guess, so it promotes.
    expect(withRoad.confidence).toBeGreaterThan(shapeOnly.confidence);
  });

  it("degrades HONESTLY to the point signal when the road fetch was empty", () => {
    const pointOnly = computeTier2Envelope(
      envInput({ roads: [] }), // refPoint present (centroid) -> point signal
    );
    expect(pointOnly.status).toBe("ok");
    expect(pointOnly.edgeSignal).toBe("point");
    expect(pointOnly.roadsPending).toBe(false);
    // A failed/empty road fetch never fabricates a road front.
    expect(pointOnly.roadProvenance.roadSignalUsed).toBe(false);
    expect(pointOnly.roadProvenance.candidateCount).toBe(0);
    expect(pointOnly.roadProvenance.fetchAttempted).toBe(true);
  });

  it("degrades to the shape signal (provisional) with no road and no point", () => {
    const shapeOnly = computeTier2Envelope(
      envInput({ roads: [], refPoint: null }),
    );
    expect(shapeOnly.edgeSignal).toBe("shape");
    // Shape-only is the Tier-1-grade guess: still provisional (roads didn't help).
    expect(shapeOnly.provisional).toBe(true);
    expect(shapeOnly.roadProvenance.roadSignalUsed).toBe(false);
  });

  it("absent zoning declines with road estimate — does not stamp a district", () => {
    const env = computeTier2Envelope(
      envInput({ zoningCode: null, roads: [ROAD_SOUTH] }),
    );
    expect(env.status).toBe("declined");
    expect(env.declineReason).toBe("no-zoning-stamp");
    expect(env.district).toBeUndefined();
    expect(env.edgeSignal).toBe("road");
    expect(env.setbacks).toBeDefined();
    expect(env.geojson).toBeDefined();
    expect(JSON.stringify(env.geojson)).toMatch(/conservative-estimate/);
  });

  it("DECLINES honestly for a jurisdiction with no codified setback table", () => {
    const declined = computeTier2Envelope(
      envInput({ situsCity: "NOWHERE", situsState: "ZZ", situsAddress: null }),
    );
    expect(declined.status).toBe("declined");
    expect(declined.confidence).toBe(0);
    expect(declined.roadsPending).toBe(false);
    expect(declined.roadProvenance.roadSignalUsed).toBe(false);
  });

  it("maps Bastrop B3 P-5 to its cited Core row, not legacy Public/Institutional", () => {
    const envelope = computeTier2Envelope(envInput({ zoningCode: "P-5" }));
    expect(envelope.status).toBe("ok");
    expect(envelope.jurisdictionKey).toBe("bastrop_tx");
    expect(envelope.district).toBe("P-5 Core");
    expect(envelope.district).not.toBe("P Public/Institutional");
    expect(envelope.setbacks).toEqual({
      front_ft: 15,
      side_ft: 0,
      rear_ft: 0,
    });
  });
});

describe("Tier-2 FEMA flood facet", () => {
  const nowIso = "2026-07-21T00:00:00.000Z";

  it("attaches an SFHA zone from a real NFHL hit", () => {
    const q: FemaQueryLike = {
      features: [
        {
          attributes: {
            FLD_ZONE: "AE",
            ZONE_SUBTY: "FLOODWAY",
            SFHA_TF: "T",
            STATIC_BFE: 512.4,
          },
        },
      ],
    };
    const f = buildFloodFacet(q, nowIso);
    expect(f.status).toBe("in-sfha");
    expect(f.floodZone).toBe("AE");
    expect(f.inSpecialFloodHazardArea).toBe(true);
    expect(f.zoneSubtype).toBe("FLOODWAY");
    expect(f.baseFloodElevation).toBe(512.4);
    expect(f.provenance.source).toBe("fema-nfhl");
    expect(f.provenance.vintage).toBe(nowIso);
  });

  it("classifies a non-SFHA mapped zone (X shaded) as flood-zone, not in-sfha", () => {
    const q: FemaQueryLike = {
      features: [
        {
          attributes: {
            FLD_ZONE: "X",
            ZONE_SUBTY: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
            SFHA_TF: "F",
            STATIC_BFE: -9999,
          },
        },
      ],
    };
    const f = buildFloodFacet(q, nowIso);
    expect(f.status).toBe("flood-zone");
    expect(f.floodZone).toBe("X");
    expect(f.inSpecialFloodHazardArea).toBe(false);
    // -9999 is FEMA's "no BFE" sentinel — never surfaced as a real elevation.
    expect(f.baseFloodElevation).toBeNull();
  });

  it("reads a clean empty result as outside-sfha (a real answer, not absence)", () => {
    const f = buildFloodFacet({ features: [] }, nowIso);
    expect(f.status).toBe("outside-sfha");
    expect(f.floodZone).toBeNull();
    expect(f.inSpecialFloodHazardArea).toBe(false);
    // NOT unavailable — the query succeeded.
    expect(f.provenance.unavailableReason).toBeUndefined();
  });

  it("reads a FAILED fetch (null) as unavailable — honest absence, never a zone", () => {
    const f = buildFloodFacet(null, nowIso, "FEMA NFHL point query failed");
    expect(f.status).toBe("unavailable");
    expect(f.floodZone).toBeNull();
    expect(f.inSpecialFloodHazardArea).toBeNull();
    expect(f.provenance.unavailableReason).toContain("failed");
  });
});

describe("Tier-2 monotonic guard (shouldPromoteTier2)", () => {
  const nowIso = "2026-07-21T00:00:00.000Z";
  const okEnvelope = computeTier2Envelope(envInput({ roads: [ROAD_SOUTH] }));
  const shapeEnvelope = computeTier2Envelope(
    envInput({ roads: [], refPoint: null }),
  );
  const floodReal: Tier2FloodFacet = buildFloodFacet(
    { features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }] },
    nowIso,
  );
  const floodUnavailable: Tier2FloodFacet = buildFloodFacet(null, nowIso);
  const floodOutside: Tier2FloodFacet = buildFloodFacet({ features: [] }, nowIso);

  it("promotes onto an empty prior (new node)", () => {
    expect(
      shouldPromoteTier2(null, { envelope: okEnvelope, flood: floodReal }),
    ).toBe(true);
  });

  it("promotes a higher-confidence (road) envelope over a lower (shape) prior", () => {
    const prior = { envelope: shapeEnvelope, flood: floodOutside };
    const next = { envelope: okEnvelope, flood: floodOutside };
    expect(tier2FacetScore(next)).toBeGreaterThan(tier2FacetScore(prior));
    expect(shouldPromoteTier2(prior, next)).toBe(true);
  });

  it("does NOT let a re-bake FEMA outage downgrade a real prior flood reading", () => {
    const prior = { envelope: okEnvelope, flood: floodReal };
    // The re-run's FEMA fetch failed -> unavailable. That is a WORSE payload
    // (a resolved facet dropped to absence); the guard keeps the real prior.
    const next = { envelope: okEnvelope, flood: floodUnavailable };
    expect(tier2FacetScore(next)).toBeLessThan(tier2FacetScore(prior));
    expect(shouldPromoteTier2(prior, next)).toBe(false);
  });

  it("does NOT let a re-bake road-fetch failure downgrade a road envelope", () => {
    const prior = { envelope: okEnvelope, flood: floodOutside };
    // The re-run's road fetch failed -> the envelope fell back to shape (lower
    // confidence). Same facet count, lower confidence -> kept prior.
    const next = { envelope: shapeEnvelope, flood: floodOutside };
    expect(shouldPromoteTier2(prior, next)).toBe(false);
  });

  it("an outside-sfha flood counts as a resolved facet (outscores unavailable)", () => {
    const withReal = { envelope: null, flood: floodOutside };
    const withAbsent = { envelope: null, flood: floodUnavailable };
    expect(tier2FacetScore(withReal)).toBeGreaterThan(
      tier2FacetScore(withAbsent),
    );
  });
});

describe("Tier-2 owner exclusion", () => {
  it("the composed facet payload carries no owner key anywhere", () => {
    const envelope = computeTier2Envelope(envInput({ roads: [ROAD_SOUTH] }));
    const flood = buildFloodFacet(
      { features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }] },
      "2026-07-21T00:00:00.000Z",
    );
    const json = JSON.stringify({ envelope, flood });
    expect(/"owner/i.test(json)).toBe(false);
  });
});
