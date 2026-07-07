import { describe, expect, it } from "vitest";

import {
  buildLineageBuckets,
  caseSignalsFromDeposits,
  caseMatchRate,
} from "../m1/caseGrain.js";
import {
  loadCorpusForJurisdiction,
  sectionFamilyFromSectionNumber,
} from "../m1/corpusLoader.js";
import { readAtomAtSupportedGrain } from "../m1/pooledRead.js";
import { runMeasurementAv2 } from "../m1/measurementAv2.js";

describe("sectionFamilyFromSectionNumber", () => {
  it("groups Austin LDC sections", () => {
    expect(sectionFamilyFromSectionNumber("25-2-974")).toBe("25-2");
    expect(sectionFamilyFromSectionNumber("25-1-1")).toBe("25-1");
  });
});

describe("case-grain lineage", () => {
  const deposits = [
    {
      entityId: "finding:backtest:test-1",
      occurredAt: "2020-01-01T00:00:00.000Z",
      payload: {
        subjectKey: "austin_tx:variance:test-1",
        calibrationProvenance: "backtest",
        rawCounts: { successCount: 1, trialCount: 1 },
      },
      citations: [{ kind: "code-section", atomId: "atom-a" }],
      cortexJurisdictionKey: "austin:tx",
    },
    {
      entityId: "finding:backtest:test-2",
      occurredAt: "2020-06-01T00:00:00.000Z",
      payload: {
        subjectKey: "austin_tx:variance:test-2",
        calibrationProvenance: "backtest",
        rawCounts: { successCount: 1, trialCount: 1 },
      },
      citations: [
        { kind: "code-section", atomId: "atom-a" },
        { kind: "code-section", atomId: "atom-b" },
      ],
      cortexJurisdictionKey: "austin:tx",
    },
  ];

  it("attributes cases to cited atoms", () => {
    const cases = caseSignalsFromDeposits(deposits);
    expect(cases).toHaveLength(2);
    expect(caseMatchRate(cases)).toBe(1);

    const buckets = buildLineageBuckets(cases);
    expect(buckets.get("__public__::atom-a")).toHaveLength(2);
    expect(buckets.get("__public__::atom-b")).toHaveLength(1);
  });
});

describe("pooled read provenance (Condition A)", () => {
  it("marks pool-up as pooled-applied not own-earned", () => {
    const atom = {
      atomId: "sparse",
      entityId: "j/sparse",
      jurisdictionTenant: "test_tx",
      sectionNumber: "1-1",
      sectionFamily: "1-1",
      atomClass: "test_tx:1-1",
      mu0: 0.78,
      queryWeight: 1,
      closureSize: 2,
      closureEntityIds: ["j/sparse", "j/other"],
    };
    const denseAtom = {
      ...atom,
      atomId: "dense",
      entityId: "j/dense",
    };

    const cases = caseSignalsFromDeposits([
      {
        entityId: "c1",
        occurredAt: "2020-01-01",
        payload: {
          subjectKey: "test_tx:1",
          calibrationProvenance: "backtest",
          rawCounts: { successCount: 1, trialCount: 1 },
        },
        citations: [{ kind: "code-section", atomId: "dense" }],
      },
      {
        entityId: "c2",
        occurredAt: "2020-02-01",
        payload: {
          subjectKey: "test_tx:2",
          calibrationProvenance: "backtest",
          rawCounts: { successCount: 1, trialCount: 1 },
        },
        citations: [{ kind: "code-section", atomId: "dense" }],
      },
      {
        entityId: "c3",
        occurredAt: "2020-03-01",
        payload: {
          subjectKey: "test_tx:3",
          calibrationProvenance: "backtest",
          rawCounts: { successCount: 1, trialCount: 1 },
        },
        citations: [{ kind: "code-section", atomId: "dense" }],
      },
    ]);
    const buckets = buildLineageBuckets(cases);
    const entityMap = new Map([
      ["j/dense", "dense"],
      ["j/sparse", "sparse"],
      ["j/other", "other"],
    ]);

    const denseRead = readAtomAtSupportedGrain({
      atom: denseAtom,
      allAtoms: [atom, denseAtom],
      lineageBuckets: buckets,
      entityIdToAtomId: entityMap,
    });
    expect(denseRead.provenance.signalSource).toBe("own-earned");
    expect(denseRead.provenance.readGrain).toBe("atom");
  });
});

describe("runMeasurementAv2", () => {
  it("earns higher fraction than per-atom-independent model would", () => {
    const snapshot = {
      atoms: {
        a1: {
          entityType: "code-section",
          entityId: "test_tx/code/a1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
          sourceType: "municode",
        },
        a2: {
          entityType: "code-section",
          entityId: "test_tx/code/a2",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-2",
          sourceType: "municode",
        },
      },
      links: [
        {
          fromEntityType: "code-section",
          fromEntityId: "test_tx/code/a2",
          toEntityType: "code-section",
          toEntityId: "test_tx/code/a1",
          linkType: "cites",
        },
      ],
    };
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "test_tx",
      queryWeights: [1, 1],
    });

    const deposits = Array.from({ length: 10 }, (_, i) => ({
      entityId: `finding:backtest:${i}`,
      occurredAt: `2020-0${(i % 9) + 1}-01T00:00:00.000Z`,
      payload: {
        subjectKey: `test_tx:variance:${i}`,
        calibrationProvenance: "backtest",
        rawCounts: { successCount: 1, trialCount: 1 },
      },
      citations: [{ kind: "code-section", atomId: "a1" }],
      cortexJurisdictionKey: "test:tx",
    }));

    const result = runMeasurementAv2({
      atoms,
      deposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      queryWeightMode: "uniform",
      jurisdictionTenant: "test_tx",
      observationYears: 1,
    });

    const sectionPlus = result.byGranularity.find(
      (g) => g.granularity === "section-plus-dependents",
    )!;
    expect(sectionPlus.earnedFraction).toBeGreaterThan(0.5);
    expect(result.caseMatchRate).toBe(1);
  });

  it("propagates lambdaSource when explicitly provided", () => {
    const snapshot = {
      atoms: {
        a1: {
          entityType: "code-section",
          entityId: "test_tx/code/a1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
          sourceType: "municode",
        },
      },
    };
    const { atoms, linkIndex } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "test_tx",
      queryWeights: [1],
    });

    const deposits = [
      {
        entityId: "finding:backtest:1",
        occurredAt: "2020-01-01T00:00:00.000Z",
        payload: {
          subjectKey: "test_tx:variance:1",
          calibrationProvenance: "backtest",
          rawCounts: { successCount: 1, trialCount: 1 },
        },
        citations: [{ kind: "code-section", atomId: "a1" }],
        cortexJurisdictionKey: "test:tx",
      },
    ];

    const resultWithAmendmentHistory = runMeasurementAv2({
      atoms,
      deposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      queryWeightMode: "uniform",
      jurisdictionTenant: "test_tx",
      baseLambda: 0.32,
      lambdaSource: "amendment-history",
    });

    expect(resultWithAmendmentHistory.lambdaSource).toBe("amendment-history");
    expect(resultWithAmendmentHistory.lambdaPriorUsed).toBe(0.32);

    const resultWithColdStart = runMeasurementAv2({
      atoms,
      deposits,
      entityIdToAtomId: linkIndex.entityIdToAtomId,
      queryWeightMode: "uniform",
      jurisdictionTenant: "test_tx",
      lambdaSource: "cold-start-prior",
    });

    expect(resultWithColdStart.lambdaSource).toBe("cold-start-prior");
    expect(resultWithColdStart.lambdaPriorUsed).toBe(0.02);
  });
});

describe("corpus loader queryWeightMode honesty", () => {
  it("throws when queryWeightMode='available' without real weights", () => {
    const snapshot = {
      atoms: {
        a1: {
          entityType: "code-section",
          entityId: "test_tx/code/a1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
        },
      },
    };

    expect(() => {
      loadCorpusForJurisdiction({
        snapshot,
        jurisdictionTenant: "test_tx",
        queryWeightMode: "available",
      });
    }).toThrow(/F1 atom-grain attribution does not exist/);
  });

  it("allows queryWeightMode='available' when real weights provided", () => {
    const snapshot = {
      atoms: {
        a1: {
          entityType: "code-section",
          entityId: "test_tx/code/a1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
        },
      },
    };

    const { atoms } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "test_tx",
      queryWeightMode: "available",
      queryWeights: [5],
    });

    expect(atoms).toHaveLength(1);
    expect(atoms[0]!.queryWeight).toBe(5);
  });

  it("defaults to uniform when queryWeightMode not specified", () => {
    const snapshot = {
      atoms: {
        a1: {
          entityType: "code-section",
          entityId: "test_tx/code/a1",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-1",
        },
        a2: {
          entityType: "code-section",
          entityId: "test_tx/code/a2",
          jurisdictionTenant: "test_tx",
          sectionNumber: "25-1-2",
        },
      },
    };

    const { atoms } = loadCorpusForJurisdiction({
      snapshot,
      jurisdictionTenant: "test_tx",
    });

    expect(atoms).toHaveLength(2);
    expect(atoms[0]!.queryWeight).toBeGreaterThan(0);
  });
});
