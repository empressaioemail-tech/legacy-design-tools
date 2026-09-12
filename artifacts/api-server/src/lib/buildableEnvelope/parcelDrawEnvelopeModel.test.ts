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

const fetchPropertyAtomChainMock = vi.fn(async () => null);
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

afterEach(() => {
  parcelZoning = "R-MD";
  parcelNodeIdStamped = BASTROP_PARCEL_NODE_ID;
  parcelSitusAddress = "1209 Main St, Bastrop, TX 78602";
  parcelGeoThrows = null;
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
    expect(result).not.toBeNull();
    expect(result!.ringLngLat.length).toBeGreaterThanOrEqual(4);
    expect(result!.setbacks.district).toBe("R-MD");
    expect(result!.setbacks.front_ft).toBeGreaterThan(0);
    expect(typeof result!.disclosure).toBe("string");
    expect(result!.disclosure.length).toBeGreaterThan(0);
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
    expect(result).not.toBeNull();

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
      envelopeRefusalReason: "atom_path_pending",
      envelopeModelled: result,
      pipeline: { state: "refused" },
      well: { state: "refused" },
      specialDistrict: { state: "refused" },
    });

    const envelope = draw.overlays.find((o) => o.id === "envelope");
    expect(envelope?.state).toBe("present");
    expect(envelope).not.toHaveProperty("reason");
    expect(Array.isArray(envelope?.geom)).toBe(true);
    expect((envelope?.geom as unknown[]).length).toBeGreaterThanOrEqual(4);
  });
});

describe("tryComposeEnvelopeModelForDraw — negative control (48453:474034-shaped, no zoning code)", () => {
  it("returns null without any I/O when there is no baked zoning code (the unincorporated / no-district case)", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      zoningCode: null,
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });
    expect(result).toBeNull();
    expect(queryGisLayerGeoJsonMock).not.toHaveBeenCalled();
    expect(fetchPropertyAtomChainMock).not.toHaveBeenCalled();
    expect(fetchNearbyRoadsMock).not.toHaveBeenCalled();
  });

  it("falsifier's other half: with no modelled envelope, assembleParcelDraw's refused overlay is exactly today's shape (unchanged)", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: "48453:474034",
      zoningCode: null,
      queryPoint: { latitude: 30.5, longitude: -97.9 },
    });
    expect(result).toBeNull();

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
      envelopeRefusalReason: "atom_path_pending",
      envelopeModelled: result,
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
      reason: "atom_path_pending",
    });
  });
});

describe("tryComposeEnvelopeModelForDraw — fail-closed edges", () => {
  it("returns null with no queryPoint (no I/O)", async () => {
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      zoningCode: "R-MD",
      queryPoint: null,
    });
    expect(result).toBeNull();
    expect(queryGisLayerGeoJsonMock).not.toHaveBeenCalled();
  });

  it("returns null when no parcel polygon is found at the point", async () => {
    parcelGeoThrows = new Error("boom");
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      zoningCode: "R-MD",
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toBeNull();
  });

  it("returns null when the freshly-fetched parcel's own stamped id disagrees with the requested parcelNodeId (identity guard)", async () => {
    parcelNodeIdStamped = "48021:99999";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      zoningCode: "R-MD",
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toBeNull();
  });

  it("returns null for an unresolvable jurisdiction (no wired setback table for that city/district)", async () => {
    parcelSitusAddress = "1 Main St, Nowhere, XX 00000";
    const result = await tryComposeEnvelopeModelForDraw({
      parcelNodeId: BASTROP_PARCEL_NODE_ID,
      zoningCode: "Z-NOPE",
      queryPoint: { latitude: BASTROP_LAT, longitude: BASTROP_LNG },
    });
    expect(result).toBeNull();
  });
});
