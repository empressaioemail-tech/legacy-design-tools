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
  effectiveBlockedFips,
  firstRing,
  facetScore,
  shouldPromote,
  decidePagePromotions,
  chunkItems,
  BATCH_WRITE_CHUNK,
  type Tier1FacetPayload,
  type ComputedNode,
} from "./nodeFacetBakeTier1Cli";
import { LANDUSE_JOIN_DISABLED_FIPS_SEED } from "./lib/joinNormalize";
import type { AddressLandUseEntry } from "./lib/joinIntegrityGate";

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

/**
 * A parcel row as the bake selects it. `txgioOwnerForGate` is present ONLY for
 * the address-recovery owner gate (never persisted to the payload); it is null
 * by default so a normal county row carries no owner.
 */
function parcelRow(overrides: Partial<{
  feature_index: number;
  prop_id: string | null;
  situs_address: string | null;
  situs_city: string | null;
  situs_state: string | null;
  zoning_district: string | null;
  source_vintage: string | null;
  geometry: unknown;
  txgioOwnerForGate: string | null;
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
    txgioOwnerForGate: null,
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

  it("land-use joins on the bare-numeric key for a REAL county (Bastrop)", () => {
    // TxGIO prop_id "012345" (leading zeros) joins a cad row keyed "12345".
    const lu = new Map([["12345", { landUseCode: "A1", landUseVintage: "2025" }]]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "012345" }),
      "48021",
      "Bastrop",
      lu,
      now,
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("A1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll");
    expect(payload.facetCoverage.landUse).toBe(true);
  });

  it("Williamson (48491) bakes landUse:null even when a colliding cad row exists (gate)", () => {
    // The fabrication bug: TxGIO "R062578" R-stripped to "62578" and collided
    // with an unrelated CAD account. The gate now refuses the join, so the
    // node bakes honest land-use absence, NOT the colliding code.
    const lu = new Map([["62578", { landUseCode: "A1", landUseVintage: "2025" }]]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R062578" }),
      "48491",
      "Williamson",
      lu,
      now,
    )!;
    expect(payload.baseFacts.landUse).toBeNull();
    expect(payload.facetCoverage.landUse).toBe(false);
    expect(payload.provenance.landUseSource).toBeNull();
  });

  it("Hays (48209) bakes landUse:null even when a colliding cad row exists (gate)", () => {
    const lu = new Map([["13599", { landUseCode: "A1", landUseVintage: "2025" }]]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "13599" }),
      "48209",
      "Hays",
      lu,
      now,
    )!;
    expect(payload.baseFacts.landUse).toBeNull();
    expect(payload.facetCoverage.landUse).toBe(false);
    expect(payload.provenance.landUseSource).toBeNull();
  });
});

describe("Bastrop B3 place types", () => {
  it("maps P-5 to the cited B3 Core row, not legacy Public/Institutional", () => {
    const envelope = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: "P-5",
      situsCity: "Bastrop",
      situsState: "TX",
      situsAddress: "123 MAIN ST, BASTROP, TX 78602",
    });

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

describe("situs-address land-use recovery (gate-blocked counties, per-match owner gate)", () => {
  const now = "2026-07-21T00:00:00.000Z";
  const seed = LANDUSE_JOIN_DISABLED_FIPS_SEED;

  // The CAD roll keyed by NORMALIZED situs address (upper + strip non-alnum).
  // "123 MAIN ST, BASTROP, TX 78602" -> "123MAINSTBASTROPTX78602".
  const addrKey = "123MAINSTBASTROPTX78602";
  const addrLookup = (owner: string | null): Map<string, AddressLandUseEntry> =>
    new Map([[addrKey, { code: "F1", vintage: "2025", owner }]]);

  it("RECOVERS land-use for Williamson via the address join when owners AGREE", () => {
    // prop_id join is blocked (colliding cad row present but gated off); the
    // address join recovers, and the TxGIO owner agrees with the CAD owner.
    const propIdColliding = new Map([
      ["62578", { landUseCode: "WRONG", landUseVintage: "2025" }],
    ]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R062578", txgioOwnerForGate: "PURVIS, MICHAEL" }),
      "48491",
      "Williamson",
      propIdColliding,
      now,
      seed,
      addrLookup("PURVIS MICHAEL"),
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("F1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll-address-join");
    expect(payload.facetCoverage.landUse).toBe(true);
    // The colliding prop_id code must NOT have been used.
    expect(payload.baseFacts.landUse?.code).not.toBe("WRONG");
  });

  it("stamps the address-join provenance flag distinguishing it from a prop_id join", () => {
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R062578", txgioOwnerForGate: "PURVIS MICHAEL" }),
      "48491",
      "Williamson",
      new Map(),
      now,
      seed,
      addrLookup("PURVIS, MICHAEL J"),
    )!;
    expect(payload.provenance.landUseSource).toBe("cad-roll-address-join");
    expect(payload.provenance.landUseAddressRecovered).toBe(true);
    expect(payload.provenance.landUseGateBlocked).toBe(true);
  });

  it("REJECTS the address match when owners DISAGREE -> honest null (never the wrong code)", () => {
    // Address matches, but the TxGIO owner (BREM) and CAD owner (PURVIS) are
    // different people. This is the exact fabrication shape the system stops:
    // honest null, NOT code "F1".
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R062578", txgioOwnerForGate: "BREM SARAH" }),
      "48491",
      "Williamson",
      new Map(),
      now,
      seed,
      addrLookup("PURVIS MICHAEL"),
    )!;
    expect(payload.baseFacts.landUse).toBeNull();
    expect(payload.facetCoverage.landUse).toBe(false);
    expect(payload.provenance.landUseSource).toBeNull();
    expect(payload.provenance.landUseAddressRecovered).toBe(false);
  });

  it("recovers Hays (48209) the same way (address join + owner agree)", () => {
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "13599", txgioOwnerForGate: "ACME HOLDINGS LLC" }),
      "48209",
      "Hays",
      new Map(),
      now,
      seed,
      addrLookup("ACME HOLDINGS INC"),
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("F1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll-address-join");
    expect(payload.provenance.landUseAddressRecovered).toBe(true);
  });

  it("does NOT run the address join for a NON-blocked county — prop_id path unchanged", () => {
    // Bexar joins on prop_id. Even if an address lookup is (spuriously) passed,
    // addressJoinKey returns null for a non-blocked county, so the prop_id join
    // is the ONLY path and its source stays cad-roll.
    const propIdLu = new Map([
      ["12345", { landUseCode: "P1", landUseVintage: "2025" }],
    ]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "012345", txgioOwnerForGate: "SHOULD IGNORE" }),
      "48029",
      "Bexar",
      propIdLu,
      now,
      seed,
      addrLookup("SHOULD IGNORE"),
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("P1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll");
    expect(payload.provenance.landUseAddressRecovered).toBe(false);
  });

  it("prefers the correct prop_id join over the address join for a non-blocked county (no double join)", () => {
    // A non-blocked county already has a working prop_id join; the address path
    // must never fire and never override.
    const propIdLu = new Map([
      ["987", { landUseCode: "B1", landUseVintage: "2025" }],
    ]);
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "000987", txgioOwnerForGate: "OWNER X" }),
      "48021",
      "Bastrop",
      propIdLu,
      now,
      seed,
      addrLookup("OWNER X"),
    )!;
    expect(payload.baseFacts.landUse?.code).toBe("B1");
    expect(payload.baseFacts.landUse?.source).toBe("cad-roll");
    expect(payload.provenance.landUseAddressRecovered).toBe(false);
  });

  it("owner-recovered land-use never leaks the owner name into the payload", () => {
    const payload = buildTier1Payload(
      parcelRow({ prop_id: "R062578", txgioOwnerForGate: "PURVIS MICHAEL" }),
      "48491",
      "Williamson",
      new Map(),
      now,
      seed,
      addrLookup("PURVIS MICHAEL"),
    )!;
    const json = JSON.stringify(payload);
    expect(/owner/i.test(json)).toBe(false);
    expect(json.includes("PURVIS")).toBe(false);
  });
});

describe("honest absence — envelope + node-id (never fabricate)", () => {
  const now = "2026-07-21T00:00:00.000Z";

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

  it("blank situs declines even with a zoning fallback when zoning is absent", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: null,
      situsCity: null,
      situsState: "TX",
      situsAddress: null,
      zoningJurisdictionFallback: "pflugerville_tx",
    });
    expect(env.status).toBe("declined");
    expect(env.declineReason).toBe("no-jurisdiction-key");
  });

  it("blank situs uses sole-zoning-layer fallback when a district is stamped", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: "SF-S",
      situsCity: null,
      situsState: "TX",
      situsAddress: null,
      zoningJurisdictionFallback: "pflugerville_tx",
    });
    expect(env.jurisdictionKey).toBe("pflugerville_tx");
    // SF-S is a shipped Pflugerville district — envelope should not decline
    // for no-jurisdiction-key (ok / no-buildable-area / no-district only).
    expect(env.declineReason).not.toBe("no-jurisdiction-key");
    expect(["ok", "no-buildable-area", "declined"]).toContain(env.status);
    if (env.status === "declined") {
      expect(env.declineReason).toBe("no-district");
    }
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
  it("absent zoning declines with conservative estimate — does not stamp a district", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: null,
      situsCity: "Bastrop",
      situsState: "TX",
      situsAddress: "123 MAIN ST, BASTROP, TX 78602",
    });
    expect(env.status).toBe("declined");
    expect(env.declineReason).toBe("no-zoning-stamp");
    expect(env.matchKind).toBe("fallback-conservative");
    expect(env.district).toBeUndefined();
    expect(env.provisional).toBe(true);
    expect(env.roadsPending).toBe(true);
    // Shape-only labeling (no roads) => the low-confidence approximate path.
    expect(env.edgeSignal).toBe("shape");
    expect(env.approximate).toBe(true);
    expect(env.confidence).toBeGreaterThan(0);
    expect(env.confidence).toBeLessThan(0.7);
    expect(env.setbacks).toBeDefined();
    expect(env.buildableAreaSqFt).toBeGreaterThan(0);
    expect(env.disclosure).toMatch(/not a district determination/i);
    expect(JSON.stringify(env.geojson)).not.toMatch(/I-2|R-LD Residential/i);
    expect(JSON.stringify(env.geojson)).toMatch(/conservative-estimate/);
  });

  it("matched zoning still returns ok with the real district name", () => {
    const env = computeTier1Envelope({
      ring: BASTROP_LOT,
      zoningCode: "R-MD",
      situsCity: "Bastrop",
      situsState: "TX",
      situsAddress: "123 MAIN ST, BASTROP, TX 78602",
    });
    expect(env.status).toBe("ok");
    expect(env.district).toBeTruthy();
    expect(env.declineReason).toBeUndefined();
  });
});

describe("monotonic high-water-mark guard (verify-before-promote)", () => {
  const now = new Date().toISOString();
  const county = { fips: "48021", name: "Bastrop" };

  const fullPayload = () =>
    buildTier1Payload(
      parcelRow({ zoning_district: "R-MD" }),
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

  it("replaces a legacy Public/Institutional envelope with the populated Bastrop B3 P-5 row", () => {
    const populatedP5 = buildTier1Payload(
      parcelRow({ zoning_district: "P-5" }),
      county.fips,
      county.name,
      new Map(),
      now,
    )!;
    const invalidPrior: Tier1FacetPayload = {
      ...populatedP5,
      envelope: {
        ...populatedP5.envelope!,
        status: "ok",
        confidence: 0.245,
        district: "P Public/Institutional",
        setbacks: { front_ft: 25, side_ft: 15, rear_ft: 20 },
      },
      facetCoverage: { ...populatedP5.facetCoverage, envelope: true },
    };

    expect(populatedP5.envelope?.district).toBe("P-5 Core");
    expect(populatedP5.envelope?.setbacks).toEqual({
      front_ft: 15,
      side_ft: 0,
      rear_ft: 0,
    });
    expect(shouldPromote(invalidPrior, populatedP5)).toBe(true);
  });

  it("replaces an invented unmatched-district envelope with setback-table-pending", () => {
    // Lockhart PDD previously fell back to RHD via conservative invent; after
    // #346 the re-bake declines. Monotonic must force the honest decline.
    const declined = buildTier1Payload(
      parcelRow({
        zoning_district: "PDD",
        situs_city: "Lockhart",
        situs_state: "TX",
      }),
      "48055",
      "Caldwell",
      new Map(),
      now,
    )!;
    expect(declined.envelope?.status).toBe("declined");
    expect(declined.envelope?.declineReason).toBe("setback-table-pending");
    expect(declined.facetCoverage.envelope).toBe(false);

    const inventedPrior: Tier1FacetPayload = {
      ...declined,
      envelope: {
        provisional: true,
        roadsPending: true,
        status: "ok",
        confidence: 0.245,
        approximate: true,
        district: "RHD Residential High Density (conservative allowed-type envelope)",
        setbacks: { front_ft: 25, side_ft: 20, rear_ft: 25 },
        jurisdictionKey: "lockhart_tx",
      },
      facetCoverage: { ...declined.facetCoverage, envelope: true },
    };
    expect(shouldPromote(inventedPrior, declined)).toBe(true);
  });

  it("replaces absent-zoning invent (stamped I-2) with no-zoning-stamp decline", () => {
    const honest = buildTier1Payload(
      parcelRow({
        zoning_district: null,
        situs_city: "San Antonio",
        situs_state: "TX",
      }),
      "48029",
      "Bexar",
      new Map(),
      now,
    )!;
    expect(honest.envelope?.status).toBe("declined");
    expect(honest.envelope?.declineReason).toBe("no-zoning-stamp");
    expect(honest.envelope?.district).toBeUndefined();
    expect(honest.facetCoverage.envelope).toBe(true);

    const inventPrior: Tier1FacetPayload = {
      ...honest,
      envelope: {
        provisional: true,
        roadsPending: true,
        status: "ok",
        confidence: 0.245,
        approximate: true,
        district: "I-2 San Antonio heavy industrial district",
        setbacks: { front_ft: 30, side_ft: 50, rear_ft: 50 },
        jurisdictionKey: "san_antonio_tx",
      },
      facetCoverage: { ...honest.facetCoverage, envelope: true },
    };
    expect(shouldPromote(inventPrior, honest)).toBe(true);
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

// ---------------------------------------------------------------------------
// Batched-I/O bake — the batch of the per-page prior-read + upsert must make
// the SAME per-node monotonic decision and produce IDENTICAL counts to the
// original per-node loop. These tests drive `decidePagePromotions` (the pure
// decide step) against a reference per-node simulation and assert equality.
// ---------------------------------------------------------------------------

/**
 * Reference per-node simulation: the ORIGINAL loop's decide+write semantics,
 * kept as an independent oracle. It reads the prior (from the store map),
 * applies shouldPromote, and on promote writes the payload back into the store
 * (so a later duplicate placeKey in the same page sees the fresh write — the
 * exact per-node behavior). Returns the same counts + final store the batched
 * path must match.
 */
function perNodeReference(
  computed: ComputedNode[],
  initialStore: Map<string, Tier1FacetPayload>,
): {
  promotedNew: number;
  promotedUpgrade: number;
  keptPriorMonotonic: number;
  baked: number;
  finalStore: Map<string, Tier1FacetPayload>;
} {
  const store = new Map(initialStore);
  let promotedNew = 0;
  let promotedUpgrade = 0;
  let keptPriorMonotonic = 0;
  let baked = 0;
  for (const c of computed) {
    const prior = store.get(c.placeKey) ?? null;
    if (!shouldPromote(prior, c.payload)) {
      keptPriorMonotonic += 1;
      continue;
    }
    baked += 1;
    if (prior) promotedUpgrade += 1;
    else promotedNew += 1;
    store.set(c.placeKey, c.payload); // per-node write-back
  }
  return { promotedNew, promotedUpgrade, keptPriorMonotonic, baked, finalStore: store };
}

/** Apply a batched decision's toWrite to a store (last-write-wins per key). */
function applyBatchWrites(
  initialStore: Map<string, Tier1FacetPayload>,
  toWrite: { placeKey: string; payload: Tier1FacetPayload }[],
): Map<string, Tier1FacetPayload> {
  const store = new Map(initialStore);
  for (const w of toWrite) store.set(w.placeKey, w.payload);
  return store;
}

describe("batched bake — decision + counts match the per-node loop", () => {
  const now = new Date().toISOString();
  const CTY = { fips: "48021", name: "Bastrop" };

  const nodeFull = (fi: number): ComputedNode => {
    const payload = buildTier1Payload(
      parcelRow({ feature_index: fi, prop_id: `R${fi}0000`, zoning_district: "R-MD" }),
      CTY.fips,
      CTY.name,
      new Map([[`${fi}0000`, { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
    )!;
    return { placeKey: `node:${payload.parcelNodeId}`, payload, centroid: { lat: 30.11, lng: -97.31 } };
  };

  const nodeStripped = (fi: number): ComputedNode => {
    const payload = buildTier1Payload(
      parcelRow({ feature_index: fi, prop_id: `R${fi}0000`, zoning_district: null }),
      CTY.fips,
      CTY.name,
      new Map(),
      now,
    )!;
    return { placeKey: `node:${payload.parcelNodeId}`, payload, centroid: { lat: 30.11, lng: -97.31 } };
  };

  it("mixed page (new + upgrade + downgrade-rejected): counts identical to per-node", () => {
    // fi=1: no prior -> promote NEW (full)
    // fi=2: prior stripped -> promote UPGRADE (full > stripped)
    // fi=3: prior full -> DOWNGRADE rejected (stripped < full) -> kept
    const page = [nodeFull(1), nodeFull(2), nodeStripped(3)];
    const priors = new Map<string, Tier1FacetPayload>([
      [nodeStripped(2).placeKey, nodeStripped(2).payload], // prior for fi=2
      [nodeFull(3).placeKey, nodeFull(3).payload], // prior for fi=3
    ]);

    const batched = decidePagePromotions(page, priors);
    const ref = perNodeReference(page, priors);

    expect(batched.promotedNew).toBe(ref.promotedNew);
    expect(batched.promotedUpgrade).toBe(ref.promotedUpgrade);
    expect(batched.keptPriorMonotonic).toBe(ref.keptPriorMonotonic);
    expect(batched.toWrite.length + batched.keptPriorMonotonic).toBe(page.length);
    // Concrete expected values.
    expect(batched.promotedNew).toBe(1);
    expect(batched.promotedUpgrade).toBe(1);
    expect(batched.keptPriorMonotonic).toBe(1);

    // Final store equivalence: batched last-write-wins == per-node write-back.
    const batchedStore = applyBatchWrites(priors, batched.toWrite);
    for (const [k, v] of ref.finalStore) {
      expect(facetScore(batchedStore.get(k)!)).toBe(facetScore(v));
    }
  });

  it("a downgrade in the page rejects only that node while others promote (partition)", () => {
    const page = [nodeFull(10), nodeStripped(11), nodeFull(12)];
    // fi=11 has a full prior (downgrade-reject); 10 and 12 are new.
    const priors = new Map<string, Tier1FacetPayload>([
      [nodeFull(11).placeKey, nodeFull(11).payload],
    ]);
    const batched = decidePagePromotions(page, priors);
    const ref = perNodeReference(page, priors);

    expect(batched.keptPriorMonotonic).toBe(1);
    expect(batched.promotedNew).toBe(2);
    expect(batched.promotedUpgrade).toBe(0);
    // The rejected node is NOT in the write set.
    const rejected = nodeStripped(11).placeKey;
    expect(batched.toWrite.some((w) => w.placeKey === rejected)).toBe(false);
    // The two good nodes ARE.
    expect(batched.toWrite.some((w) => w.placeKey === nodeFull(10).placeKey)).toBe(true);
    expect(batched.toWrite.some((w) => w.placeKey === nodeFull(12).placeKey)).toBe(true);

    expect(batched.promotedNew).toBe(ref.promotedNew);
    expect(batched.promotedUpgrade).toBe(ref.promotedUpgrade);
    expect(batched.keptPriorMonotonic).toBe(ref.keptPriorMonotonic);
  });

  it("a worse re-bake in a full page never overwrites (all downgrades rejected)", () => {
    // Every node has a full prior; the page recomputes all as stripped.
    const page = [nodeStripped(20), nodeStripped(21), nodeStripped(22)];
    const priors = new Map<string, Tier1FacetPayload>([
      [nodeFull(20).placeKey, nodeFull(20).payload],
      [nodeFull(21).placeKey, nodeFull(21).payload],
      [nodeFull(22).placeKey, nodeFull(22).payload],
    ]);
    const batched = decidePagePromotions(page, priors);
    expect(batched.keptPriorMonotonic).toBe(3);
    expect(batched.toWrite.length).toBe(0);
    expect(batched.promotedNew + batched.promotedUpgrade).toBe(0);
  });

  it("duplicate placeKey within a page: intra-page high-water-mark matches per-node", () => {
    // Two rows normalize to the same node id: stripped THEN full. Per-node,
    // the first promotes (new), the second reads the fresh stripped write and
    // promotes (upgrade). Batched must count new=1, upgrade=1 and de-dup the
    // write to the LAST (full) payload.
    const s = nodeStripped(30);
    const f = nodeFull(30); // same fi -> same placeKey
    expect(f.placeKey).toBe(s.placeKey);
    const page = [s, f];
    const priors = new Map<string, Tier1FacetPayload>();

    const batched = decidePagePromotions(page, priors);
    const ref = perNodeReference(page, priors);

    expect(batched.promotedNew).toBe(ref.promotedNew); // 1
    expect(batched.promotedUpgrade).toBe(ref.promotedUpgrade); // 1
    expect(batched.keptPriorMonotonic).toBe(ref.keptPriorMonotonic); // 0
    // De-duped to a single write carrying the LAST (full) payload.
    expect(batched.toWrite).toHaveLength(1);
    expect(facetScore(batched.toWrite[0].payload)).toBe(facetScore(f.payload));

    const batchedStore = applyBatchWrites(priors, batched.toWrite);
    expect(facetScore(batchedStore.get(f.placeKey)!)).toBe(
      facetScore(ref.finalStore.get(f.placeKey)!),
    );
  });

  it("empty page decides nothing", () => {
    const batched = decidePagePromotions([], new Map());
    expect(batched.toWrite).toHaveLength(0);
    expect(batched.promotedNew).toBe(0);
    expect(batched.promotedUpgrade).toBe(0);
    expect(batched.keptPriorMonotonic).toBe(0);
  });
});

describe("batched write chunking (param-limit safety)", () => {
  it("splits an over-cap array into cap-sized chunks (last short)", () => {
    const items = Array.from({ length: 5000 + 5000 + 123 }, (_, i) => i);
    const chunks = chunkItems(items, BATCH_WRITE_CHUNK);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(5000);
    expect(chunks[1]).toHaveLength(5000);
    expect(chunks[2]).toHaveLength(123);
    // No element lost or duplicated.
    expect(chunks.flat()).toEqual(items);
  });

  it("a full 5000-row page fits one chunk, and the unnest form uses 7 params", () => {
    const items = Array.from({ length: 5000 }, (_, i) => i);
    expect(chunkItems(items, BATCH_WRITE_CHUNK)).toHaveLength(1);
    // The batched upsert binds a CONSTANT 7 params (adapter_key + now + five
    // per-row arrays), so 5000 rows == 7 bound params, far under pg's 65535
    // ceiling. paramsPerRow == 0 (row data rides inside array literals).
    const PARAMS = 7;
    expect(5000 * 0 + PARAMS).toBeLessThan(60000);
  });

  it("rejects a non-positive chunk size", () => {
    expect(() => chunkItems([1, 2, 3], 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// FABRICATION-CORRECTION integrity override (the monotonic-guard escape hatch).
//
// The confirmed prod trap: 81,682 Williamson snapshots carry a FABRICATED
// baseFacts.landUse (collision-stamped, e.g. node 48491:R062578 owner MILLER
// stamped "A1"). An honest gate-blocked re-bake produces landUse:null, which
// scores LOWER than the fabricated prior, so the plain monotonic shouldPromote
// would KEEP the fabrication forever. The override must FORCE the correction.
// ---------------------------------------------------------------------------

describe("fabrication-correction integrity override (removes fabricated land-use)", () => {
  const now = new Date().toISOString();

  // A Williamson node's PRIOR snapshot as it exists in prod today: the R-strip
  // collision stamped a land-use. We simulate that prior by baking Williamson
  // with the county NOT in the blocked set (the pre-fix behavior) and a
  // colliding cad row present, so baseFacts.landUse is the fabricated code.
  const fabricatedWilliamsonPrior = (): Tier1FacetPayload => {
    const lu = new Map([
      ["R062578", { landUseCode: "A1", landUseVintage: "2025" }],
    ]);
    // Force the collision-stamped prior by passing an EMPTY blocked set (the
    // old, un-gated behavior) so land-use lands on the payload. normalizeForJoin
    // no longer strips R, so the map is keyed on the raw normalized prop_id.
    const prior = buildTier1Payload(
      parcelRow({ prop_id: "R062578", zoning_district: "SF" }),
      "48491",
      "Williamson",
      lu,
      now,
      new Set<string>(), // empty blocked set -> land-use stamped (the fabrication)
    )!;
    return prior;
  };

  // The honest re-bake: Williamson IS gate-blocked now (seed / ledger), so
  // landUseJoinKey returns null and baseFacts.landUse is null.
  const honestBlockedRebake = (): Tier1FacetPayload =>
    buildTier1Payload(
      parcelRow({ prop_id: "R062578", zoning_district: "SF" }),
      "48491",
      "Williamson",
      new Map([["R062578", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      LANDUSE_JOIN_DISABLED_FIPS_SEED, // Williamson blocked
    )!;

  it("the fabricated prior actually carries the collision-stamped land-use", () => {
    const prior = fabricatedWilliamsonPrior();
    expect(prior.baseFacts.landUse).not.toBeNull();
    expect(prior.baseFacts.landUse!.code).toBe("A1");
    expect(prior.facetCoverage.landUse).toBe(true);
    expect(prior.provenance.landUseGateBlocked).toBe(false);
  });

  it("the honest gate-blocked re-bake carries NO land-use and is flagged blocked", () => {
    const next = honestBlockedRebake();
    expect(next.baseFacts.landUse).toBeNull();
    expect(next.facetCoverage.landUse).toBe(false);
    expect(next.provenance.landUseGateBlocked).toBe(true);
  });

  it("the honest re-bake scores LOWER than the fabricated prior (the trap)", () => {
    // Proves the plain monotonic guard WOULD keep the fabrication: the honest
    // payload lost the land-use facet, so its facetScore is strictly lower.
    expect(facetScore(honestBlockedRebake())).toBeLessThan(
      facetScore(fabricatedWilliamsonPrior()),
    );
  });

  it("shouldPromote FORCES the correction despite the lower score", () => {
    // Without the override this returns false (score went down) and the
    // fabrication survives. With the override it returns true.
    expect(
      shouldPromote(fabricatedWilliamsonPrior(), honestBlockedRebake()),
    ).toBe(true);
  });

  it("decidePagePromotions writes the honest (null land-use) payload and counts the correction", () => {
    const placeKey = "node:48491:R062578";
    const priors = new Map<string, Tier1FacetPayload>([
      [placeKey, fabricatedWilliamsonPrior()],
    ]);
    const computed: ComputedNode[] = [
      {
        placeKey,
        payload: honestBlockedRebake(),
        centroid: { lat: 30.6, lng: -97.6 },
      },
    ];
    const decision = decidePagePromotions(computed, priors);

    // The correction promoted (as an upgrade over the prior) and is counted.
    expect(decision.promotedUpgrade).toBe(1);
    expect(decision.keptPriorMonotonic).toBe(0);
    expect(decision.fabricationCorrected).toBe(1);

    // The row that will be upserted carries NULL land-use — the fabrication is
    // REMOVED from the snapshot, not kept.
    expect(decision.toWrite).toHaveLength(1);
    expect(decision.toWrite[0].payload.baseFacts.landUse).toBeNull();
    expect(decision.toWrite[0].payload.facetCoverage.landUse).toBe(false);
  });

  it("the override is SCOPED — a normal (non-blocked) downgrade is still rejected", () => {
    // A Bastrop (not blocked) node that loses land-use on a worse re-bake must
    // still be kept on its prior high-water-mark: the override must NOT be a
    // general downgrade bypass.
    const bastropFull = buildTier1Payload(
      parcelRow({ prop_id: "12345", zoning_district: "R-MD" }),
      "48021",
      "Bastrop",
      new Map([["12345", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      LANDUSE_JOIN_DISABLED_FIPS_SEED,
    )!;
    const bastropStripped = buildTier1Payload(
      parcelRow({ prop_id: "12345", zoning_district: null }),
      "48021",
      "Bastrop",
      new Map(), // land-use lost this pass
      now,
      LANDUSE_JOIN_DISABLED_FIPS_SEED,
    )!;
    expect(bastropStripped.provenance.landUseGateBlocked).toBe(false);
    // Bastrop is NOT gate-blocked, so the override does not fire; the downgrade
    // is rejected and the prior is kept.
    expect(shouldPromote(bastropFull, bastropStripped)).toBe(false);
  });

  it("the override does NOT fire when the prior had no land-use to strip", () => {
    // A gate-blocked re-bake of a node whose prior ALREADY had null land-use is
    // a normal equal/idempotent promotion, not a forced correction — so it must
    // not be counted as a fabrication correction.
    const priorNoLandUse = honestBlockedRebake(); // already null land-use
    const nextNoLandUse = honestBlockedRebake();
    const placeKey = "node:48491:R062578";
    const decision = decidePagePromotions(
      [{ placeKey, payload: nextNoLandUse, centroid: { lat: 30.6, lng: -97.6 } }],
      new Map([[placeKey, priorNoLandUse]]),
    );
    // Equal-quality refresh promotes (idempotent) but is NOT a correction.
    expect(decision.fabricationCorrected).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The live-bug regression: the bake must act on the UNION of the ledger's
// `block` verdicts and the seed. Hays (48209) is a ledger `block`. Williamson
// (48491) is NOT a ledger block — post R-strip-removal it joins ~0 real pairs
// and scores `insufficient-sample` — but it IS in the seed (known fabrication).
// The old CLI passed the raw ledger set, so Williamson's `landUseGateBlocked`
// stayed false, the integrity override never fired, and ~81,682 fabricated
// land-use snapshots survived every re-bake. The fix: pass
// effectiveBlockedFips(ledger) = ledger ∪ seed, which arms the override for a
// seed-blocked-but-ledger-insufficient county too. These tests exercise the
// exact CLI effective-set path with a DB-free simulated ledger.
// ---------------------------------------------------------------------------
describe("effective block set = ledger ∪ seed (Williamson live-bug regression)", () => {
  const now = new Date().toISOString();

  // Simulate loadLedgerBlockedFips's return in prod today: Hays is a `block`
  // verdict; Williamson is NOT (it scored `insufficient-sample`). This is the
  // set the OLD code passed straight to the bake — the seed was bypassed.
  const ledgerBlockedOnly = (): ReadonlySet<string> => new Set<string>(["48209"]);

  it("the union adds the seed's Williamson (48491) that the ledger omits", () => {
    const effective = effectiveBlockedFips(ledgerBlockedOnly());
    // Hays via the ledger verdict.
    expect(effective.has("48209")).toBe(true);
    // Williamson via the seed floor — the ledger did NOT block it.
    expect(ledgerBlockedOnly().has("48491")).toBe(false);
    expect(effective.has("48491")).toBe(true);
  });

  it("the seed is a permanent floor — every seed FIPS survives the union", () => {
    for (const fips of LANDUSE_JOIN_DISABLED_FIPS_SEED) {
      expect(effectiveBlockedFips(ledgerBlockedOnly()).has(fips)).toBe(true);
    }
  });

  it("the union never DROPS a ledger block (adds, never replaces)", () => {
    const ledger = new Set<string>(["48209", "48999"]); // a non-seed ledger block
    const effective = effectiveBlockedFips(ledger);
    expect(effective.has("48209")).toBe(true);
    expect(effective.has("48999")).toBe(true);
  });

  // THE test that would have caught the live bug: bake Williamson with the
  // EFFECTIVE set derived from a ledger that does NOT block it. The seed drives
  // landUseGateBlocked true, so the honest re-bake carries null land-use, the
  // override forces the correction, and the written payload strips the prior's
  // fabricated land-use.
  it("Williamson (ledger-insufficient, seed-blocked) strips its fabricated prior via the union", () => {
    const effective = effectiveBlockedFips(ledgerBlockedOnly());

    // The prior as it sits in prod: the pre-gate collision stamped a land-use.
    const fabricatedPrior = buildTier1Payload(
      parcelRow({ prop_id: "R062578", zoning_district: "SF" }),
      "48491",
      "Williamson",
      new Map([["R062578", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      new Set<string>(), // un-gated -> land-use fabricated
    )!;
    expect(fabricatedPrior.baseFacts.landUse).not.toBeNull();
    expect(fabricatedPrior.provenance.landUseGateBlocked).toBe(false);

    // The honest re-bake, gated by the EFFECTIVE (union) set the CLI now passes.
    // Williamson is blocked via the seed even though the ledger omitted it.
    const honestRebake = buildTier1Payload(
      parcelRow({ prop_id: "R062578", zoning_district: "SF" }),
      "48491",
      "Williamson",
      new Map([["R062578", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      effective,
    )!;

    // (1) The union drives landUseGateBlocked TRUE — this is what the old raw
    //     ledger set failed to do for Williamson.
    expect(honestRebake.provenance.landUseGateBlocked).toBe(true);
    expect(honestRebake.baseFacts.landUse).toBeNull();
    expect(honestRebake.facetCoverage.landUse).toBe(false);

    // (2) shouldPromote FORCES the correction despite the lower score.
    expect(facetScore(honestRebake)).toBeLessThan(facetScore(fabricatedPrior));
    expect(shouldPromote(fabricatedPrior, honestRebake)).toBe(true);

    // (3) The written payload has null land-use — the fabrication is STRIPPED.
    const placeKey = "node:48491:R062578";
    const decision = decidePagePromotions(
      [{ placeKey, payload: honestRebake, centroid: { lat: 30.6, lng: -97.6 } }],
      new Map([[placeKey, fabricatedPrior]]),
    );
    expect(decision.fabricationCorrected).toBe(1);
    expect(decision.toWrite).toHaveLength(1);
    expect(decision.toWrite[0].payload.baseFacts.landUse).toBeNull();
    expect(decision.toWrite[0].payload.facetCoverage.landUse).toBe(false);
  });

  it("the union drives landUseGateBlocked TRUE for BOTH Hays (ledger) and Williamson (seed)", () => {
    const effective = effectiveBlockedFips(ledgerBlockedOnly());

    const hays = buildTier1Payload(
      parcelRow({ prop_id: "998877" }),
      "48209",
      "Hays",
      new Map([["998877", { landUseCode: "B2", landUseVintage: "2025" }]]),
      now,
      effective,
    )!;
    const williamson = buildTier1Payload(
      parcelRow({ prop_id: "R062578" }),
      "48491",
      "Williamson",
      new Map([["R062578", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      effective,
    )!;

    // Hays: blocked by the ledger verdict. Williamson: blocked by the seed.
    expect(hays.provenance.landUseGateBlocked).toBe(true);
    expect(hays.baseFacts.landUse).toBeNull();
    expect(williamson.provenance.landUseGateBlocked).toBe(true);
    expect(williamson.baseFacts.landUse).toBeNull();
  });

  it("a real (non-blocked, non-seed) county is UNAFFECTED by the union", () => {
    const effective = effectiveBlockedFips(ledgerBlockedOnly());
    // Bastrop (48021): not in the ledger, not in the seed -> joins normally.
    const bastrop = buildTier1Payload(
      parcelRow({ prop_id: "12345" }),
      "48021",
      "Bastrop",
      new Map([["12345", { landUseCode: "A1", landUseVintage: "2025" }]]),
      now,
      effective,
    )!;
    expect(bastrop.provenance.landUseGateBlocked).toBe(false);
    expect(bastrop.baseFacts.landUse).not.toBeNull();
    expect(bastrop.baseFacts.landUse!.code).toBe("A1");
  });
});
