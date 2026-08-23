import { describe, expect, it } from "vitest";
import { resolveStructuralFactRead } from "./structuralFactResolve";

describe("resolveStructuralFactRead", () => {
  it("returns lookup-failed for bulk_primary stratmap-roll counties", () => {
    const read = resolveStructuralFactRead({
      parcelNodeId: "48439:412831",
      lookupFailed: true,
      cadRow: null,
      asOf: "2026-08-22T00:00:00.000Z",
    });
    expect(read).toMatchObject({
      status: "absent",
      verdict: "lookup-failed",
      source: "structural-fact",
      authority: "tad",
    });
    expect("basis" in read && read.basis).toContain("bulk_primary=true");
  });

  it("returns present when CAD row carries living_area_sqft", () => {
    const read = resolveStructuralFactRead({
      parcelNodeId: "48021:34137",
      lookupFailed: false,
      cadRow: {
        taxYear: 2025,
        tier: "cad-export",
        livingAreaSqft: 1800,
        yearBuilt: 1998,
        sourceVintage: "tier:cad-export;adapter:bis-consultants;drop:202503",
      },
    });
    expect(read).toMatchObject({
      state: "present",
      livingAreaSqft: 1800,
      yearBuilt: 1998,
    });
  });

  it("returns lookup-failed for bulk_primary cad-export with null structural fields", () => {
    const read = resolveStructuralFactRead({
      parcelNodeId: "48113:12345",
      lookupFailed: false,
      cadRow: {
        taxYear: 2026,
        tier: "cad-export",
        livingAreaSqft: null,
        yearBuilt: null,
        sourceVintage: "tier:cad-export",
      },
    });
    expect(read).toMatchObject({
      verdict: "lookup-failed",
      authority: "dcad",
      source: "structural-fact",
    });
    expect("basis" in read && read.basis).toContain("bulk_primary=true");
  });

  it("never emits absent-verified when lookupFailed is true", () => {
    const read = resolveStructuralFactRead({
      parcelNodeId: "48439:412831",
      lookupFailed: true,
      cadRow: {
        taxYear: 2026,
        tier: "stratmap-roll",
        livingAreaSqft: null,
        yearBuilt: null,
        sourceVintage: null,
      },
    });
    expect(read).toMatchObject({ verdict: "lookup-failed" });
  });
});
