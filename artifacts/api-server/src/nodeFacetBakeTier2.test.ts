/**
 * Tier-2 node-facet bake — unit tests after anti-zombie cut (WDLL 3.7).
 * Envelope compute is honest atom_path_pending / no-zoning-stamp only.
 * Flood overlay + monotonic flood guard remain load-bearing.
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

const LNG0 = -97.31;
const LAT0 = 30.11;
const D_LNG = 0.00032;
const D_LAT = 0.00041;
const BASTROP_LOT: Ring = [
  [LNG0, LAT0],
  [LNG0 + D_LNG, LAT0],
  [LNG0 + D_LNG, LAT0 + D_LAT],
  [LNG0, LAT0 + D_LAT],
  [LNG0, LAT0],
];

const ROAD_SOUTH: RoadCandidate = {
  name: "Main Street",
  polyline: [
    [LNG0 - 0.0002, LAT0 - 0.00013],
    [LNG0 + D_LNG + 0.0002, LAT0 - 0.00013],
  ],
};

const envInput = (over: Partial<Parameters<typeof computeTier2Envelope>[0]> = {}) => ({
  ring: BASTROP_LOT,
  zoningCode: "R-MD" as string | null,
  situsCity: "BASTROP",
  situsState: "TX",
  situsAddress: "123 MAIN ST, BASTROP, TX 78602",
  roads: [] as RoadCandidate[],
  refPoint: { lng: LNG0 + D_LNG / 2, lat: LAT0 + D_LAT / 2 },
  roadFetchAttempted: true,
  ...over,
});

describe("Tier-2 envelope slot (anti-zombie / atom_path_pending)", () => {
  it("with zoning stamps atom_path_pending — never multiply confidence", () => {
    const withRoad = computeTier2Envelope(envInput({ roads: [ROAD_SOUTH] }));
    expect(withRoad.status).toBe("declined");
    expect(withRoad.declineReason).toBe("atom_path_pending");
    expect(withRoad.confidence).toBeNull();
    expect(withRoad.roadsPending).toBe(false);
    expect(withRoad.roadProvenance.roadSignalUsed).toBe(false);
  });

  it("absent zoning declines with no-zoning-stamp dialect", () => {
    const env = computeTier2Envelope(
      envInput({ zoningCode: null, roads: [ROAD_SOUTH] }),
    );
    expect(env.status).toBe("declined");
    expect(env.declineReason).toBe("no-zoning-stamp");
    expect(env.district).toBeUndefined();
    expect(env.confidence).toBeNull();
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
    expect(f.baseFloodElevation).toBeNull();
  });

  it("reads a clean empty result as outside-sfha (a real answer, not absence)", () => {
    const f = buildFloodFacet({ features: [] }, nowIso);
    expect(f.status).toBe("outside-sfha");
    expect(f.floodZone).toBeNull();
    expect(f.inSpecialFloodHazardArea).toBe(false);
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

describe("Tier-2 monotonic guard (flood-led after envelope retirement)", () => {
  const nowIso = "2026-07-21T00:00:00.000Z";
  const pendingEnvelope = computeTier2Envelope(envInput({ roads: [ROAD_SOUTH] }));
  const floodReal: Tier2FloodFacet = buildFloodFacet(
    { features: [{ attributes: { FLD_ZONE: "AE", SFHA_TF: "T" } }] },
    nowIso,
  );
  const floodUnavailable: Tier2FloodFacet = buildFloodFacet(null, nowIso);
  const floodOutside: Tier2FloodFacet = buildFloodFacet({ features: [] }, nowIso);

  it("promotes onto an empty prior (new node)", () => {
    expect(
      shouldPromoteTier2(null, { envelope: pendingEnvelope, flood: floodReal }),
    ).toBe(true);
  });

  it("does NOT let a re-bake FEMA outage downgrade a real prior flood reading", () => {
    const prior = { envelope: pendingEnvelope, flood: floodReal };
    const next = { envelope: pendingEnvelope, flood: floodUnavailable };
    expect(tier2FacetScore(next)).toBeLessThan(tier2FacetScore(prior));
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
