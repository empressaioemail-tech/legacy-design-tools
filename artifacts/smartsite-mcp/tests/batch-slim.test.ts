import { describe, expect, it } from "vitest";

import { slimBatchResponseText } from "../src/batch-slim.js";

describe("multi-parcel read slimming (F13)", () => {
  const parcel = {
    parcelNodeId: "48021:1",
    brief: { sections: [{ id: "zoning", disposition: "present" }] },
    draw: { edges: [{ id: "e0" }] },
    boundaryEdgeFact: { edges: [{ id: "e0", interior: {} }] },
    buildingFootprintFact: { state: "present", footprintGeometry: { type: "Polygon" }, footprints: [{ footprintId: "primary", footprintGeometry: {} }] },
    setbackRulesFact: { districtCode: "SF-1", note: "long internal note" },
    cityLimitsFact: { status: "incorporated", cityName: "Bastrop", basis: "long", etjFact: { status: "absent", basis: "long", settledBy: "incorporation" } },
    onRecord: { cadRoll: { marketValue: { state: "refused", code: "studio-gated", reason: "County tax-assessed valuation (market/land/...) is Studio or Team only." } } },
  };

  it("drops duplicates and repeated text but keeps every fact the card and Claude use", () => {
    const out = JSON.parse(slimBatchResponseText(JSON.stringify({ parcels: [parcel] })));
    const p = out.parcels[0];
    expect(p.boundaryEdgeFact).toBeUndefined();
    expect(p.draw.edges).toHaveLength(1);
    expect(p.brief.sections[0].id).toBe("zoning");
    expect(p.buildingFootprintFact.footprintGeometry).toBeUndefined();
    expect(p.buildingFootprintFact.footprints[0]).toEqual({ footprintId: "primary" });
    expect(p.setbackRulesFact).toEqual({ districtCode: "SF-1" });
    expect(p.cityLimitsFact).toEqual({ status: "incorporated", cityName: "Bastrop", etjFact: { status: "absent", settledBy: "incorporation" } });
    expect(p.onRecord.cadRoll.marketValue).toEqual({ state: "refused", code: "studio-gated" });
    expect(out.gatedValueNote).toMatch(/Studio and Team/);
  });

  it("passes non-batch and unparseable text through", () => {
    expect(slimBatchResponseText("not json")).toBe("not json");
    const single = JSON.stringify({ parcelNodeId: "48021:1", boundaryEdgeFact: {} });
    expect(slimBatchResponseText(single)).toBe(single);
  });
});
