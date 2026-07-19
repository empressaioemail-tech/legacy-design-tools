import { describe, expect, it } from "vitest";

import { ptadLandUseDescription } from "../lib/ptadLandUse";

/**
 * Locks the PTAD state-classification -> description mapping that both the
 * live TxGIO map store and the offline PMTiles bake stamp onto features.
 * Mirrors the assertions in txgioParcelStore.integration.test.ts, but here
 * as a pure unit (no DB) guarding the Wave D3 extraction of the mapping into
 * its own dependency-free module.
 */
describe("ptadLandUseDescription", () => {
  it("maps each PTAD class to its keyword-bucketable description", () => {
    expect(ptadLandUseDescription("A1")).toBe("Single-family residential");
    expect(ptadLandUseDescription("A4")).toBe("Single-family residential");
    expect(ptadLandUseDescription("B2")).toBe("Multifamily residential");
    expect(ptadLandUseDescription("BC")).toBe("Multifamily residential");
    expect(ptadLandUseDescription("C1")).toBe("Vacant lot or tract");
    expect(ptadLandUseDescription("D1")).toBe(
      "Agricultural / qualified open-space land",
    );
    expect(ptadLandUseDescription("D2")).toBe(
      "Improvements on agricultural land",
    );
    expect(ptadLandUseDescription("E1")).toBe(
      "Rural single-family residential (farm/ranch improvement)",
    );
    expect(ptadLandUseDescription("E2")).toBe("Rural farm or ranch land");
    expect(ptadLandUseDescription("F1")).toBe("Commercial real property");
    expect(ptadLandUseDescription("F2")).toBe("Industrial real property");
    expect(ptadLandUseDescription("J1")).toBe("Utility");
    expect(ptadLandUseDescription("M1")).toBe("Mobile home (residential)");
    expect(ptadLandUseDescription("O1")).toBe(
      "Residential inventory (builder lots)",
    );
    expect(ptadLandUseDescription("S1")).toBe("Special inventory");
  });

  it("treats X* and EX* as exempt, is case- and whitespace-insensitive", () => {
    expect(ptadLandUseDescription("EX")).toBe("Exempt property");
    expect(ptadLandUseDescription("XV")).toBe("Exempt property");
    expect(ptadLandUseDescription("  a1 ")).toBe("Single-family residential");
    expect(ptadLandUseDescription("f2")).toBe("Industrial real property");
  });

  it("returns null for empty or unknown codes (never a guess)", () => {
    expect(ptadLandUseDescription("")).toBeNull();
    expect(ptadLandUseDescription("   ")).toBeNull();
    expect(ptadLandUseDescription("Z9")).toBeNull();
    expect(ptadLandUseDescription("Q")).toBeNull();
  });
});
