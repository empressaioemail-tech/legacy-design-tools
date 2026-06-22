import { describe, expect, it } from "vitest";
import {
  ICC_MODEL_CODE_JURISDICTION,
  isIccFindingShellId,
  resolveIccFindingShell,
} from "../iccFindingShell";

describe("iccFindingShell", () => {
  it("resolves municipal IPMC 2018 editions", () => {
    const shell = resolveIccFindingShell("municipal-ipmc");
    expect(shell.applicableIccEditions).toEqual([
      { title: "IPMC", edition: "2018" },
    ]);
    expect(shell.surfaceKey).toBe("plan-review-ipmc");
  });

  it("resolves architect IBC 2018 editions", () => {
    const shell = resolveIccFindingShell("architect-ibc");
    expect(shell.applicableIccEditions).toEqual([
      { title: "IBC", edition: "2018" },
    ]);
    expect(shell.surfaceKey).toBe("plan-review-ibc");
  });

  it("targets icc-model-code jurisdiction", () => {
    expect(ICC_MODEL_CODE_JURISDICTION).toBe("icc-model-code");
  });

  it("validates shell ids", () => {
    expect(isIccFindingShellId("municipal-ipmc")).toBe(true);
    expect(isIccFindingShellId("architect-ibc")).toBe(true);
    expect(isIccFindingShellId("other")).toBe(false);
  });
});
