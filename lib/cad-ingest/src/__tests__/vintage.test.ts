/**
 * Failing-first: declared vintage miss + other-vintage hit → vintage-gap.
 * Never silently return the other vintage's row.
 */

import { describe, expect, it } from "vitest";
import {
  DECLARED_CAD_VINTAGES,
  VINTAGE_GAP_ABSENCE_BASIS,
  classifyCadPropertyMiss,
  resolveDeclaredCadVintage,
} from "../vintage";

describe("resolveDeclaredCadVintage", () => {
  it("returns store-truth seed for Tarrant (2025, not the 2026 pilot)", () => {
    const v = resolveDeclaredCadVintage("48439");
    expect(v).toEqual({
      countyFips: "48439",
      taxYear: 2025,
      tier: "stratmap-roll",
    });
    expect(DECLARED_CAD_VINTAGES["48439"]?.taxYear).toBe(2025);
  });

  it("fails closed on unknown county", () => {
    expect(() => resolveDeclaredCadVintage("48999")).toThrow(/FAIL CLOSED/);
  });

  it("fails closed on malformed FIPS", () => {
    expect(() => resolveDeclaredCadVintage("21")).toThrow(/FAIL CLOSED/);
  });
});

describe("classifyCadPropertyMiss (failing-first vintage-gap)", () => {
  it("emits vintage-gap when prop exists only in another year", () => {
    // Arrange: declared year empty, other year has the prop.
    const miss = classifyCadPropertyMiss({
      declaredYearHit: false,
      otherVintageHit: true,
    });
    // Assert: honest absence basis — NEVER treat as a silent hit.
    expect(miss).toBe(VINTAGE_GAP_ABSENCE_BASIS);
    expect(miss).toBe("vintage-gap");
  });

  it("emits not-found when prop is absent from every vintage", () => {
    expect(
      classifyCadPropertyMiss({
        declaredYearHit: false,
        otherVintageHit: false,
      }),
    ).toBe("not-found");
  });

  it("emits hit when declared year has the row", () => {
    expect(
      classifyCadPropertyMiss({
        declaredYearHit: true,
        otherVintageHit: true,
      }),
    ).toBe("hit");
  });
});
