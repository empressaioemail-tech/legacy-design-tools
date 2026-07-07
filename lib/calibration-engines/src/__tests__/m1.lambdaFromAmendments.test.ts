import { describe, expect, it } from "vitest";

import {
  lambdaFromAmendments,
  resolveEffectiveLambda,
} from "../m1/lambdaFromAmendments.js";
import { AMENDMENT_HAZARD_COLD_START_PRIOR } from "../m1/constants.js";

describe("lambdaFromAmendments", () => {
  it("returns cold-start prior when zero amendments found", () => {
    const snapshot = { atoms: {} };
    const results = lambdaFromAmendments({
      snapshot,
      jurisdictionTenant: "austin_tx",
    });

    expect(results.size).toBe(1);
    const jurisdictionResult = results.get("austin_tx");
    expect(jurisdictionResult).toEqual({
      group: "austin_tx",
      rate: AMENDMENT_HAZARD_COLD_START_PRIOR,
      amendmentCount: 0,
      observationYears: 0,
      source: "cold-start-prior",
    });
  });

  it("computes rate from 4 adoption events over ~12.6y window -> ~0.32/yr", () => {
    const snapshot = {
      atoms: {
        "amend-1": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-974",
          editionLabel: "ldc-2013",
          effectiveDate: "2013-06-01T00:00:00.000Z",
        },
        "amend-2": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-1001",
          editionLabel: "ldc-2017",
          effectiveDate: "2017-03-15T00:00:00.000Z",
        },
        "amend-3": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-1012",
          editionLabel: "ldc-2021",
          effectiveDate: "2021-01-10T00:00:00.000Z",
        },
        "amend-4": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-988",
          editionLabel: "ldc-2025",
          effectiveDate: "2025-08-20T00:00:00.000Z",
        },
      },
    };

    const results = lambdaFromAmendments({
      snapshot,
      jurisdictionTenant: "austin_tx",
    });

    expect(results.size).toBe(1);
    const familyResult = results.get("austin_tx:25-2");
    expect(familyResult).toBeDefined();
    expect(familyResult!.amendmentCount).toBe(4);
    expect(familyResult!.source).toBe("amendment-history");

    const spanYears = familyResult!.observationYears;
    expect(spanYears).toBeGreaterThan(12);
    expect(spanYears).toBeLessThan(13);

    const rate = familyResult!.rate;
    expect(rate).toBeGreaterThan(0.30);
    expect(rate).toBeLessThan(0.35);
  });

  it("groups amendments by section family", () => {
    const snapshot = {
      atoms: {
        "amend-1": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-974",
          effectiveDate: "2020-01-01T00:00:00.000Z",
        },
        "amend-2": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-3-1001",
          effectiveDate: "2021-01-01T00:00:00.000Z",
        },
        "amend-3": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-1012",
          effectiveDate: "2022-01-01T00:00:00.000Z",
        },
      },
    };

    const results = lambdaFromAmendments({
      snapshot,
      jurisdictionTenant: "austin_tx",
      observationYears: 3,
    });

    expect(results.size).toBe(2);
    const family25_2 = results.get("austin_tx:25-2");
    const family25_3 = results.get("austin_tx:25-3");

    expect(family25_2).toBeDefined();
    expect(family25_2!.amendmentCount).toBe(2);
    expect(family25_2!.rate).toBeCloseTo(2 / 3, 2);

    expect(family25_3).toBeDefined();
    expect(family25_3!.amendmentCount).toBe(1);
    expect(family25_3!.rate).toBeCloseTo(1 / 3, 2);
  });

  it("filters amendments by jurisdictionTenant", () => {
    const snapshot = {
      atoms: {
        "amend-austin": {
          entityType: "code-amendment",
          jurisdictionTenant: "austin_tx",
          sectionNumber: "25-2-974",
          effectiveDate: "2020-01-01T00:00:00.000Z",
        },
        "amend-sa": {
          entityType: "code-amendment",
          jurisdictionTenant: "san_antonio_tx",
          sectionNumber: "35-1-100",
          effectiveDate: "2021-01-01T00:00:00.000Z",
        },
      },
    };

    const austinResults = lambdaFromAmendments({
      snapshot,
      jurisdictionTenant: "austin_tx",
      observationYears: 2,
    });

    expect(austinResults.size).toBe(1);
    expect(austinResults.get("austin_tx:25-2")).toBeDefined();
    expect(austinResults.get("san_antonio_tx:35-1")).toBeUndefined();
  });
});

describe("resolveEffectiveLambda", () => {
  it("returns family-level amendment-history when available", () => {
    const hazards = new Map([
      [
        "austin_tx:25-2",
        {
          group: "austin_tx:25-2",
          rate: 0.32,
          amendmentCount: 4,
          observationYears: 12.6,
          source: "amendment-history" as const,
        },
      ],
    ]);

    const result = resolveEffectiveLambda(hazards, "austin_tx", "25-2");
    expect(result.lambda).toBe(0.32);
    expect(result.source).toBe("amendment-history");
  });

  it("falls back to jurisdiction-level when family not found", () => {
    const hazards = new Map([
      [
        "austin_tx",
        {
          group: "austin_tx",
          rate: 0.25,
          amendmentCount: 10,
          observationYears: 12,
          source: "amendment-history" as const,
        },
      ],
    ]);

    const result = resolveEffectiveLambda(hazards, "austin_tx", "25-3");
    expect(result.lambda).toBe(0.25);
    expect(result.source).toBe("amendment-history");
  });

  it("falls back to cold-start prior when no hazards found", () => {
    const hazards = new Map();
    const result = resolveEffectiveLambda(hazards, "austin_tx", "25-2");
    expect(result.lambda).toBe(AMENDMENT_HAZARD_COLD_START_PRIOR);
    expect(result.source).toBe("cold-start-prior");
  });
});
