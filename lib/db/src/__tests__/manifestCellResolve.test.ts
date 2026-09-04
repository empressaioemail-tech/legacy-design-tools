import { describe, it, expect } from "vitest";

import {
  mergeAtomFamilyState,
  mergeHasWriter,
  mergeEffectiveRailFields,
} from "../manifestCellResolve";

describe("mergeEffectiveRailFields", () => {
  it("does not upgrade store missing to derived present", () => {
    expect(mergeAtomFamilyState("missing", "present")).toBe("missing");
  });

  it("downgrades store present when derived is partial", () => {
    expect(mergeAtomFamilyState("present", "partial")).toBe("partial");
  });

  it("does not upgrade store hasWriter false", () => {
    expect(mergeHasWriter(false, true)).toBe(false);
  });

  it("downgrades store hasWriter true when derived false", () => {
    expect(mergeHasWriter(true, false)).toBe(false);
  });

  it("mergeEffectiveRailFields combines both", () => {
    expect(
      mergeEffectiveRailFields("present", true, "partial", false),
    ).toEqual({ atomFamilyState: "partial", hasWriter: false });
  });
});
