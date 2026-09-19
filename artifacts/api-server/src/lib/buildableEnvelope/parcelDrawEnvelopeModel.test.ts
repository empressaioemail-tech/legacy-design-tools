/**
 * P-153 Step B. `tryComposeEnvelopeModelForDraw` orchestrates the SAME I/O +
 * pure-composition sequence `deriveAndRespond`/`deriveLabelAndRespond` run
 * for the map/export route, seeded from a point the caller already resolved
 * (no geocode, no situs disambiguation). Mocks the three I/O boundaries
 * (`queryGisLayerGeoJson`, `fetchPropertyAtomChain`, `fetchNearbyRoads`) so
 * this is deterministic and offline; everything else (resolveAuthoritativeSetbacks,
 * jurisdiction resolution, labelEdges, composeBuildableEnvelopeDerivation) runs
 * for real, against the real Bastrop codified-ordinance setback table (the
 * same fixture `brokeragePlaceBuildableEnvelope.test.ts` and
 * `parcelDrawStub.test.ts`'s gold fixture both key off: Bastrop, TX / SF-1
 * shaped, mirroring the real 48021:34049 case).
 *
 * `composeBuildableEnvelopeDerivation`/`firstParcelRing` are reused straight
 * off this same directory's `composeBuildableEnvelopeDerivation.ts` (moved
 * there in Step A specifically so importing them stays light — see that
 * file's own doc comment). The remaining unavoidable `@workspace/db`
 * coupling here is `@workspace/codes`'s `keyFromEngagementOrSynthesize`
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
  queryGisLayerGeoJsonMock.mockClear();
  fetchPropertyAtomChainMock.mockClear();
  fetchNearbyRoadsMock.mockClear();
});

describe("tryComposeEnvelopeModelForDraw — positive control (48021:34049-shaped, atom-pending, SF/R-MD zoned)", () => {
  it("resolves a real modelled envelope: closed-enough ring, applied setbacks, a disclosure string", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      zoningCode: "R-MD",
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
      zoningCode: "R-MD",
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

describe("tryComposeEnvelopeModelForDraw — negative control (48453:474034-shaped, no zoning code)", () => {
  it("names the step, with no I/O, when there is no baked zoning code (the unincorporated / no-district case)", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      zoningCode: null,
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });
    expect(result).toMatchObject({
      state: "unreached",
      refusal: { step: "no-zoning-code", chain: "unreached" },
    });
    expect(queryGisLayerGeoJsonMock).not.toHaveBeenCalled();
    expect(fetchPropertyAtomChainMock).not.toHaveBeenCalled();
    expect(fetchNearbyRoadsMock).not.toHaveBeenCalled();
  });

  it("falsifier's other half: the no-district overlay now names the MISSING DISTRICT, not unruled setbacks", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      zoningCode: null,
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });
    expect(result.state).toBe("unreached");
    if (result.state !== "unreached") throw new Error("unreachable");

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
      zoningCode: "R-MD",
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
      zoningCode: "R-MD",
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
      zoningCode: "R-MD",
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
      zoningCode: "R-MD",
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
      zoningCode: "Z-NOPE",
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
      zoningCode: "Z-NOPE",
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
      zoningCode: "Z-NOPE",
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
