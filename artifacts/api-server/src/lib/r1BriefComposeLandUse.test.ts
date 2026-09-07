/**
 * buildR1Brief's land-use section — PE/MCP-vs-facets parity audit
 * (2026-09-07, finding D2). Before this fix, this section always read
 * `baseFacts.landUse` (the retired-store cad-roll object) and never the real
 * land-use-fact atom brokerageNodeFacets.ts's facets route already reads.
 * Same "record wins whenever it has genuinely earned one (present, or a
 * verified absence)" rule composeZoningBriefSectionFromParcelRecord and
 * composeSetbacksBriefSectionFromParcelRecord already apply for their own
 * sections -- but land-use-fact has no allowlist/gate cutover, so "no atom
 * at all" arrives as a REFUSED code (atom-miss), not an absent state.
 */

import { describe, expect, it } from "vitest";
import { buildR1Brief, composeLandUseBriefSectionFromAtom } from "./r1BriefCompose";
import type {
  LandUseFactPresent,
  LandUseFactTypedAbsence,
  LandUseFactRefusal,
} from "./landUseFactRead";

const BAKED_LAND_USE = { code: "A1", description: "Single-family residential", source: "cad-roll", vintage: "2026-06-05" };

const PRESENT_ATOM: LandUseFactPresent = {
  state: "present",
  source: "land-use-fact",
  boundAs: "48453:493738",
  tried: ["48453:493738", "48453:493738.00000000"],
  entityId: "48453:493738:2025",
  taxYear: 2025,
  landUseCode: "SF-RESIDENTIAL",
  landUseLabel: "Single Family Residential",
  sourceAdapter: "cad-export",
  sourceVintage: "2025",
  evaluatedAt: "2026-09-01T00:00:00.000Z",
};

const ABSENT_ATOM: LandUseFactTypedAbsence = {
  state: "absent",
  source: "land-use-fact",
  boundAs: "48021:10001",
  tried: ["48021:10001", "48021:10001.00000000"],
  entityId: "48021:10001:2025",
  taxYear: 2025,
  absence: { kind: "absent-verified", reason: "swept the CAD export, no row for this parcel" },
  verifiedAbsence: true,
  sourceTier: "cad-export",
  sourceAdapter: "cad-export",
};

const REFUSED_ATOM: LandUseFactRefusal = {
  state: "refused",
  code: "atom-miss",
  source: "land-use-fact",
  tried: ["48055:10068", "48055:10068.00000000"],
  reason: "No land-use-fact atom for either bind prefix. Atom miss, not a land-use determination.",
};

function landUseSectionOf(brief: ReturnType<typeof buildR1Brief>) {
  return brief.sections.find((s) => s.id === "land-use");
}

describe("composeLandUseBriefSectionFromAtom", () => {
  it("present: narrows to {landUseCode, landUseLabel}, disposition present", () => {
    const part = composeLandUseBriefSectionFromAtom(PRESENT_ATOM, "2026-09-01T00:00:00.000Z");
    expect(part.data).toEqual({ landUseCode: "SF-RESIDENTIAL", landUseLabel: "Single Family Residential" });
    expect(part.disposition).toBe("present");
    expect(part.asOf).toBe("2026-09-01T00:00:00.000Z");
  });

  it("absent: data is the raw fact object, disposition absent", () => {
    const part = composeLandUseBriefSectionFromAtom(ABSENT_ATOM, null);
    expect(part.data).toEqual(ABSENT_ATOM);
    expect(part.disposition).toBe("absent");
  });
});

describe("buildR1Brief land-use precedence", () => {
  it("baseline (no landUseFact option): the retired baked value still wins, unchanged behavior", () => {
    const brief = buildR1Brief({ baseFacts: { landUse: BAKED_LAND_USE } }, null);
    expect(landUseSectionOf(brief)?.data).toEqual(BAKED_LAND_USE);
    expect(landUseSectionOf(brief)?.disposition).toBe("present");
  });

  it("D2 FIX: a present atom overrides an EXISTING baked value -- the core bug", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: BAKED_LAND_USE } },
      null,
      { landUseFact: PRESENT_ATOM },
    );
    expect(landUseSectionOf(brief)?.data).toEqual({
      landUseCode: "SF-RESIDENTIAL",
      landUseLabel: "Single Family Residential",
    });
    expect(landUseSectionOf(brief)?.data).not.toEqual(BAKED_LAND_USE);
  });

  it("an absent-verified atom overrides the baked value too (same rule as zoning/setbacks' own absent branch)", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: BAKED_LAND_USE } },
      null,
      { landUseFact: ABSENT_ATOM },
    );
    expect(landUseSectionOf(brief)?.data).toEqual(ABSENT_ATOM);
    expect(landUseSectionOf(brief)?.disposition).toBe("absent");
  });

  it("a REFUSED atom (atom-miss -- no allowlist/gate step exists for this fact) falls through to the baked value exactly like 'not cut over'", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: BAKED_LAND_USE } },
      null,
      { landUseFact: REFUSED_ATOM },
    );
    expect(landUseSectionOf(brief)?.data).toEqual(BAKED_LAND_USE);
  });

  it("a null landUseFact (never fetched / not configured) behaves identically to omitting the option", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: BAKED_LAND_USE } },
      null,
      { landUseFact: null },
    );
    expect(landUseSectionOf(brief)?.data).toEqual(BAKED_LAND_USE);
  });

  it("no baked value and a present atom: the atom alone supplies the section", () => {
    const brief = buildR1Brief(
      { baseFacts: {} },
      null,
      { landUseFact: PRESENT_ATOM },
    );
    expect(landUseSectionOf(brief)?.data).toEqual({
      landUseCode: "SF-RESIDENTIAL",
      landUseLabel: "Single Family Residential",
    });
  });
});
