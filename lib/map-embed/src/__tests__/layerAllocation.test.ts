import { describe, expect, it } from "vitest";
import { resolveLayerAllocation } from "../layerAllocation.js";

describe("resolveLayerAllocation", () => {
  it("returns distinct layer sets for cortex vs radar on the same report type", () => {
    const cortex = resolveLayerAllocation({
      appId: "cortex",
      reportType: "property-brief",
      tier: "pro",
    });
    const radar = resolveLayerAllocation({
      appId: "radar",
      reportType: "property-brief",
      tier: "pro",
    });
    expect(cortex.defaultOn).not.toEqual(radar.defaultOn);
    expect(cortex.visibleLayers).toContain("consequence-choropleth");
    expect(radar.visibleLayers).toContain("motivated-seller");
  });

  it("clears fuel-gated layers on max tier", () => {
    const pro = resolveLayerAllocation({
      appId: "cortex",
      reportType: "property-brief",
      tier: "pro",
    });
    const max = resolveLayerAllocation({
      appId: "cortex",
      reportType: "property-brief",
      tier: "max",
    });
    expect(pro.fuelGated.length).toBeGreaterThan(0);
    expect(max.fuelGated).toEqual([]);
  });
});
