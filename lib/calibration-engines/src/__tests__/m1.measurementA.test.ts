import { describe, expect, it } from "vitest";

import {
  betaCredibleIntervalWidth90,
  computeNStar,
  computeSectionDependentsClosure,
  solveMinimumAdjudicationRate,
  runMeasurementA,
  AMENDMENT_HAZARD_COLD_START_PRIOR,
} from "../m1/index.js";

describe("computeNStar", () => {
  it("returns floor-bounded n* for default corpus baseline", () => {
    const nStar = computeNStar({ mu0: 0.65 });
    expect(nStar).toBeGreaterThanOrEqual(3);
    expect(nStar).toBeLessThan(100);
  });

  it("requires higher n* for lower asserted baseline", () => {
    const high = computeNStar({ mu0: 0.82 });
    const low = computeNStar({ mu0: 0.55 });
    expect(low).toBeGreaterThan(high);
  });
});

describe("betaCredibleIntervalWidth90", () => {
  it("narrows as observations accumulate", () => {
    const prior = betaCredibleIntervalWidth90(3.9, 2.1);
    const posterior = betaCredibleIntervalWidth90(13.9, 7.1);
    expect(posterior).toBeLessThan(prior);
  });
});

describe("computeSectionDependentsClosure", () => {
  it("includes inbound dependents", () => {
    const links = [
      {
        fromEntityType: "code-section",
        fromEntityId: "a/5-04",
        toEntityType: "code-section",
        toEntityId: "a/1-01",
        linkType: "cites",
      },
    ];
    expect([...computeSectionDependentsClosure(["a/1-01"], links)].sort()).toEqual([
      "a/1-01",
      "a/5-04",
    ]);
  });
});

describe("runMeasurementA solve-for", () => {
  const atoms = Array.from({ length: 20 }, (_, i) => ({
    atomId: `atom-${i}`,
    jurisdictionTenant: "austin_tx",
    mu0: 0.65 + (i % 5) * 0.02,
    closureSize: 1 + (i % 3),
  }));

  it("section-plus-dependents requires lower a than whole-edition", () => {
    const uniform = runMeasurementA({
      atoms,
      queryWeightMode: "uniform",
      mode: "solve-for",
      editionAtomCount: 2000,
      amendmentAtomCount: 0,
    });

    const whole = uniform.byGranularity.find(
      (g) => g.granularity === "whole-edition",
    )!.requiredAdjudicationRate!;
    const sectionPlus = uniform.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!.requiredAdjudicationRate!;
    const section = uniform.byGranularity.find(
      (g) => g.granularity === "section-scoped",
    )!.requiredAdjudicationRate!;

    expect(sectionPlus).toBeLessThan(whole);
    expect(section).toBeLessThan(sectionPlus);
  });

  it("uses cold-start lambda prior when no amendments", () => {
    const result = runMeasurementA({
      atoms: atoms.slice(0, 5),
      queryWeightMode: "uniform",
      mode: "solve-for",
      editionAtomCount: 100,
    });
    expect(result.lambdaPriorUsed).toBe(AMENDMENT_HAZARD_COLD_START_PRIOR);
    expect(result.lambdaSource).toBe("cold-start-prior");
    expect(result.measurementBDeferred).toBe(true);
  });
});

describe("solveMinimumAdjudicationRate", () => {
  it("finds a driving 70% weighted fraction", () => {
    const atoms = [
      { atomId: "a", jurisdictionTenant: "x", mu0: 0.7, closureSize: 1 },
      { atomId: "b", jurisdictionTenant: "x", mu0: 0.7, closureSize: 1 },
      { atomId: "c", jurisdictionTenant: "x", mu0: 0.7, closureSize: 1 },
    ];
    const { requiredA } = solveMinimumAdjudicationRate({
      atoms,
      queryWeights: [1, 1, 1],
      granularity: "section-scoped",
      baseLambda: 0.02,
      editionAtomCount: 100,
      targetFraction: 0.7,
    });
    expect(Number.isFinite(requiredA)).toBe(true);
    expect(requiredA).toBeGreaterThan(0);
  });
});
