import { describe, expect, it } from "vitest";
import {
  maxConsequenceStratum,
  resolveConsequenceGatedRoute,
} from "@workspace/engine-core";

describe("consequenceGatedRouting", () => {
  it("routes high stratum to high model tier with asserted label", () => {
    const route = resolveConsequenceGatedRoute([
      { consequence: { asce7RiskCategory: "IV" } },
    ]);
    expect(route.modelTier).toBe("high");
    expect(route.routingProvenance).toBe("asserted");
    expect(route.label).toMatch(/Asserted routing/);
    expect(route.stratum).toBe("essential");
  });

  it("routes routine stratum to low model tier", () => {
    const route = resolveConsequenceGatedRoute([
      { consequence: { asce7RiskCategory: "II" } },
    ]);
    expect(route.modelTier).toBe("low");
    expect(route.stratum).toBe("routine");
  });

  it("picks max stratum across sections", () => {
    expect(
      maxConsequenceStratum([
        { consequence: { asce7RiskCategory: "II" } },
        { consequence: { asce7RiskCategory: "III" } },
      ]),
    ).toBe("critical");
  });
});
