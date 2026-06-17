import { describe, expect, it } from "vitest";

import { buildMapReasoningOverlays } from "../brokerageMapReasoningOverlays";
import type { MapLayersAssemblePayload } from "../engineSpineMapLayers";

const baseAssemble: MapLayersAssemblePayload = {
  parcelKey: "test-1",
  place: { latitude: 30.27, longitude: -97.74 },
  tenantScope: "default",
  assembledAt: "2026-06-17T00:00:00.000Z",
  layers: [
    {
      layerKey: "floodway",
      status: "ok",
      adapterKey: "fema:nfhl-flood-zone",
      envelope: {
        payload: {
          kind: "floodway",
          attributes: { inFloodway: true },
        },
        confidence: { value: 1, kind: "deterministic" },
        dataVintage: "2026-06-01T00:00:00.000Z",
        coverage: { degraded: false },
        source: { adapter: "fema:nfhl-flood-zone" },
      },
    },
    {
      layerKey: "opportunity-zone-tract",
      status: "ok",
      adapterKey: "national:opportunity-zone",
      envelope: {
        payload: {
          kind: "opportunity-zone-tract",
          attributes: { inOpportunityZone: true, tractGeoid: "48453002400" },
        },
        confidence: { value: 1, kind: "deterministic" },
        dataVintage: "2026-06-01T00:00:00.000Z",
        coverage: { degraded: false },
        source: { adapter: "national:opportunity-zone" },
      },
    },
  ],
};

describe("buildMapReasoningOverlays", () => {
  it("pins floodway and OZ reasoning to parcel anchor", () => {
    const overlays = buildMapReasoningOverlays({
      assemble: baseAssemble,
      verdict: {
        status: "worth_a_look",
        headline: "Worth a look at the right basis",
        rationale: ["Strong rent comps"],
        killFactors: [],
        opportunityFactors: [],
        ozLine: "In OZ tract 48453002400 (oz-1.0 round)",
        mudPidLine: null,
        generatedAt: "2026-06-17T00:00:00.000Z",
      },
    });

    expect(overlays.length).toBeGreaterThanOrEqual(3);
    for (const o of overlays) {
      expect(o.anchor).toEqual({ latitude: 30.27, longitude: -97.74 });
    }
    expect(overlays.some((o) => o.kind === "floodway")).toBe(true);
    expect(overlays.some((o) => o.kind === "verdict")).toBe(true);
  });
});
