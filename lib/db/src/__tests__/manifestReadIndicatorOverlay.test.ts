import { describe, it, expect } from "vitest";

import {
  effectiveRailFieldsByKey,
  cloudRunManifestReadProbeOptions,
} from "../railManifestDerivation";
import { applyDepthRailDisplayGate } from "../manifestGridRead";
import {
  resolveManifestDisplayState,
  resolveManifestIsPartial,
} from "../manifestCellResolve";

describe("manifest read-path indicator overlay (R-09)", () => {
  const cloudRun = effectiveRailFieldsByKey(cloudRunManifestReadProbeOptions());

  it("hasWriter takes more than one value on Cloud Run probe", () => {
    const writers = new Set([...cloudRun.values()].map((v) => v.hasWriter));
    expect(writers.has(true)).toBe(true);
    expect(writers.has(false)).toBe(true);
    expect(cloudRun.get("easement")?.hasWriter).toBe(false);
  });

  it("atomFamilyState takes more than one value on Cloud Run probe", () => {
    const states = new Set([...cloudRun.values()].map((v) => v.atomFamilyState));
    expect(states.has("present")).toBe(true);
    expect(states.has("partial")).toBe(true);
  });

  it("overlay marks easement hasWriter false on Cloud Run probe", () => {
    const effective = cloudRun.get("easement")!;
    expect(effective.hasWriter).toBe(false);
  });

  it("overlay produces no-atom when atom family is partial", () => {
    const effective = cloudRun.get("cad")!;
    expect(effective.atomFamilyState).toBe("partial");
    expect(
      resolveManifestDisplayState(
        effective.atomFamilyState,
        effective.hasWriter,
        "satisfied-present",
      ),
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
    expect(result.displayState).toBe("not-yet");
    expect(result.isPartial).toBe(true);
  });

  it("isPartial fires for satisfied-present below threshold", () => {
    expect(
      resolveManifestIsPartial("present", true, "satisfied-present", 15.22, 95),
    ).toBe(true);
  });
});
