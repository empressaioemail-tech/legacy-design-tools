import { describe, it, expect } from "vitest";

import {
  runManifestReconciliationGate,
  RECONCILIATION_ASSERTIONS,
} from "../manifestReconciliationGate";
import type { ReconciliationManifestCell } from "../manifestReconciliationGate";

function cell(
  overrides: Partial<ReconciliationManifestCell> & {
    countyFips: string;
    railKey: string;
  },
): ReconciliationManifestCell {
  return {
    displayState: "not-yet",
    isPartial: false,
    honestCoveragePct: null,
    thresholdPct: 95,
    hasWriter: true,
    verifiedByInstrument: null,
    ...overrides,
  };
}

describe("manifestReconciliationGate", () => {
  it("exports all five minimum assertions", () => {
    expect(RECONCILIATION_ASSERTIONS).toHaveLength(5);
  });

  it("catches D3 #7: coverage > 0 with hasWriter false", () => {
    const failures = runManifestReconciliationGate({
      cells: [
        cell({
          countyFips: "48001",
          railKey: "geometry",
          honestCoveragePct: 100,
          hasWriter: false,
          displayState: "no-writer",
        }),
      ],
      totalCounties: 1,
      totalRails: 1,
      railHasWriterByKey: new Map([["geometry", false]]),
    });
    expect(failures.some((f) => f.assertion.includes("coverage_without_writer"))).toBe(
      true,
    );
  });

  it("catches verified instrument with no-writer display", () => {
    const failures = runManifestReconciliationGate({
      cells: [
        cell({
          countyFips: "48001",
          railKey: "geometry",
          hasWriter: false,
          displayState: "no-writer",
          verifiedByInstrument: "countyGeometryScoreCli.ts",
        }),
      ],
      totalCounties: 1,
      totalRails: 1,
      railHasWriterByKey: new Map([["geometry", false]]),
    });
    expect(failures.some((f) => f.assertion.includes("verified_no_writer"))).toBe(true);
  });

  it("catches cell count mismatch", () => {
    const failures = runManifestReconciliationGate({
      cells: [cell({ countyFips: "48001", railKey: "geometry" })],
      totalCounties: 254,
      totalRails: 14,
      railHasWriterByKey: new Map(),
    });
    expect(failures.some((f) => f.assertion.includes("cell_count_mismatch"))).toBe(true);
  });

  it("catches depth rail satisfied-present below threshold (#3 zoning class)", () => {
    const failures = runManifestReconciliationGate({
      cells: [
        cell({
          countyFips: "48021",
          railKey: "zoning",
          displayState: "satisfied-present",
          honestCoveragePct: 0,
          thresholdPct: 95,
          isPartial: false,
        }),
      ],
      totalCounties: 1,
      totalRails: 1,
      railHasWriterByKey: new Map([["zoning", true]]),
    });
    expect(
      failures.some((f) => f.assertion.includes("depth_satisfied_below_threshold")),
    ).toBe(true);
  });

  it("passes consistent grid", () => {
    const failures = runManifestReconciliationGate({
      cells: [
        cell({
          countyFips: "48021",
          railKey: "easement",
          hasWriter: false,
          displayState: "no-writer",
        }),
      ],
      totalCounties: 1,
      totalRails: 1,
      railHasWriterByKey: new Map([["easement", false]]),
    });
    expect(failures).toHaveLength(0);
  });
});
