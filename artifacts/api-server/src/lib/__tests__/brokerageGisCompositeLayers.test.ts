import { describe, expect, it } from "vitest";
import {
  buildCompositeLayerFixture,
  listCompositeLayerEndpoints,
  queryCompositeLayer,
} from "../brokerageGisCompositeLayers";

const bbox = {
  westLng: -97.32,
  southLat: 30.1,
  eastLng: -97.3,
  northLat: 30.12,
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
});
