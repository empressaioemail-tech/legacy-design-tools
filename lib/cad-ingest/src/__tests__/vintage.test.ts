/**
 * Failing-first: declared vintage miss + other-vintage hit → vintage-gap.
 * Never silently return the other vintage's row.
 * L21: crosswalk remaps keys inside the declared year only.
 */

import { describe, expect, it } from "vitest";
import {
  DECLARED_CAD_VINTAGES,
  VINTAGE_GAP_ABSENCE_BASIS,
  chooseCadPropIdResolution,
  classifyCadPropertyMiss,
  collapseCadPropIdWhitespace,
  normalizeCadGisLinkKey,
  resolveDeclaredCadVintage,
} from "../vintage";

describe("resolveDeclaredCadVintage", () => {
  it("returns ruled Tarrant declaration after named fallback lands", () => {
    const v = resolveDeclaredCadVintage("48439");
    expect(v).toEqual({
      countyFips: "48439",
      taxYear: 2026,
      tier: "cad-export",
    });
    expect(DECLARED_CAD_VINTAGES["48439"]?.taxYear).toBe(2026);
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

describe("L21 crosswalk resolution (declared-year key mapping)", () => {
  it("normalizes GIS_Link whitespace and case without changing other chars", () => {
    expect(normalizeCadGisLinkKey("A   9-3B")).toBe("A 9-3B");
    expect(normalizeCadGisLinkKey("10-1-1A")).toBe("10-1-1A");
    expect(normalizeCadGisLinkKey("23245-7-4r")).toBe("23245-7-4R");
    expect(collapseCadPropIdWhitespace("A   9-3B")).toBe("A 9-3B");
  });

  it("prefers exact declared-year hit over crosswalk", () => {
    expect(
      chooseCadPropIdResolution({
        requestedPropId: "A 9-3B",
        exactDeclaredHit: true,
        crosswalk: {
          toPropId: "A   9-3B",
          method: "gis-link-whitespace-collapse",
        },
        namedFallback: {
          fallbackPropId: "A 9-3B",
          fallbackTaxYear: 2025,
          method: "named-fallback-2025",
          evidenceClass: "real-parcel-geometry-verified",
        },
      }),
    ).toEqual({ kind: "exact", propId: "A 9-3B" });
  });

  it("uses deterministic crosswalk only when exact miss", () => {
    expect(
      chooseCadPropIdResolution({
        requestedPropId: "A 9-3B",
        exactDeclaredHit: false,
        crosswalk: {
          toPropId: "A   9-3B",
          method: "gis-link-whitespace-collapse",
        },
        namedFallback: {
          fallbackPropId: "A 9-3B",
          fallbackTaxYear: 2025,
          method: "named-fallback-2025",
          evidenceClass: "real-parcel-geometry-verified",
        },
      }),
    ).toEqual({
      kind: "crosswalk",
      propId: "A   9-3B",
      fromPropId: "A 9-3B",
      method: "gis-link-whitespace-collapse",
    });
  });

  it("uses a named prior-vintage fallback after exact and crosswalk miss", () => {
    expect(
      chooseCadPropIdResolution({
        requestedPropId: "1000-13-15",
        exactDeclaredHit: false,
        crosswalk: null,
        namedFallback: {
          fallbackPropId: "1000-13-15",
          fallbackTaxYear: 2025,
          method: "named-fallback-2025",
          evidenceClass: "real-parcel-geometry-verified-absent-2026-gis-link",
        },
      }),
    ).toEqual({
      kind: "named-fallback",
      propId: "1000-13-15",
      taxYear: 2025,
      fromPropId: "1000-13-15",
      method: "named-fallback-2025",
      evidenceClass: "real-parcel-geometry-verified-absent-2026-gis-link",
    });
  });

  it("misses closed when no exact and no crosswalk", () => {
    expect(
      chooseCadPropIdResolution({
        requestedPropId: "10-1-1A",
        exactDeclaredHit: false,
        crosswalk: null,
        namedFallback: null,
      }),
    ).toEqual({ kind: "miss", propId: "10-1-1A" });
  });
});
