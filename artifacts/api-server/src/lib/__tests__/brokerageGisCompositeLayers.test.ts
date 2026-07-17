import { describe, expect, it, vi } from "vitest";
import {
  buildCompositeLayerFixture,
  deriveBuildableEnvelope,
  deriveConstraintDensity,
  deriveOzDealCrossfilter,
  listCompositeLayerEndpoints,
  queryCompositeLayer,
} from "../brokerageGisCompositeLayers";
import * as gisLayers from "../brokerageGisLayers";
import * as federalLayers from "../brokerageGisFederalLayers";

const bbox = {
  westLng: -97.32,
  southLat: 30.1,
  eastLng: -97.3,
  northLat: 30.12,
};

// Real Travis County OZ tract 48453001712 sits inside this viewport.
const travisOzBbox = {
  westLng: -97.807,
  southLat: 30.214,
  eastLng: -97.788,
  northLat: 30.234,
};

// Inside the bundled Central-TX coverage envelope but overlapping no OZ tract.
const inScopeEmptyBbox = {
  westLng: -98.572,
  southLat: 29.44,
  eastLng: -98.567,
  northLat: 29.446,
};

// Miami, FL — outside the bundled Central-TX coverage envelope entirely.
const outOfScopeBbox = {
  westLng: -80.0,
  southLat: 25.0,
  eastLng: -79.99,
  northLat: 25.01,
};

describe("listCompositeLayerEndpoints", () => {
  it("lists four composite map layers", () => {
    expect(listCompositeLayerEndpoints().map((l) => l.layer)).toEqual([
      "buildable-envelope",
      "constraint-density",
      "oz-deal-crossfilter",
      "motivated-seller",
    ]);
  });
});

describe("buildCompositeLayerFixture", () => {
  it("no longer serves buildable-envelope synchronously (it is a real async derivation)", () => {
    expect(() => buildCompositeLayerFixture("buildable-envelope", bbox)).toThrow(
      /real async derivation/i,
    );
  });

  it("no longer serves constraint-density synchronously (it is a real async derivation)", () => {
    expect(() =>
      buildCompositeLayerFixture("constraint-density", bbox),
    ).toThrow(/real async derivation/i);
  });

  it("builds motivated-seller heat properties", () => {
    const payload = buildCompositeLayerFixture("motivated-seller", bbox);
    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    expect(props.motivatedSellerHeat).toBeGreaterThan(0);
    expect(props.propensity).toBeGreaterThan(0);
  });
});

// A minimal fake parcel FeatureCollection the derivation can consume, so the
// three-state honesty is exercised without live Cotality/corpus access.
function fakeParcelResult(props: Record<string, unknown>) {
  return {
    layer: "parcels" as const,
    serviceUrl: "https://example.test/parcels",
    provider: "Test County GIS (parcels)",
    adapterKey: "test:parcels",
    provider2: undefined,
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            // ~100m x ~100m parcel near Austin, TX.
            coordinates: [
              [
                [-97.75, 30.25],
                [-97.749, 30.25],
                [-97.749, 30.251],
                [-97.75, 30.251],
                [-97.75, 30.25],
              ],
            ],
          },
          properties: props,
        },
      ],
    },
    featureCount: 1,
    queryMode: "bbox" as const,
    notSurveyGrade: true,
  };
}

describe("deriveBuildableEnvelope (three-state coverage honesty)", () => {
  it("STATE c: no parcel geometry -> degraded:true, honest missing-input reason, never a fixture 78%", async () => {
    const spy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockRejectedValueOnce(new Error("no-coverage"));
    const { payload, honesty } = await deriveBuildableEnvelope(bbox);
    spy.mockRestore();

    expect(payload.fixture).toBe(false);
    expect(payload.featureCount).toBe(0);
    expect(payload.buildableProvenance?.coverage).toBe("out-of-scope");
    expect(payload.buildableProvenance?.parcel.resolved).toBe(false);
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.coverage.reason).toMatch(/parcel geometry unavailable/i);
    expect(honesty.confidence.kind).not.toBe("deterministic");
    // No fabricated buildableAreaPct anywhere.
    expect(JSON.stringify(payload)).not.toMatch(/"buildableAreaPct":\s*78/);
  });

  it("STATE c-alt: parcel resolved but NO dimensional atom -> degraded, parcel-only, no guessed dimensions", async () => {
    const spy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      // Zoning present but jurisdiction won't resolve to any corpus dimensions
      // (no network in test env -> retrieval throws -> all dims null).
      .mockResolvedValueOnce(
        fakeParcelResult({
          zoningCode: "SF-3",
          city: "Nowhereville",
          state: "ZZ",
        }) as never,
      );
    const { payload, honesty } = await deriveBuildableEnvelope(bbox);
    spy.mockRestore();

    expect(payload.fixture).toBe(false);
    expect(payload.buildableProvenance?.parcel.resolved).toBe(true);
    expect(payload.buildableProvenance?.dimensionalStandards.completeness).toBe(
      "none",
    );
    expect(payload.buildableProvenance?.coverage).toBe("out-of-scope");
    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    // Parcel outline returned, but buildableAreaPct is null (NOT guessed).
    expect(props.kind).toBe("buildable-envelope");
    expect(props.derived).toBe(false);
    expect(props.buildableAreaPct).toBeNull();
    expect(honesty.coverage.degraded).toBe(true);
  });

  it("STATE a: parcel + injected dimensions -> derived buildableAreaPct from geometry, earned honesty, labeled approximation", async () => {
    const parcelSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockResolvedValueOnce(
        fakeParcelResult({
          zoningCode: "SF-3",
          city: "Austin",
          state: "TX",
        }) as never,
      );
    // Inject a full dimensional set via the codes retrieval path.
    const codes = await import("@workspace/codes");
    const retrievalSpy = vi
      .spyOn(codes, "retrieveAtomsForQuestion")
      .mockResolvedValue([
        {
          id: "atom:test:setbacks",
          sourceName: "Test UDC",
          jurisdictionKey: "austin_tx",
          codeBook: "UDC",
          edition: "2020",
          sectionNumber: "25-2",
          sectionTitle: "Dimensional standards",
          body:
            "Front setback 25 feet. Side setback 5 feet. Rear setback 10 feet. Maximum floor area ratio of 0.4. Maximum lot coverage of 40%. Maximum building height 35 feet.",
          sourceUrl: "https://example.test/udc/25-2",
          score: 0.9,
          retrievalMode: "lexical",
        },
      ] as never);

    const { payload, honesty } = await deriveBuildableEnvelope(bbox);
    parcelSpy.mockRestore();
    retrievalSpy.mockRestore();

    expect(payload.fixture).toBe(false);
    expect(payload.buildableProvenance?.coverage).toBe("in-scope-derived");
    expect(
      payload.buildableProvenance?.dimensionalStandards.citedAtomIds,
    ).toContain("atom:test:setbacks");
    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    expect(props.derived).toBe(true);
    expect(props.approximation).toBe(true);
    // Derived from geometry: a real 0..100 number, and NOT the old fixture 78.
    expect(typeof props.buildableAreaPct).toBe("number");
    expect(props.buildableAreaPct).toBeGreaterThanOrEqual(0);
    expect(props.buildableAreaPct).toBeLessThanOrEqual(100);
    expect(props.buildableAreaPct).not.toBe(78);
    // Reasoning cites the code atom + labels the approximation.
    expect(String(props.reasoning)).toMatch(/atom:test:setbacks/);
    expect(String(props.reasoning)).toMatch(/approximation/i);
    // Earned honesty on a full set: not degraded.
    expect(honesty.coverage.degraded).toBe(false);
  });
});

describe("queryCompositeLayer", () => {
  it("wraps constraint-density payload in EngineEnvelope with honesty fields", async () => {
    // All constraint layers unreachable -> real derivation degrades honestly.
    const femaSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockRejectedValue(new Error("upstream-error"));
    const fedSpy = vi
      .spyOn(federalLayers, "queryFederalGisLayerGeoJson")
      .mockRejectedValue(new Error("upstream-error"));
    const envelope = await queryCompositeLayer({
      layer: "constraint-density",
      bbox,
      fixture: true,
    });
    femaSpy.mockRestore();
    fedSpy.mockRestore();
    expect(envelope.payload.layer).toBe("constraint-density");
    // An explicit fixture flag must NOT resurrect the old constraintCount:4 fixture.
    expect(envelope.payload.fixture).toBe(false);
    expect(envelope.confidence.kind).toBe("asserted");
    expect(envelope.source.adapter).toContain("brokerage:composite");
    expect(envelope.coverage.degraded).toBe(true);
    expect(envelope.payload.constraintProvenance?.coverage).toBe("out-of-scope");
    expect(envelope.payload.geojson.type).toBe("FeatureCollection");
  });

  it("buildable-envelope routes through the real async derivation (degrades honestly without parcel input)", async () => {
    const spy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockRejectedValueOnce(new Error("no-coverage"));
    const envelope = await queryCompositeLayer({
      layer: "buildable-envelope",
      bbox,
      // an explicit fixture flag must NOT resurrect the old 78% fixture
      fixture: true,
    });
    spy.mockRestore();
    expect(envelope.payload.layer).toBe("buildable-envelope");
    expect(envelope.payload.fixture).toBe(false);
    expect(envelope.coverage.degraded).toBe(true);
    expect(envelope.payload.buildableProvenance?.coverage).toBe("out-of-scope");
  });

  it("oz-deal-crossfilter is a real derivation: not degraded, deterministic, provenance-bearing", async () => {
    const envelope = await queryCompositeLayer({
      layer: "oz-deal-crossfilter",
      bbox: travisOzBbox,
      // an explicit fixture flag must NOT downgrade the real OZ derivation
      fixture: true,
    });
    expect(envelope.payload.layer).toBe("oz-deal-crossfilter");
    expect(envelope.payload.fixture).toBe(false);
    expect(envelope.coverage.degraded).toBe(false);
    expect(envelope.confidence.kind).toBe("deterministic");
    expect(envelope.payload.provenance?.ozDesignation.source).toContain("CDFI");
    // Cotality propensity must never leak into the public composite.
    expect(envelope.payload.provenance?.dealSignal.excludes).toContain(
      "cotality-propensity",
    );
    expect(envelope.payload.featureCount).toBeGreaterThan(0);
  });
});

// A constraint polygon covering the whole test bbox, so it overlaps every cell.
function fullBboxFeature(
  props: Record<string, unknown>,
): { type: "Feature"; geometry: unknown; properties: Record<string, unknown> } {
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [bbox.westLng, bbox.southLat],
          [bbox.eastLng, bbox.southLat],
          [bbox.eastLng, bbox.northLat],
          [bbox.westLng, bbox.northLat],
          [bbox.westLng, bbox.southLat],
        ],
      ],
    },
    properties: props,
  };
}

function fakeFemaResult(features: unknown[]) {
  return {
    layer: "fema" as const,
    serviceUrl: "https://example.test/fema",
    provider: "FEMA NFHL",
    adapterKey: "fema:nfhl-flood-zone",
    geojson: { type: "FeatureCollection" as const, features },
    featureCount: features.length,
    queryMode: "bbox" as const,
  };
}

function fakeFederalResult(
  layer: string,
  features: unknown[],
) {
  return {
    layer,
    serviceUrl: "https://example.test/federal",
    provider: "Test federal",
    adapterKey: `test:${layer}`,
    geojson: { type: "FeatureCollection" as const, features },
    featureCount: features.length,
    queryMode: "bbox" as const,
  };
}

describe("deriveConstraintDensity (severity-weighted layer stack + honesty)", () => {
  it("STATE c: zero constraint layers reachable -> out-of-scope, degraded, never a fabricated density", async () => {
    const femaSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockRejectedValue(new Error("upstream-error"));
    const fedSpy = vi
      .spyOn(federalLayers, "queryFederalGisLayerGeoJson")
      .mockRejectedValue(new Error("upstream-error"));
    const { payload, honesty } = await deriveConstraintDensity(bbox);
    femaSpy.mockRestore();
    fedSpy.mockRestore();

    expect(payload.fixture).toBe(false);
    expect(payload.featureCount).toBe(0);
    expect(payload.constraintProvenance?.coverage).toBe("out-of-scope");
    expect(payload.constraintProvenance?.layersEvaluated).toBe(0);
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.confidence.kind).not.toBe("deterministic");
    // No fabricated density / no old constraintCount:4 fixture.
    expect(JSON.stringify(payload)).not.toMatch(/"constraintDensity":/);
    // Every layer recorded as not-evaluated (unknown), never zero-constraint.
    for (const l of payload.constraintProvenance?.contributingLayers ?? []) {
      expect(l.evaluated).toBe(false);
    }
  });

  it("STATE a: all layers evaluated -> in-scope-derived, degraded:false, density derived from the stack", async () => {
    // FEMA returns an AE (SFHA, severity 3) polygon; the three federal layers
    // return constraint polygons too -> full stack.
    const femaSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockResolvedValue(
        fakeFemaResult([fullBboxFeature({ FLD_ZONE: "AE" })]) as never,
      );
    const fedSpy = vi
      .spyOn(federalLayers, "queryFederalGisLayerGeoJson")
      .mockImplementation((async (input: { layer: string }) => {
        if (input.layer === "ssurgo-soils")
          return fakeFederalResult("ssurgo-soils", [
            fullBboxFeature({ shrinkswell: "High", foundationRiskScore: 4 }),
          ]) as never;
        if (input.layer === "edwards-aquifer")
          return fakeFederalResult("edwards-aquifer", [
            fullBboxFeature({ edwardsZone: "recharge" }),
          ]) as never;
        return fakeFederalResult("mud-pid", [
          fullBboxFeature({ districtType: "MUD" }),
        ]) as never;
      }) as never);

    const { payload, honesty } = await deriveConstraintDensity(bbox);
    femaSpy.mockRestore();
    fedSpy.mockRestore();

    expect(payload.fixture).toBe(false);
    expect(payload.constraintProvenance?.coverage).toBe("in-scope-derived");
    expect(payload.constraintProvenance?.layersEvaluated).toBe(4);
    expect(honesty.coverage.degraded).toBe(false);
    expect(payload.featureCount).toBeGreaterThan(0);

    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    // A real derived 0..1 density, never a synthetic fixture number.
    expect(typeof props.constraintDensity).toBe("number");
    expect(props.constraintDensity as number).toBeGreaterThan(0);
    expect(props.constraintDensity as number).toBeLessThanOrEqual(1);
    expect(props.partial).toBe(false);
    // Reasoning cites the contributing layers per commitment #1.
    expect(String(props.reasoning)).toMatch(/FEMA NFHL flood/);
    expect(String(props.reasoning)).toMatch(/severity/i);
    expect(props.confidenceKind).toBe("asserted");
    expect(props.generatedAt).toBeTruthy();
  });

  it("STATE b (partial stack): 2 of 4 layers evaluated -> in-scope-partial, lowered confidence, unevaluated layers recorded as unknown NOT zero", async () => {
    // FEMA + SSURGO reachable; Edwards + MUD/PID unreachable.
    const femaSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockResolvedValue(
        fakeFemaResult([fullBboxFeature({ FLD_ZONE: "AE" })]) as never,
      );
    const fedSpy = vi
      .spyOn(federalLayers, "queryFederalGisLayerGeoJson")
      .mockImplementation((async (input: { layer: string }) => {
        if (input.layer === "ssurgo-soils")
          return fakeFederalResult("ssurgo-soils", [
            fullBboxFeature({ shrinkswell: "High", foundationRiskScore: 4 }),
          ]) as never;
        throw new Error("upstream-error");
      }) as never);

    const { payload, honesty } = await deriveConstraintDensity(bbox);
    femaSpy.mockRestore();
    fedSpy.mockRestore();

    expect(payload.constraintProvenance?.coverage).toBe("in-scope-partial");
    expect(payload.constraintProvenance?.layersEvaluated).toBe(2);
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.coverage.reason).toMatch(/partial/i);

    const layers = payload.constraintProvenance?.contributingLayers ?? [];
    const edwards = layers.find((l) => l.key === "edwards-aquifer");
    const mud = layers.find((l) => l.key === "mud-pid");
    // Unreachable layers are recorded as not-evaluated (unknown), never zero.
    expect(edwards?.evaluated).toBe(false);
    expect(mud?.evaluated).toBe(false);
    expect(edwards?.note).toMatch(/unknown, not confirmed-none/i);

    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    expect(props.partial).toBe(true);
    expect(props.layersNotEvaluated).toContain("edwards-aquifer");
    expect(props.layersNotEvaluated).toContain("mud-pid");
    // Reasoning tells the reader the stack is partial.
    expect(String(props.reasoning)).toMatch(/not evaluated|PARTIAL/i);
    // Lowered confidence relative to a full stack.
    expect(props.confidence as number).toBeLessThan(0.68);
  });

  it("FEMA zone X (minimal hazard) contributes zero constraint, not a false positive", async () => {
    // Only FEMA reachable, and it returns zone X -> no constraint feature there.
    const femaSpy = vi
      .spyOn(gisLayers, "queryGisLayerGeoJson")
      .mockResolvedValue(
        fakeFemaResult([fullBboxFeature({ FLD_ZONE: "X" })]) as never,
      );
    const fedSpy = vi
      .spyOn(federalLayers, "queryFederalGisLayerGeoJson")
      .mockRejectedValue(new Error("upstream-error"));
    const { payload } = await deriveConstraintDensity(bbox);
    femaSpy.mockRestore();
    fedSpy.mockRestore();

    // FEMA evaluated (reachable) but zone X yields no constraint feature.
    const fema = (payload.constraintProvenance?.contributingLayers ?? []).find(
      (l) => l.key === "fema-flood",
    );
    expect(fema?.evaluated).toBe(true);
    expect(fema?.featureCount).toBe(0);
    // No constrained cells (X isn't a constraint, other layers unreachable).
    expect(payload.featureCount).toBe(0);
  });
});

describe("deriveOzDealCrossfilter", () => {
  it("resolves real designated OZ tracts overlapping the viewport with earned provenance", () => {
    const { payload, honesty } = deriveOzDealCrossfilter(travisOzBbox);
    expect(payload.fixture).toBe(false);
    expect(payload.featureCount).toBeGreaterThan(0);
    const feature = payload.geojson.features[0] as {
      properties: Record<string, unknown>;
    };
    expect(String(feature.properties.geoid10)).toMatch(/^48453/);
    expect(feature.properties.inOpportunityZone).toBe(true);
    // No fabricated deal score / radar tier — v1 signal is OZ membership.
    expect(feature.properties.dealScore).toBeUndefined();
    expect(feature.properties.radarTier).toBeUndefined();
    expect(feature.properties.dealSignal).toBe("oz-designation-membership");
    // Commitment #1: reasoning + source + confidence + timestamp on every output.
    expect(typeof feature.properties.reasoning).toBe("string");
    expect(feature.properties.source).toBeTruthy();
    expect(feature.properties.confidenceKind).toBe("deterministic");
    expect(feature.properties.generatedAt).toBeTruthy();
    // Honesty is earned (deterministic), not degraded.
    expect(honesty.confidence.kind).toBe("deterministic");
    expect(honesty.coverage.degraded).toBe(false);
  });

  it("in-scope viewport with no OZ tract is a confident empty (degraded:false)", () => {
    const { payload, honesty } = deriveOzDealCrossfilter(inScopeEmptyBbox);
    expect(payload.fixture).toBe(false);
    expect(payload.featureCount).toBe(0);
    expect(payload.provenance?.ozDesignation.coverage).toBe("in-scope");
    // Genuinely no OZ here, and we can say so: not degraded, deterministic.
    expect(honesty.coverage.degraded).toBe(false);
    expect(honesty.confidence.kind).toBe("deterministic");
  });

  it("out-of-scope viewport is degraded (unknown), never a confident empty", () => {
    const { payload, honesty } = deriveOzDealCrossfilter(outOfScopeBbox);
    expect(payload.fixture).toBe(false);
    expect(payload.featureCount).toBe(0);
    expect(payload.provenance?.ozDesignation.coverage).toBe("out-of-scope");
    // Absence here is unknown, not confirmed-none: must degrade honestly.
    expect(honesty.coverage.degraded).toBe(true);
    expect(honesty.coverage.reason).toMatch(/not hydrated|does not cover/i);
    expect(honesty.confidence.kind).not.toBe("deterministic");
    // Provenance still carries the national-count reconciliation note.
    expect(payload.provenance?.ozDesignation.nationalCountNote).toMatch(
      /8764/,
    );
  });
});
