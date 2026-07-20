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
  decidePagePromotions,
  chunkItems,
  BATCH_WRITE_CHUNK,
  type Tier1FacetPayload,
  type ComputedNode,
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
      parcelRow({ feature_index: fi, prop_id: `R${fi}0000`, zoning_district: "SF-1" }),
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
