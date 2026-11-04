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

describe("consequenceGatedRouting: one model, no ensemble (G-309 A20)", () => {
  it("carries no model id and ignores XAI_* and the ensemble flag", () => {
    const keys = ["XAI_MODEL", "XAI_FINDING_HIGH_MODEL", "AIR_FINDING_ENSEMBLE_HIGH_CONSEQUENCE"];
    const saved = keys.map((k) => process.env[k]);
    process.env.XAI_MODEL = "grok-3-mini";
    process.env.XAI_FINDING_HIGH_MODEL = "grok-3";
    process.env.AIR_FINDING_ENSEMBLE_HIGH_CONSEQUENCE = "1";
    try {
      for (const sections of [
        [{ consequence: { asce7RiskCategory: "IV" as const } }],
        [{ consequence: null }],
      ]) {
        const route = resolveConsequenceGatedRoute(
          sections as never,
        ) as unknown as Record<string, unknown>;
        expect("grokModel" in route).toBe(false);
        expect("anthropicModel" in route).toBe(false);
        expect("ensembleEnabled" in route).toBe(false);
        expect(String(route.label)).not.toMatch(/ensemble/i);
      }
    } finally {
      keys.forEach((k, n) => {
        if (saved[n] === undefined) delete process.env[k];
        else process.env[k] = saved[n];
      });
    }
  });
});
