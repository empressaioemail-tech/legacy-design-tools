import { describe, expect, it } from "vitest";
import {
  assertNoVerdictUpgrade,
  buildStructuralLookupFailedAbsence,
  buildZoningNotApplicableAbsence,
  countyFipsFromParcelNodeId,
  isStructuralCamaLookupFailed,
  isStructuralCamaLookupFailedForDeclaredTier,
  isUnincorporatedNoZoningAuthorityShape,
  mergeLayerVerdict,
  parcelShapeLacksZoningAuthority,
} from "./verdictLayerServe";
import { enrichLandUseFactWithZoningVerdict } from "./landUseFactVerdict";

type LandUseAtomMiss = {
  state: "refused";
  code: "atom-miss";
  source: "land-use-fact";
  tried: readonly string[];
  reason: string;
};

describe("verdictLayerServe", () => {
  it("parses county FIPS from parcelNodeId", () => {
    expect(countyFipsFromParcelNodeId("48439:412831")).toBe("48439");
    expect(countyFipsFromParcelNodeId("bad")).toBeNull();
  });

  it("flags bulk_primary + stratmap-roll as structural lookup-failed", () => {
    expect(isStructuralCamaLookupFailedForDeclaredTier("48439", "stratmap-roll")).toBe(
      true,
    );
    expect(isStructuralCamaLookupFailedForDeclaredTier("48439", "cad-export")).toBe(
      false,
    );
    // 48085 Collin is stratmap-roll but not bulk_primary
    expect(isStructuralCamaLookupFailedForDeclaredTier("48085", "stratmap-roll")).toBe(
      false,
    );
    // Dallas/Tarrant are bulk_primary but currently cad-export in vintage.ts
    expect(isStructuralCamaLookupFailed("48113")).toBe(false);
    expect(isStructuralCamaLookupFailed("48439")).toBe(false);
  });

  it("builds lookup-failed absence with required doc 19 fields", () => {
    const wire = buildStructuralLookupFailedAbsence(
      "48439",
      "2026-08-22T00:00:00.000Z",
    );
    expect(wire).toMatchObject({
      status: "absent",
      verdict: "lookup-failed",
      authority: "tad",
      provenanceClass: "Record",
    });
    expect(wire.basis).toContain("bulk_primary=true");
    expect(wire.basis).toContain("stratmap-roll");
    expect(wire.scopeSearched).toContain("stratmap-roll");
  });

  it("detects unincorporated no-zoning shape from baked facets", () => {
    const unincorporatedFacets = {
      zoning: null,
      baseFacts: { situsCity: null },
      facetCoverage: { zoning: false },
      envelope: { declineReason: "no-zoning-stamp" },
    };
    expect(parcelShapeLacksZoningAuthority(unincorporatedFacets)).toBe(true);
    expect(
      isUnincorporatedNoZoningAuthorityShape("48103:1", unincorporatedFacets),
    ).toBe(true);
    const incorporatedFacets = {
      zoning: null,
      baseFacts: { situsCity: "Bastrop" },
      envelope: { declineReason: "no-zoning-stamp" },
    };
    expect(
      isUnincorporatedNoZoningAuthorityShape("48021:34137", incorporatedFacets),
    ).toBe(false);
  });

  it("builds not-applicable zoning absence", () => {
    const wire = buildZoningNotApplicableAbsence("2026-08-22T00:00:00.000Z");
    expect(wire.verdict).toBe("not-applicable");
    expect(wire.authority).toBe("none");
  });

  it("refuses lookup-failed → absent-verified upgrade", () => {
    expect(() =>
      assertNoVerdictUpgrade("lookup-failed", "absent-verified"),
    ).toThrow(/forbidden/);
    expect(() =>
      assertNoVerdictUpgrade("lookup-failed", "lookup-failed"),
    ).not.toThrow();
  });

  it("mergeLayerVerdict enforces no upgrade", () => {
    expect(() =>
      mergeLayerVerdict(
        { source: "structural-fact" },
        {
          status: "absent",
          verdict: "absent-verified",
          authority: "x",
          scopeSearched: "x",
          asOf: "2026-08-22T00:00:00.000Z",
          basis: "x",
          provenanceClass: "Record",
        },
        { priorVerdict: "lookup-failed" },
      ),
    ).toThrow(/forbidden/);
  });
});

describe("enrichLandUseFactWithZoningVerdict", () => {
  const atomMiss: LandUseAtomMiss = {
    state: "refused",
    code: "atom-miss",
    source: "land-use-fact",
    tried: ["48103:1", "48103:1.00000000"],
    reason: "miss",
  };

  it("upgrades atom-miss to not-applicable on unincorporated unzoned shape", () => {
    const facets = {
      zoning: null,
      baseFacts: { situsCity: null },
      envelope: { declineReason: "no-zoning-stamp" },
      facetCoverage: { zoning: false },
    };
    const enriched = enrichLandUseFactWithZoningVerdict(
      atomMiss,
      "48103:1",
      facets,
    );
    expect(enriched).toMatchObject({
      status: "absent",
      verdict: "not-applicable",
      source: "land-use-fact",
    });
  });

  it("leaves atom-miss unchanged in incorporated counties", () => {
    const facets = {
      zoning: null,
      baseFacts: { situsCity: "Bastrop" },
      envelope: { declineReason: "no-zoning-stamp" },
    };
    expect(
      enrichLandUseFactWithZoningVerdict(atomMiss, "48021:34137", facets),
    ).toBe(atomMiss);
  });

  it("upgrades absent no-cad-row to not-applicable on unincorporated unzoned shape", () => {
    const absentNoCad = {
      state: "absent" as const,
      source: "land-use-fact",
      boundAs: "48055:1:2026",
      absence: {
        kind: "no-cad-row",
        reason: "no cad_property row for 48055:1 at taxYear=2026",
      },
    };
    const facets = {
      zoning: null,
      baseFacts: { situsCity: null },
      envelope: { declineReason: "no-zoning-stamp" },
      facetCoverage: { zoning: false },
    };
    const enriched = enrichLandUseFactWithZoningVerdict(
      absentNoCad,
      "48055:1",
      facets,
    );
    expect(enriched).toMatchObject({
      status: "absent",
      verdict: "not-applicable",
      absence: { kind: "no-cad-row" },
    });
  });
});
