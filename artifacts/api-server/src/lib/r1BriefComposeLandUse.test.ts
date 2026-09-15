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

/**
 * P-207 (2026-09-14): the payload-contradiction fixture. `get_smart_site`
 * depth-node for 48209:97658 returned brief.sections[land-use] absent/
 * join-hold in the same response as draw.attrs.landUse present "C1" -- both
 * built from the SAME baked payload. Live-verified (`place_layer_snapshots`,
 * legacy-design-tools-prod neondb, adapter_key node-facets:tier1, place_key
 * node:48209:97658): `baseFacts.landUse` carries `source:
 * "cad-roll-address-join"` and `provenance.landUseAddressRecovered: true` --
 * a REAL, owner-gated situs-address recovery (buildTier1Payload's
 * resolveAddressLandUse) from the certified 2026-08-26 Hays CAD drop, not the
 * disabled prop_id join (LANDUSE_JOIN_DISABLED_FIPS_SEED). The land-use-fact
 * atom (evaluated 2026-08-12, `cad-property-land-use-v1`) predates that
 * recovery and has no address-join mechanism of its own -- it always reports
 * join-hold for a gate-blocked county regardless of what the bake later
 * recovers. Root cause (LANDUSE_JOIN_DISABLED_FIPS_SEED, the join being
 * disabled) is P-180's finding, not re-derived here; this fixture is about
 * the disagreement between the two readers of one bake, not the join itself.
 */
describe("buildR1Brief P-207: address-join recovery vs a join-hold atom absence", () => {
  const HAYS_BASE_FACTS = {
    landUse: {
      code: "C1",
      description: "Vacant lot or tract",
      source: "cad-roll-address-join",
      vintage: "tier:cad-export;adapter:orion;drop:hays_20260826_certified",
    },
  };
  const HAYS_JOIN_HOLD_ATOM: LandUseFactTypedAbsence = {
    state: "absent",
    source: "land-use-fact",
    boundAs: "48209:97658:2026",
    tried: ["48209:97658", "48209:97658.00000000"],
    entityId: "48209:97658:2026",
    taxYear: 2026,
    absence: {
      kind: "join-hold",
      reason:
        "LANDUSE_JOIN_HOLD county 48209 — TxGIO prop_id does not join CAD property_use_code",
    },
    verifiedAbsence: null,
    sourceTier: "cad-authoritative",
    sourceAdapter: "cad-property-land-use-v1",
  };

  it("FALSIFIER control: a join-hold absence with NO address recovery is unaffected -- absence still wins", () => {
    const brief = buildR1Brief(
      {
        baseFacts: HAYS_BASE_FACTS,
        provenance: { landUseGateBlocked: true, landUseAddressRecovered: false },
      },
      null,
      { landUseFact: HAYS_JOIN_HOLD_ATOM },
    );
    expect(landUseSectionOf(brief)?.disposition).toBe("absent");
    expect(landUseSectionOf(brief)?.data).toEqual(HAYS_JOIN_HOLD_ATOM);
  });

  it("the real P-207 case: an address-recovered baked value outranks the atom's join-hold absence", () => {
    const brief = buildR1Brief(
      {
        baseFacts: HAYS_BASE_FACTS,
        provenance: { landUseGateBlocked: true, landUseAddressRecovered: true },
      },
      null,
      { landUseFact: HAYS_JOIN_HOLD_ATOM },
    );
    expect(landUseSectionOf(brief)?.disposition).toBe("present");
    expect(landUseSectionOf(brief)?.data).toEqual(HAYS_BASE_FACTS.landUse);
    // This is what draw.attrs.landUse already independently reads
    // (parcelDrawFromReads.ts: `landUse: baseFacts.landUse ?? null`) --
    // brief and draw now agree on the same recovered value.
  });
});
