import { describe, it, expect } from "vitest";

import {
  buildEffectiveCountyRailDeclaration,
  cloudRunManifestReadProbeOptions,
  effectiveRailFieldsByKey,
  isRailDerivationIndeterminate,
} from "../railManifestDerivation";
import { applyDepthRailDisplayGate } from "../manifestGridRead";
import {
  resolveManifestDisplayState,
  resolveManifestIsPartial,
} from "../manifestCellResolve";
import { RAIL_ENGINE_BINDINGS } from "../schema/railEngineBinding";

describe("manifest read-path indicator overlay (R-09)", () => {
  const cloudRunOpts = cloudRunManifestReadProbeOptions();
  const cloudRun = effectiveRailFieldsByKey(cloudRunOpts);
  const cloudRunDecls = buildEffectiveCountyRailDeclaration(cloudRunOpts);

  it("Cloud Run probe has zero indeterminate rails among the fourteen bindings", () => {
    expect(cloudRunDecls).toHaveLength(RAIL_ENGINE_BINDINGS.length);
    expect(cloudRunDecls).toHaveLength(14);
    expect(cloudRunDecls.filter(isRailDerivationIndeterminate)).toHaveLength(0);
  });

  it("Cloud Run probe derives easement hasWriter true and atomFamilyState present", () => {
    expect(cloudRun.get("easement")?.hasWriter).toBe(true);
    expect(cloudRun.get("easement")?.atomFamilyState).toBe("present");
  });

  it("overlay produces no-atom when atom family is partial (constructed, not live cad)", () => {
    expect(
      resolveManifestDisplayState("partial", true, "satisfied-present"),
    ).toBe("no-atom");
  });

  it("isPartial survives depth-rail display downgrade", () => {
    const cell = {
      countyFips: "48021",
      railKey: "zoning",
      displayState: "satisfied-present" as const,
      isPartial: true,
      honestCoveragePct: 15.22,
      thresholdPct: 95,
      hasWriter: true,
      verifiedByInstrument: null,
    };
    const result = applyDepthRailDisplayGate(cell);
    // Composed with ruling 4 (2026-08-19, lane SS-W15): the demotion target
    // is now measured-below-bar, not not-yet. isPartial still survives
    // exactly as this test (R-09, PR #447) originally established -- see
    // countyLedgerCompute.ts's applyDepthRailDisplayGate for the full
    // reasoning on why both fields survive the composition.
    expect(result.displayState).toBe("measured-below-bar");
    expect(result.isPartial).toBe(true);
  });

  it("isPartial fires for satisfied-present below threshold", () => {
    expect(
      resolveManifestIsPartial("present", true, "satisfied-present", 15.22, 95),
    ).toBe(true);
  });
});
