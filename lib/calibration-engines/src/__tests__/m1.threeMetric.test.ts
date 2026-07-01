import { describe, expect, it } from "vitest";

import {
  buildAdjudicationWeights,
  buildLineageBuckets,
  caseSignalsFromDeposits,
  loadCorpusForJurisdiction,
  runThreeMetricM1,
} from "../m1/index.js";

describe("runThreeMetricM1", () => {
  it("slice earned exceeds corpus-uniform when hot atoms earn", () => {
    const snapshot = {
      atoms: {
        hot: {
          entityType: "code-section",
          entityId: "test_tx/code/hot",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
          sourceType: "municode",
        },
        cold: {
          entityType: "code-section",
          entityId: "test_tx/code/cold",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-2-1",
          sourceType: "municode",
        },
      },
      links: [],
    };
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "test_tx",
      queryWeights: [1, 1],
    });

    const deposits = Array.from({ length: 20 }, (_, i) => ({
      entityId: `finding:backtest:${i}`,
      occurredAt: `2020-0${(i % 9) + 1}-01T00:00:00.000Z`,
      payload: {
        subjectKey: `test_tx:variance:${i}`,
        calibrationProvenance: "backtest",
        rawCounts: { successCount: 1, trialCount: 1 },
      },
      citations: [{ kind: "code-section", atomId: "hot" }],
      cortexJurisdictionKey: "test:tx",
    }));

    const result = runThreeMetricM1({
      atoms,
      deposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      jurisdictionTenant: "test_tx",
      observationYears: 1,
    });

    const slice = result.sliceByGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;
    const corp = result.corpusUniform.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;

    expect(result.coverage.adjudicatedAtomCount).toBe(1);
    expect(result.coverage.unAdjudicatedAtomCount).toBe(1);
    expect(slice.sliceEarnedFractionAtReadGrain).toBeGreaterThan(
      corp.earnedFractionAtReadGrain,
    );
    expect(slice.sliceEarnedFractionAtReadGrain).toBeGreaterThanOrEqual(0.7);
  });

  it("buildAdjudicationWeights counts case citations per atom", () => {
    const cases = caseSignalsFromDeposits([
      {
        entityId: "c1",
        occurredAt: "2020-01-01",
        payload: {
          subjectKey: "test_tx:1",
          calibrationProvenance: "backtest",
          rawCounts: { successCount: 1, trialCount: 1 },
        },
        citations: [
          { kind: "code-section", atomId: "a" },
          { kind: "code-section", atomId: "b" },
        ],
      },
    ]);
    const buckets = buildLineageBuckets(cases);
    const weights = buildAdjudicationWeights(
      [
        {
          atomId: "a",
          entityId: "e1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "1",
          sectionFamily: "1",
          atomClass: "test_tx:1",
          mu0: 0.78,
          queryWeight: 0,
          closureSize: 1,
          closureEntityIds: ["e1"],
        },
        {
          atomId: "b",
          entityId: "e2",
          jurisdictionTenant: "test_tx",
          sectionNumber: "2",
          sectionFamily: "2",
          atomClass: "test_tx:2",
          mu0: 0.78,
          queryWeight: 0,
          closureSize: 1,
          closureEntityIds: ["e2"],
        },
      ],
      buckets,
    );
    expect(weights.get("a")).toBe(1);
    expect(weights.get("b")).toBe(1);
  });
});
