/**
 * Tier-1 node-facet bake — unit tests (pure, offline, no DB).
 *
 * Covers the four load-bearing guarantees the dispatch calls out:
 *   1. MONOTONIC guard — a worse re-bake never overwrites the better prior.
 *   2. OWNER EXCLUSION — the payload never contains owner_name (nor any
 *      `owner*` key), and the row shape the bake selects has no owner field.
 *   3. HONEST ABSENCE — null zoning / null land-use / unknown jurisdiction
 *      store as absent (null / declined), never fabricated.
 *   4. ACREAGE shoelace correctness on a known-size polygon.
 */

import { describe, it, expect } from "vitest";
import {
  parcelAcreage,
  ringCentroid,
  computeTier1Envelope,
  type Ring,
} from "./lib/nodeFacetBakeTier1";
import {
  buildTier1Payload,
  firstRing,
  facetScore,
  shouldPromote,
  type Tier1FacetPayload,
} from "./nodeFacetBakeTier1Cli";

// A ~100ft x 150ft rectangular lot near Bastrop, TX. At lat 30.11:
//   1 deg lat ~ 364,000 ft, 1 deg lng ~ 314,000 ft.
//   dLng 0.00032 deg ~ 100.5 ft, dLat 0.00041 deg ~ 149.2 ft -> ~14,995 sqft.
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

function polygonGeometry(ring: Ring): unknown {
  return { type: "Polygon", coordinates: [ring] };
}

/** A parcel row as the bake selects it — NOTE: no owner field exists. */
function parcelRow(overrides: Partial<{
  feature_index: number;
  prop_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  zoning_district: string | null;
  source_vintage: string | null;
  geometry: unknown;
}> = {}) {
  return {
    feature_index: 0,
    prop_id: "R12345",
    situs_address: "123 MAIN ST, BASTROP, TX 78602",
    situs_city: "BASTROP",
    situs_state: "TX",
    zoning_district: null,
    source_vintage: "stratmap25",
    geometry: polygonGeometry(BASTROP_LOT),
    ...overrides,
  };
}

describe("acreage (shoelace) correctness", () => {
  it("computes a known ~100x150ft lot to ~0.344 acre within tolerance", () => {
    const a = parcelAcreage(BASTROP_LOT);
    expect(a).not.toBeNull();
    // Expected ~14,995 sqft; allow 3% for the equirectangular projection.
    expect(a!.sqft).toBeGreaterThan(14_500);
    expect(a!.sqft).toBeLessThan(15_500);
    expect(a!.value).toBeCloseTo(a!.sqft / 43_560, 3);
    expect(a!.method).toBe("shoelace-wgs84");
  });

  it("is orientation-independent (CW ring gives the same positive area)", () => {
    const cw = [...BASTROP_LOT].reverse();
    const a = parcelAcreage(BASTROP_LOT);
    const b = parcelAcreage(cw);
    expect(b!.sqft).toBe(a!.sqft);
  });

  it("returns null (honest absence) for a degenerate zero-area ring", () => {
    const degenerate: Ring = [
      [LNG0, LAT0],
      [LNG0, LAT0],
      [LNG0, LAT0],
      [LNG0, LAT0],
    ];
    expect(parcelAcreage(degenerate)).toBeNull();
  });

  it("centroid falls inside the lot bbox", () => {
    const c = ringCentroid(BASTROP_LOT);
    expect(c.lng).toBeGreaterThan(LNG0);
    expect(c.lng).toBeLessThan(LNG0 + D_LNG);
    expect(c.lat).toBeGreaterThan(LAT0);
    expect(c.lat).toBeLessThan(LAT0 + D_LAT);
  });
});

describe("firstRing", () => {
  it("extracts the outer ring of a Polygon", () => {
    const r = firstRing(polygonGeometry(BASTROP_LOT));
    expect(r).toHaveLength(BASTROP_LOT.length);
  });
  it("extracts the first outer ring of a MultiPolygon", () => {
    const mp = { type: "MultiPolygon", coordinates: [[BASTROP_LOT]] };
    expect(firstRing(mp)).toHaveLength(BASTROP_LOT.length);
  });
  it("returns null for non-polygon / degenerate geometry", () => {
    expect(firstRing(null)).toBeNull();
    expect(firstRing({ type: "Point", coordinates: [0, 0] })).toBeNull();
    expect(firstRing({ type: "Polygon", coordinates: [[[0, 0]]] })).toBeNull();
  });
});

describe("owner exclusion (privacy gate)", () => {
  const now = new Date().toISOString();

  it("payload JSON contains no owner* key even when a row carried one", () => {
    // Simulate a row object that ALSO carries owner_name (as the raw table
    // does) — the bake's ParcelRow shape omits it, but prove defensively that
    // nothing owner-shaped reaches the payload.
    const row = { ...parcelRow(), owner_name: "JANE Q PUBLIC" } as ReturnType<
      typeof parcelRow
    >;
    const payload = buildTier1Payload(row, "48021", "Bastrop", new Map(), now);
    expect(payload).not.toBeNull();
    const json = JSON.stringify(payload);
    expect(/owner/i.test(json)).toBe(false);
    expect(json).not.toContain("JANE Q PUBLIC");
  });

  it("never surfaces owner via any nested facet", () => {
    const payload = buildTier1Payload(parcelRow(), "48021", "Bastrop", new Map(), now)!;
    // Walk every value; none may be an owner-looking key.
    const keys: string[] = [];
    const walk = (o: unknown) => {
      if (o && typeof o === "object") {
        for (const [k, v] of Object.entries(o)) {
          keys.push(k);
          walk(v);
        }
      }
    };
    walk(payload);
    expect(keys.some((k) => /owner/i.test(k))).toBe(false);
  });
});

describe("honest absence (never fabricate a facet)", () => {
  const now = new Date().toISOString();

  it("null land-use (e.g. Comal, no CAD roll) stores landUse:null, coverage false", () => {
    // Empty land-use map == no CAD roll loaded for the county.
    const payload = buildTier1Payload(parcelRow(), "48091", "Comal", new Map(), now)!;
    expect(payload.baseFacts.landUse).toBeNull();
    expect(payload.facetCoverage.landUse).toBe(false);
    expect(payload.provenance.landUseSource).toBeNull();
  });

  it("null zoning stores zoning:null, coverage false (not fabricated)", () => {
    const payload = buildTier1Payload(
      parcelRow({ zoning_district: null }),
      "48021",
      "Bastrop",
      new Map(),
      now,
    )!;
    expect(payload.zoning).toBeNull();
    expect(payload.facetCoverage.zoning).toBe(false);
  });

  it("real zoning is read verbatim from the stored column", () => {
    const payload = buildTier1Payload(
      parcelRow({ zoning_district: "SF-1" }),
      "48021",
      "Bastrop",
      new Map(),
      now,
    )!;
    expect(payload.zoning).toEqual({ district: "SF-1" });
    expect(payload.facetCoverage.zoning).toBe(true);
  });

  it("land-use joins via normalizeForJoin (R-prefix fix) when a coded row exists", () => {
    // TxGIO prop_id "R12345" must join a cad row keyed bare-numeric "12345".
    const lu = new Map([["12345", { landUseCode: "A1", landUseVintage: "2025" }]]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R12345" }),
      "48021",
      "Bastrop",
      lu,
      now,
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("A1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll");
    expect(payload.facetCoverage.landUse).toBe(true);
  });

  it("unknown jurisdiction declines the envelope (no fabricated setbacks)", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: null,
      situsCity: "Nowhereville",
      situsState: "TX",
      situsAddress: null,
    });
    expect(env.status).toBe("declined");
    expect(env.declineReason).toBeTruthy();
    expect(env.setbacks).toBeUndefined();
  });

  it("a parcel with no prop_id is not baked (no fabricated node id)", () => {
    const payload = buildTier1Payload(
      parcelRow({ prop_id: null }),
      "48021",
      "Bastrop",
      new Map(),
      now,
    );
    expect(payload).toBeNull();
  });
});

describe("Tier-1 envelope (skipRoad / provisional)", () => {
  it("derives a provisional, roads-pending, shape-signal envelope for a known city", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: null,
      situsCity: "Bastrop",
      situsState: "TX",
      situsAddress: "123 MAIN ST, BASTROP, TX 78602",
    });
    expect(env.status).toBe("ok");
    expect(env.provisional).toBe(true);
    expect(env.roadsPending).toBe(true);
    // Shape-only labeling (no roads) => the low-confidence approximate path.
    expect(env.edgeSignal).toBe("shape");
    expect(env.approximate).toBe(true);
    expect(env.confidence).toBeGreaterThan(0);
    expect(env.confidence).toBeLessThan(0.7);
    expect(env.setbacks).toBeDefined();
    expect(env.buildableAreaSqFt).toBeGreaterThan(0);
  });
});

describe("monotonic high-water-mark guard (verify-before-promote)", () => {
  const now = new Date().toISOString();
  const county = { fips: "48021", name: "Bastrop" };

  const fullPayload = () =>
    buildTier1Payload(
      parcelRow({ zoning_district: "SF-1" }),
      county.fips,
      county.name,
      new Map([["12345", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
    )!;

  const strippedPayload = () =>
    // Same parcel, but a WORSE re-computation: no zoning, no land-use.
    buildTier1Payload(
      parcelRow({ zoning_district: null }),
      county.fips,
      county.name,
      new Map(),
      now,
    )!;

  it("full payload scores strictly higher than a stripped one", () => {
    expect(facetScore(fullPayload())).toBeGreaterThan(facetScore(strippedPayload()));
  });

  it("promotes a NEW node (no prior)", () => {
    expect(shouldPromote(null, fullPayload())).toBe(true);
  });

  it("promotes an UPGRADE (more facets than prior)", () => {
    expect(shouldPromote(strippedPayload(), fullPayload())).toBe(true);
  });

  it("REJECTS a downgrade — a worse re-bake never overwrites the better prior", () => {
    expect(shouldPromote(fullPayload(), strippedPayload())).toBe(false);
  });

  it("promotes an equal-quality refresh (idempotent re-run is safe)", () => {
    expect(shouldPromote(fullPayload(), fullPayload())).toBe(true);
  });

  it("at equal facet count, higher envelope confidence wins; lower is rejected", () => {
    const base = fullPayload();
    const higher: Tier1FacetPayload = {
      ...base,
      envelope: { ...base.envelope!, confidence: 0.9 },
    };
    const lower: Tier1FacetPayload = {
      ...base,
      envelope: { ...base.envelope!, confidence: 0.1 },
    };
    expect(shouldPromote(lower, higher)).toBe(true);
    expect(shouldPromote(higher, lower)).toBe(false);
  });
});
