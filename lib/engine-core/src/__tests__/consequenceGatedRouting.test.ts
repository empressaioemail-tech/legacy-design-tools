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

describe("consequenceGatedRouting: Anthropic only (G-309 A20)", () => {
  it("ignores XAI_* env and routes both tiers to an Anthropic model", () => {
    const saved = { m: process.env.XAI_MODEL, h: process.env.XAI_FINDING_HIGH_MODEL };
    process.env.XAI_MODEL = "grok-3-mini";
    process.env.XAI_FINDING_HIGH_MODEL = "grok-3";
    try {
      for (const sections of [
        [{ consequence: { asce7RiskCategory: "IV" as const } }],
        [{ consequence: null }],
      ]) {
        const route = resolveConsequenceGatedRoute(
          sections as never,
        ) as unknown as Record<string, unknown>;
        expect(String(route.anthropicModel)).toMatch(/^claude-/);
        expect("grokModel" in route).toBe(false);
      }
    } finally {
      if (saved.m === undefined) delete process.env.XAI_MODEL;
      else process.env.XAI_MODEL = saved.m;
      if (saved.h === undefined) delete process.env.XAI_FINDING_HIGH_MODEL;
      else process.env.XAI_FINDING_HIGH_MODEL = saved.h;
    }
  });
});
