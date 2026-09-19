/**
 * P-153 Step B, re-pointed by P-374. `tryComposeEnvelopeModelForDraw` runs the
 * ONE derivation both this draw block and the map/export route use
 * (`envelopeDrawDerivation.ts#deriveEnvelopeDraw`), seeded from a point the
 * caller already resolved (no geocode, no situs disambiguation). Mocks the
 * three I/O boundaries (`queryGisLayerGeoJson`, `fetchPropertyAtomChain`,
 * `fetchNearbyRoads`) so this is deterministic and offline; everything else
 * (resolveAuthoritativeSetbacks, jurisdiction resolution, labelEdges,
 * composeBuildableEnvelopeDerivation) runs for real, against the real Bastrop
 * codified-ordinance setback table (the same fixture
 * `brokeragePlaceBuildableEnvelope.test.ts` and `parcelDrawStub.test.ts`'s gold
 * fixture both key off: Bastrop, TX / SF-1 shaped, mirroring the real
 * 48021:34049 case). The spine read (`./spineZoningDistrict`) is mocked to
 * `null` — this environment has no baked node-facet store, and P-374 moved that
 * read INTO the shared derivation, so an unmocked call here would be a live DB
 * reach.
 *
 * The draw block's own jurisdiction city/state are optional inputs (the route's
 * equivalent is the request geocode); these tests exercise the situs-string
 * fallback, which is the same fallback the route has always had.
 *
 * The remaining unavoidable `@workspace/db` coupling here is
 * `@workspace/codes`'s `keyFromEngagementOrSynthesize`
 * (its package barrel couples it to a warmup-queue orchestrator that
 * imports `@workspace/db`, which throws at MODULE LOAD if `DATABASE_URL` is
 * unset) and `../brokerageGisLayers`'s real parcels-layer proxy (which
 * itself imports `brokerageTxParcels`/`brokerageGisCache`, also
 * `@workspace/db`-coupled) — both real, correct dependencies of this
 * module's own logic, not an accidental import. This environment has no
 * live Postgres and none of the code paths this test actually exercises
 * ever runs a real query (every real I/O call this test reaches is mocked
 * below: `queryGisLayerGeoJson` is fully replaced, so `brokerageGisLayers`'s
 * own body never even runs), so a bogus connection string is set BEFORE any
 * import touches `@workspace/db` -- the same "point the singleton at a
 * bogus URL so it initializes without error" posture test-env.ts already
 * uses for the Anthropic client. `pg.Pool` connects lazily; this never
 * dials out.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { feetToMeters } from "./geometry";

process.env.DATABASE_URL ||=
  "postgresql://p153-test:p153-test@127.0.0.1:5432/p153_test_offline";

const BASTROP_PARCEL_NODE_ID = "48021:34049";
const BASTROP_LNG = -97.31;
const BASTROP_LAT = 30.11;

let parcelZoning: string | null = "R-MD";
let parcelNodeIdStamped: string | null = BASTROP_PARCEL_NODE_ID;
let parcelSitusAddress = "1209 Main St, Bastrop, TX 78602";
let parcelGeoThrows: unknown = null;

function rectParcel() {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((BASTROP_LAT * Math.PI) / 180);
  const halfW = feetToMeters(100) / 2 / mPerDegLng;
  const halfH = feetToMeters(200) / 2 / mPerDegLat;
  return {
    type: "FeatureCollection" as const,
    features: [
      {
        type: "Feature" as const,
        geometry: {
          type: "Polygon" as const,
          coordinates: [
            [
              [BASTROP_LNG - halfW, BASTROP_LAT - halfH],
              [BASTROP_LNG + halfW, BASTROP_LAT - halfH],
              [BASTROP_LNG + halfW, BASTROP_LAT + halfH],
              [BASTROP_LNG - halfW, BASTROP_LAT + halfH],
              [BASTROP_LNG - halfW, BASTROP_LAT - halfH],
            ],
          ],
        },
        properties: {
          apn: "R123456",
          situsAddress: parcelSitusAddress,
          zoningCode: parcelZoning,
          ...(parcelNodeIdStamped ? { parcel_node_id: parcelNodeIdStamped } : {}),
        },
      },
    ],
  };
}

const queryGisLayerGeoJsonMock = vi.fn(async () => {
  if (parcelGeoThrows) throw parcelGeoThrows;
  return {
    layer: "parcels",
    provider: "Test County GIS",
    adapterKey: "test:parcels",
    serviceUrl: "https://example/parcels",
    geojson: rectParcel(),
    featureCount: 1,
    queryMode: "pin" as const,
    notSurveyGrade: true,
  };
});
vi.mock("../brokerageGisLayers", async () => {
  const actual =
    await vi.importActual<typeof import("../brokerageGisLayers")>(
      "../brokerageGisLayers",
    );
  return { ...actual, queryGisLayerGeoJson: queryGisLayerGeoJsonMock };
});

/**
 * P-339: mutable so a test can put a chain PRESENT — the case the fix is
 * about. `null` (the default) is "no atom path at all", which is the one
 * state where `atom_path_pending` is the honest reason.
 */
let atomChainResult: unknown = null;
const fetchPropertyAtomChainMock = vi.fn(async () => {
  if (atomChainResult instanceof Error) throw atomChainResult;
  return atomChainResult;
});
vi.mock("./fetchPropertyAtomChain", () => ({
  fetchPropertyAtomChain: fetchPropertyAtomChainMock,
}));

const fetchNearbyRoadsMock = vi.fn(async () => {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = BASTROP_LAT - feetToMeters(120) / mPerDegLat;
  return [
    {
      name: "Main St",
      highway: "residential",
      classification: "residential" as const,
      polyline: [
        [BASTROP_LNG - 0.002, roadLat],
        [BASTROP_LNG + 0.002, roadLat],
      ] as [number, number][],
    },
  ];
});
vi.mock("./roads", async () => {
  const actual = await vi.importActual<typeof import("./roads")>("./roads");
  return { ...actual, fetchNearbyRoads: fetchNearbyRoadsMock };
});

/**
 * P-374: the shared derivation reads the spine when the ring carries no zoning
 * stamp. This environment has no baked node-facet store, so the read is pinned
 * to `null` — the same posture `brokeragePlaceBuildableEnvelope.test.ts` takes
 * for the same module.
 */
const resolveSpineZoningWhenGisAbsentMock = vi.hoisted(() => vi.fn());
vi.mock("./spineZoningDistrict", () => ({
  resolveSpineZoningWhenGisAbsent: resolveSpineZoningWhenGisAbsentMock,
  spineZoningProvenanceNote: () => "",
}));

const { tryComposeEnvelopeModelForDraw } = await import(
  "./parcelDrawEnvelopeModel"
);
const { assembleParcelDraw } = await import("../parcelDrawStub");
const { envelopeDrawRefusalReason } = await import("./envelopeDrawOutcome");

afterEach(() => {
  parcelZoning = "R-MD";
  parcelNodeIdStamped = BASTROP_PARCEL_NODE_ID;
  parcelSitusAddress = "1209 Main St, Bastrop, TX 78602";
  parcelGeoThrows = null;
  atomChainResult = null;
  resolveSpineZoningWhenGisAbsentMock.mockReset();
  resolveSpineZoningWhenGisAbsentMock.mockResolvedValue(null);
  queryGisLayerGeoJsonMock.mockClear();
  fetchPropertyAtomChainMock.mockClear();
  fetchNearbyRoadsMock.mockClear();
});

describe("tryComposeEnvelopeModelForDraw — positive control (48021:34049-shaped, atom-pending, SF/R-MD zoned)", () => {
  it("resolves a real modelled envelope: closed-enough ring, applied setbacks, a disclosure string", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    // P-339: P-153's `null` collapse is gone; the positive arm is NAMED.
    expect(result.state).toBe("modelled");
    if (result.state !== "modelled") throw new Error("unreachable");
    // No atom chain exists for this parcel — the bake's "atom-pending" IS the
    // truth — and the codified Bastrop table still resolves and still draws.
    expect(result.chain).toBe("absent");
    expect(result.model.ringLngLat.length).toBeGreaterThanOrEqual(4);
    expect(result.model.setbacks.district).toBe("R-MD");
    expect(result.model.setbacks.front_ft).toBeGreaterThan(0);
    expect(typeof result.model.disclosure).toBe("string");
    expect(result.model.disclosure.length).toBeGreaterThan(0);
    expect(queryGisLayerGeoJsonMock).toHaveBeenCalledTimes(1);
    expect(fetchPropertyAtomChainMock).toHaveBeenCalledTimes(1);
    expect(fetchNearbyRoadsMock).toHaveBeenCalledTimes(1);
  });

  it("end-to-end: feeding the resolved model into assembleParcelDraw draws a present envelope overlay with real geom and no reason", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result.state).toBe("modelled");
    if (result.state !== "modelled") throw new Error("unreachable");

    const draw = assembleParcelDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      label: "1209 Main St, Bastrop, TX 78602",
      bakedAt: "2026-09-11",
      countyFips: "48021",
      zoning: { district: "R-MD" },
      landUse: null,
      yearBuilt: null,
      anchor: { lat: BASTROP_LAT, lng: BASTROP_LNG },
      boundary: { state: "refused", code: "atom-miss" },
      flood: { state: "refused" },
      envelopeRefusalReason: "modelled-figure-withheld",
      envelopeModelled: result.model,
      pipeline: { state: "refused" },
      well: { state: "refused" },
      specialDistrict: { state: "refused" },
    });

    const envelope = draw.overlays.find((o) => o.id === "envelope");
    expect(envelope?.state).toBe("present");
    expect(envelope).not.toHaveProperty("reason");
    // The token the package already carries for exactly this state: polygon
    // drawn, buildable-area figure still withheld (P-153's rule, unchanged).
    expect(envelope?.basis).toBe("modelled-figure-withheld");
    expect(Array.isArray(envelope?.geom)).toBe(true);
    expect((envelope?.geom as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});

describe("tryComposeEnvelopeModelForDraw — negative control (48453:474034-shaped, no district anywhere)", () => {
  it("reads the ring and the chain, then names the ROUTE's own no-zoning-stamp — a decline, not an unreached attempt", async () => {
    // P-374: this case used to be decided by the caller's own bake facet with
    // NO I/O at all. It is now the shared derivation's terminal answer, which
    // means the ring and the chain are read (the spine is read too, and mocked
    // to null here) before the answer is named. That is the point: the answer
    // is the route's, not a null handed back for "the caller's facet was
    // empty".
    parcelZoning = null;
    // The ring must stamp the SAME node the draw block is for (the identity
    // guard), which is what the real 48453:474034 case does.
    parcelNodeIdStamped = "48453:474034";
    // A chain that EXISTS and carries no rule: the shape that must never be
    // reported as "no chain".
    atomChainResult = { setbackRule: null };
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });
    expect(result).toMatchObject({
      state: "declined",
      refusal: { step: "no-zoning-code", chain: "present" },
    });
    expect(queryGisLayerGeoJsonMock).toHaveBeenCalledTimes(1);
    expect(fetchPropertyAtomChainMock).toHaveBeenCalledTimes(1);
    // No district means nothing to resolve a table against, so the roads are
    // never read.
    expect(fetchNearbyRoadsMock).not.toHaveBeenCalled();
  });

  it("falsifier's other half: the no-district overlay names the MISSING DISTRICT, not unruled setbacks", async () => {
    parcelZoning = null;
    parcelNodeIdStamped = "48453:474034";
    atomChainResult = { setbackRule: null };
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });

    expect(result).toMatchObject({
      state: "declined",
      refusal: { step: "no-zoning-code", chain: "present" },
    });
    if (result.state !== "declined") throw new Error("unreachable");
    const reason = envelopeDrawRefusalReason(result.refusal);
    // The defect, exactly: this used to be the bake's stored
    // `atom_path_pending`, which `envelopeHuman` renders "Withheld, setbacks
    // unruled" — a claim about a setback table this parcel was never asked
    // about, when the real gap was that no district was observed at all.
    expect(reason).toBe("no-zoning-stamp");
    expect(reason).not.toBe("atom_path_pending");

    const draw = assembleParcelDraw({
      parcelNodeId: "48453:474034",
      label: null,
      bakedAt: "2026-09-11",
      countyFips: "48453",
      zoning: null,
      landUse: null,
      yearBuilt: null,
      anchor: { lat: 30.5, lng: -97.9 },
      boundary: { state: "refused", code: "atom-miss" },
      flood: { state: "refused" },
      envelopeRefusalReason: reason,
      envelopeModelled: null,
      pipeline: { state: "refused" },
      well: { state: "refused" },
      specialDistrict: { state: "refused" },
    });

    expect(draw.overlays.find((o) => o.id === "envelope")).toEqual({
      id: "envelope",
      label: "Buildable envelope not computed",
      geom: "none",
      draw: "suppress-setback-line",
      state: "refused",
      reason: "no-zoning-stamp",
    });
  });
});

describe("tryComposeEnvelopeModelForDraw — fail-closed edges", () => {
  it("names `no-query-point` with no I/O", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: null,
    });
    expect(result).toMatchObject({
      state: "unreached",
      refusal: { step: "no-query-point", chain: "unreached" },
    });
    expect(queryGisLayerGeoJsonMock).not.toHaveBeenCalled();
  });

  it("names `parcel-ring-unavailable` when the parcel layer throws — an attempt that never reached an answer, never a decline", async () => {
    parcelGeoThrows = new Error("boom");
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toMatchObject({
      state: "unreached",
      refusal: { step: "parcel-ring-unavailable", chain: "unreached" },
    });
  });

  it("names `parcel-identity-mismatch` when the freshly-fetched parcel's own stamped id disagrees with the requested parcelNodeId (identity guard)", async () => {
    parcelNodeIdStamped = "48021:99999";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toMatchObject({
      state: "unreached",
      refusal: { step: "parcel-identity-mismatch", chain: "unreached" },
    });
  });

  it("names `derivation-threw` for a throw AFTER the ring — never `parcel-ring-unavailable`, and never `absent` for a chain it never read", async () => {
    // The chain read is the first thing downstream of the ring. It throws.
    // Pre-P-339 this was `null`, and the overlay then said the setbacks were
    // unruled. Reporting it as a missing parcel ring (or as "no chain") would
    // be a false step claim of exactly the kind this lane removes.
    atomChainResult = new Error("chain read blew up");
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toMatchObject({
      state: "unreached",
      refusal: { step: "derivation-threw", chain: "unreached" },
    });
  });

  it("names `setbacks-unresolved` for an unresolvable jurisdiction — and with no chain that is the ONE honest `atom_path_pending`", async () => {
    parcelSitusAddress = "1 Main St, Nowhere, XX 00000";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toMatchObject({
      state: "declined",
      refusal: { step: "setbacks-unresolved", chain: "absent" },
    });
    if (result.state !== "declined") throw new Error("unreachable");
    expect(envelopeDrawRefusalReason(result.refusal)).toBe("atom_path_pending");
  });
});

/**
 * P-339's own falsifiers. The dispatch's rule: `atom_path_pending` is
 * reachable ONLY when no property atom chain exists at all. Each of these is
 * inexpressible against the pre-P-339 code, whose only answer was `null`.
 */
describe("P-339 — the route's own outcome decides the reason (falsifiers)", () => {
  it("FALSIFIER: chain PRESENT + no usable table is NOT `atom_path_pending` (the measured defect)", async () => {
    // A parcel that HAS an atom path, whose jurisdiction/district has no wired
    // table and whose chain carries no usable rule. Pre-P-339 this returned
    // `null` and the overlay fell back to the bake's token, so the customer
    // read "Withheld, setbacks unruled" about a parcel with a live atom chain.
    atomChainResult = { setbackRule: null };
    parcelSitusAddress = "1 Main St, Nowhere, XX 00000";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toMatchObject({
      state: "declined",
      refusal: { step: "setbacks-unresolved", chain: "present" },
    });
    if (result.state !== "declined") throw new Error("unreachable");
    const reason = envelopeDrawRefusalReason(result.refusal);
    expect(reason).toBe("setbacks-unresolved");
    expect(reason).not.toBe("atom_path_pending");
  });

  it("the ONE surviving `atom_path_pending`: the same step with the chain ABSENT", async () => {
    atomChainResult = null;
    parcelSitusAddress = "1 Main St, Nowhere, XX 00000";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    if (result.state !== "declined") throw new Error("unreachable");
    expect(result.refusal.chain).toBe("absent");
    expect(envelopeDrawRefusalReason(result.refusal)).toBe("atom_path_pending");
  });

  it("P60b's split survives the re-pointing: a real derivation refusal serves the route's own wireStatus, unflattened", () => {
    // `no-buildable-area` is a MEASUREMENT (the setbacks genuinely consume the
    // lot) and `geometry-validation-failed` is a GATE decline. Neither is a
    // withhold and the two must not collapse back into one token here.
    expect(
      envelopeDrawRefusalReason({
        step: "derivation-not-drawn",
        chain: "present",
        declinedBy: "no-buildable-area",
      }),
    ).toBe("no-buildable-area");
    expect(
      envelopeDrawRefusalReason({
        step: "derivation-not-drawn",
        chain: "present",
        declinedBy: "geometry-validation-failed",
      }),
    ).toBe("geometry-validation-failed");
    // Nothing declined it: the gate token, never the withhold.
    expect(
      envelopeDrawRefusalReason({
        step: "derivation-not-drawn",
        chain: "present",
        declinedBy: null,
      }),
    ).toBe("geometry-validation-failed");
  });
});

/**
 * P-374 — THE DIVERGENCE TEST, at the call-site level.
 *
 * The mission is not "the draw block agrees with the route in the cases we
 * thought of"; it is "there is ONE derivation, and a test fails when the two
 * callers' answers differ". These two tests run the route's own call shape
 * (`deriveEnvelopeDraw` with the request-geocode jurisdiction context, exactly
 * as `deriveAndRespond` passes it) against the draw block's own call shape
 * (`tryComposeEnvelopeModelForDraw`, no geocode, a city-less situs) on the SAME
 * parcel fixture, and assert one answer: same resolved district, same axes,
 * same polygon.
 *
 * The route's version of the same comparison runs in
 * `src/__tests__/brokeragePlaceBuildableEnvelope.test.ts` (both surfaces over
 * real HTTP and the real handler); this one is the fast, DB-free half, and the
 * two together are the lane's divergence instrument.
 *
 * THE ONE INPUT THE TWO CALLERS CANNOT SHARE is the REQUEST GEOCODE: the route
 * has the caller's address, the draw block has only the card. `propertyExplorer.ts`
 * closes that by passing `resolveSitusCity(...)` — the card's own composed city,
 * the value the label already serves — which is why the first test seeds exactly
 * that and why every one of the five measured parcels (each carrying a card city)
 * reaches the parity case. When a card carries NO city anywhere AND the parcel
 * node's county wires more than one city with that district code, the draw block
 * declines where a geocoded route drew. That residual INPUT gap is named in the
 * close's `leave_behind`; it is not papered over here by weakening the reason
 * rule, and it is what the second test proves the parity check can detect.
 */
describe("P-374 — the route's inputs and the draw block's inputs reach ONE answer", () => {
  async function routeStyleDerivation() {
    const { deriveEnvelopeDraw } = await import("./envelopeDrawDerivation");
    const parcengeo = await queryGisLayerGeoJsonMock();
    return deriveEnvelopeDraw({
      parcelGeo: parcengeo,
      // The route's own context, as `deriveAndRespond` passes it: the request's
      // geocode city/state, the request address, and its point.
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      address: "1209 Main St, Bastrop, TX 78602",
      point: { lat: BASTROP_LAT, lng: BASTROP_LNG },
      skipRoad: false,
    });
  }

  it("parity: seeded with the CARD's own city (what propertyExplorer passes), the draw block draws what the route draws", async () => {
    // The draw block's production input, byte for byte: `propertyExplorer.ts`
    // passes `resolveSitusCity(...)`'s city — the same city the label already
    // serves — as this call site's equivalent of the route's geocode city. The
    // situs string here is deliberately city-LESS, so the city can only have
    // come from that seeding.
    parcelSitusAddress = "1209 Main St";
    parcelZoning = "R-MD";
    parcelNodeIdStamped = BASTROP_PARCEL_NODE_ID;

    const route = await routeStyleDerivation();
    expect(route.state).toBe("drawn");

    const drawBlock = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(drawBlock.state).toBe("modelled");

    if (route.state !== "drawn" || drawBlock.state !== "modelled") {
      throw new Error("unreachable");
    }
    // The seeding reached the route's own jurisdiction key (the engagement
    // resolver's underscore form; the setback adapter normalizes it, which is
    // why the table resolves below). Asserted so a future change that silently
    // drops the city seed fails HERE rather than as a district mismatch.
    expect(route.jurisdictionKey).toBe("bastrop_tx");
    // THE PARITY ASSERTION: district, the four axes, and the polygon.
    expect(drawBlock.model.setbacks.district).toBe(route.effectiveZoningCode);
    expect(drawBlock.model.setbacks).toEqual({
      front_ft: route.resolved.scalars.front_ft,
      side_ft: route.resolved.scalars.side_ft,
      rear_ft: route.resolved.scalars.rear_ft,
      ...(typeof route.resolved.scalars.side_corner_ft === "number"
        ? { side_corner_ft: route.resolved.scalars.side_corner_ft }
        : {}),
      district: route.effectiveZoningCode,
    });
    const routeFeature = route.derived.geojson.features[0] as unknown as {
      geometry: { coordinates: [number, number][][] };
    };
    expect(drawBlock.model.ringLngLat).toEqual(routeFeature.geometry.coordinates[0]);
  });

  it("THE PARITY CHECK CAN FAIL: a jurisdiction the route never used makes the two answers differ", async () => {
    // The control. If the two callers could not disagree, the test above would
    // prove nothing — so here is a case where they must not agree, and the
    // equality the test above asserts is the thing that breaks.
    parcelSitusAddress = "1209 Main St";
    parcelZoning = "R-MD";
    parcelNodeIdStamped = BASTROP_PARCEL_NODE_ID;

    const route = await routeStyleDerivation();
    const drawBlock = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      // A jurisdiction the parcel is not in.
      jurisdictionCity: "Nowhere",
      jurisdictionState: "XX",
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });

    const routeDrew = route.state === "drawn";
    const drawBlockDrew = drawBlock.state === "modelled";
    expect(routeDrew).toBe(true);
    expect(drawBlockDrew).toBe(false);
    expect(drawBlockDrew === routeDrew).toBe(false);
  });
});
