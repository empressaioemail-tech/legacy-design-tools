import { describe, it, expect } from "vitest";

import {
  effectiveRailFieldsByKey,
  manifestReadProbeOptions,
} from "../railManifestDerivation";
import {
  applyDepthRailDisplayGate,
} from "../manifestGridRead";
import {
  resolveManifestDisplayState,
  resolveManifestIsPartial,
} from "../manifestCellResolve";

describe("manifest read-path indicator overlay (R-09)", () => {
  const effectiveByKey = effectiveRailFieldsByKey(manifestReadProbeOptions());

  it("hasWriter takes more than one value across rails", () => {
    const writers = new Set(
      [...effectiveByKey.values()].map((v) => v.hasWriter),
    );
    expect(writers.has(true)).toBe(true);
    expect(writers.has(false)).toBe(true);
    expect(effectiveByKey.get("easement")?.hasWriter).toBe(false);
  });

  it("atomFamilyState takes more than one value across rails", () => {
    const states = new Set(
      [...effectiveByKey.values()].map((v) => v.atomFamilyState),
    );
    expect(states.has("present")).toBe(true);
    expect(states.has("missing")).toBe(true);
    expect(effectiveByKey.get("rrc-pipelines")?.atomFamilyState).toBe(
      "missing",
    );
  });

  it("overlay produces no-writer cells when store falsely has hasWriter true", () => {
    const effective = effectiveByKey.get("easement")!;
    expect(effective.hasWriter).toBe(false);
    const displayState = resolveManifestDisplayState(
      effective.atomFamilyState,
      effective.hasWriter,
      null,
    );
    expect(displayState).toBe("no-writer");
  });

  it("overlay produces no-atom cells when store falsely has atomFamilyState present", () => {
    const effective = effectiveByKey.get("rrc-pipelines")!;
    expect(effective.atomFamilyState).toBe("missing");
    const displayState = resolveManifestDisplayState(
      effective.atomFamilyState,
      effective.hasWriter,
      "satisfied-present",
    );
    expect(displayState).toBe("no-atom");
  });

  it("isPartial survives depth-rail display downgrade (not erased in transit)", () => {
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

  it("isPartial fires for satisfied-present below threshold before depth gate", () => {
    expect(
      resolveManifestIsPartial("present", true, "satisfied-present", 15.22, 95),
    ).toBe(true);
    expect(
      resolveManifestIsPartial("present", true, "satisfied-present", 99.0, 95),
    ).toBe(false);
  });
});
