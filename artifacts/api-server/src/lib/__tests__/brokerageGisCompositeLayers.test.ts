import { describe, expect, it } from "vitest";
import {
  buildCompositeLayerFixture,
  deriveOzDealCrossfilter,
  listCompositeLayerEndpoints,
  queryCompositeLayer,
} from "../brokerageGisCompositeLayers";

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
  it("builds buildable-envelope polygon inside parcel", () => {
    const payload = buildCompositeLayerFixture("buildable-envelope", bbox);
    expect(payload.fixture).toBe(true);
    expect(payload.geojson.features).toHaveLength(1);
    const props = (
      payload.geojson.features[0] as { properties: Record<string, unknown> }
    ).properties;
    expect(props.kind).toBe("buildable-envelope");
    expect(props.constraintsRemoved).toContain("floodplain");
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

describe("queryCompositeLayer", () => {
  it("wraps payload in EngineEnvelope with honesty fields", () => {
    const envelope = queryCompositeLayer({
      layer: "constraint-density",
      bbox,
      fixture: true,
    });
    expect(envelope.payload.layer).toBe("constraint-density");
    expect(envelope.confidence.kind).toBe("asserted");
    expect(envelope.source.adapter).toContain("brokerage:composite");
    expect(envelope.coverage.degraded).toBe(true);
    expect(envelope.payload.geojson.type).toBe("FeatureCollection");
  });

  it("oz-deal-crossfilter is a real derivation: not degraded, deterministic, provenance-bearing", () => {
    const envelope = queryCompositeLayer({
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
