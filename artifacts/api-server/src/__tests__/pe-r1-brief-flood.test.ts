/**
 * R1 research/brief composition — unit tests (no DATABASE_URL required).
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { extractEnvelopeBriefRefusal } from "../lib/envelopeBriefRefusal";
import {
  type FloodHazardFactPresent,
  type FloodHazardFactRefusal,
} from "../lib/floodHazardFactRead";
import { buildR1Brief, summarizeFloodZoneExposure } from "../lib/r1BriefCompose";

const tier2RetiredFloodDisposition = {
  state: "refused" as const,
  code: "retired-instrument" as const,
  producer: "fema:nfhl-flood-zone" as const,
  retiredOn: "2026-08-19",
  supersededBy: "flood-hazard-fact",
  reason:
    "Retired 2026-08-19 (lane SS-W16, P-45). This instrument queried FEMA at a 0.005-degree tile centre, not the parcel.",
};

const atomPresentFixture: FloodHazardFactPresent = {
  state: "present",
  source: "flood-hazard-fact",
  boundAs: "48055:10068.00000000",
  tried: ["48055:10068", "48055:10068.00000000"],
  entityId: "48055:10068.00000000",
  inSpecialFloodHazardArea: true,
  floodZone: "AO",
  zoneSubtype: null,
  baseFloodElevation: null,
  sourceAdapter: "fema-nfhl-bulk-v1",
  sourceVintage: "NFHL_48_20260101",
  sourceCitation: null,
  evaluatedAt: "2026-08-11T23:13:43.774Z",
};

const zoneXShadedFixture: FloodHazardFactPresent = {
  ...atomPresentFixture,
  boundAs: "48021:34137",
  tried: ["48021:34137", "48021:34137.00000000"],
  entityId: "48021:34137",
  inSpecialFloodHazardArea: false,
  floodZone: "X",
  zoneSubtype: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
};

const zoneXUnsubtypedFixture: FloodHazardFactPresent = {
  ...zoneXShadedFixture,
  zoneSubtype: null,
};

const femaCitation =
  "https://hazards.fema.gov/nfhlv2/output/State/NFHL_48_20260101.zip";

const atomMissFixture: FloodHazardFactRefusal = {
  state: "refused",
  code: "atom-miss",
  source: "flood-hazard-fact",
  tried: ["48055:10068", "48055:10068.00000000"],
  reason:
    "No flood-hazard-fact atom for 48055:10068 or 48055:10068.00000000. Atom miss, not a flood determination.",
};

describe("buildR1Brief composition", () => {
  it("atom-present overrides the baked Tier-2 flood refusal hole", () => {
    const tier2 = {
      flood: null,
      floodDisposition: tier2RetiredFloodDisposition,
    };
    const brief = buildR1Brief(
      {
        baseFacts: { landUse: { code: "A1" } },
        envelope: null,
      },
      tier2,
      { floodHazardFact: atomPresentFixture },
    );
    const floodSection = brief.sections.find((section) => section.id === "flood");
    expect(floodSection?.data).toEqual(atomPresentFixture);
    expect(floodSection?.refusal).toBeUndefined();
    expect(floodSection?.asOf).toBe(atomPresentFixture.evaluatedAt);
    expect(floodSection?.citationsDegraded).toBe(true);
    // F2 (triage D5): the prose is withheld while the citation is degraded.
    expect(floodSection).not.toHaveProperty("zoneExposureSummary");
    expect(JSON.stringify(brief)).not.toContain("FLOODWAY");
  });

  it("atom-present with sourceCitation surfaces flood citations", () => {
    const cited = {
      ...atomPresentFixture,
      sourceCitation: femaCitation,
    };
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
      { floodHazardFact: cited },
    );
    const floodSection = brief.sections.find((section) => section.id === "flood");
    expect(floodSection?.citations).toEqual([femaCitation]);
    expect(floodSection?.citationsDegraded).toBeUndefined();
    expect(brief.citations).toContain(femaCitation);
  });

  it("Zone X outside SFHA with 0.2% subtype warns against minimal-risk misread", () => {
    const summary = summarizeFloodZoneExposure(zoneXShadedFixture);
    expect(summary).toMatch(/0\.2%/);
    expect(summary).toMatch(/not minimal risk/i);

    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
      { floodHazardFact: { ...zoneXShadedFixture, sourceCitation: femaCitation } },
    );
    const floodSection = brief.sections.find((section) => section.id === "flood");
    expect(floodSection?.zoneExposureSummary).toBe(summary);
  });

  it("Zone X outside SFHA without subtype names the misread explicitly", () => {
    const summary = summarizeFloodZoneExposure(zoneXUnsubtypedFixture);
    expect(summary).toMatch(/misread/i);
    expect(summary).toMatch(/subtype was not recorded/i);
  });

  it("sections carry asOf from baked facets when present", () => {
    const brief = buildR1Brief(
      {
        bakedAt: "2026-07-22T00:00:00.000Z",
        baseFacts: {
          landUse: { code: "A1", vintage: "2025-caldwell-cad-export" },
        },
        zoning: { district: "MU", asOf: "2026-08-01T12:00:00.000Z" },
      },
      null,
      { floodHazardFact: atomPresentFixture },
    );
    expect(
      brief.sections.find((section) => section.id === "zoning")?.asOf,
    ).toBe("2026-08-01T12:00:00.000Z");
    expect(
      brief.sections.find((section) => section.id === "land-use")?.asOf,
    ).toBe("2025-caldwell-cad-export");
  });

  it("atom-miss keeps the SS-W16 tier2 floodDisposition refusal", () => {
    const tier2 = {
      flood: null,
      floodDisposition: tier2RetiredFloodDisposition,
    };
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      tier2,
      { floodHazardFact: atomMissFixture },
    );
    const floodSection = brief.sections.find((section) => section.id === "flood");
    expect(floodSection?.data).toBeNull();
    expect(floodSection?.refusal).toEqual(tier2.floodDisposition);
    expect(floodSection?.refusal).toMatchObject({
      code: "retired-instrument",
      supersededBy: "flood-hazard-fact",
    });
  });

  it("non-miss atom refusal is carried verbatim", () => {
    const storeRefusal: FloodHazardFactRefusal = {
      state: "refused",
      code: "atoms-store-not-configured",
      source: "flood-hazard-fact",
      tried: ["48055:10068", "48055:10068.00000000"],
      reason: "ATOMS store not configured.",
    };
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      { floodDisposition: tier2RetiredFloodDisposition },
      { floodHazardFact: storeRefusal },
    );
    const floodSection = brief.sections.find((section) => section.id === "flood");
    expect(floodSection?.refusal).toEqual(storeRefusal);
  });

  it("null wire envelope yields declined-in-bake refusal", () => {
    const rawFacets = {
      envelope: { status: "declined", declineReason: "no-zoning-stamp" },
      facetCoverage: { envelope: false },
    };
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } }, envelope: null },
      null,
      { envelopeBriefRefusal: extractEnvelopeBriefRefusal(rawFacets) },
    );
    const envelopeSection = brief.sections.find(
      (section) => section.id === "setbacks-envelope",
    );
    expect(envelopeSection?.data).toBeNull();
    expect(envelopeSection?.refusal).toMatchObject({
      code: "declined-in-bake",
      declineReason: "no-zoning-stamp",
      producer: "baked-envelope-facet",
      supersededBy: "buildable-envelope",
    });
    expect(envelopeSection?.agentGuidance).toContain("Do not invent");
    expect(envelopeSection?.citations).toEqual([]);
  });

  it("ok baked envelope that is stripped carries baked-envelope-not-served", () => {
    const rawFacets = {
      envelope: {
        status: "ok",
        geojson: { type: "Feature", geometry: { type: "Polygon" } },
      },
      facetCoverage: { envelope: true },
    };
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } }, envelope: null },
      null,
      { envelopeBriefRefusal: extractEnvelopeBriefRefusal(rawFacets) },
    );
    const envelopeSection = brief.sections.find(
      (section) => section.id === "setbacks-envelope",
    );
    expect(envelopeSection?.refusal).toMatchObject({
      code: "baked-envelope-not-served",
    });
  });

  it("P-91 item 9: present land-use with empty citations is citationsDegraded", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
    );
    const landUse = brief.sections.find((section) => section.id === "land-use");
    expect(landUse?.data).toEqual({ code: "A1" });
    expect(landUse?.citations).toEqual([]);
    expect(landUse?.citationsDegraded).toBe(true);
  });

  it("P-91 item 9: present flood with empty citations is citationsDegraded", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
      { floodHazardFact: zoneXShadedFixture },
    );
    const flood = brief.sections.find((section) => section.id === "flood");
    expect(flood?.data).toMatchObject({ state: "present", floodZone: "X" });
    expect(flood?.citations).toEqual([]);
    expect(flood?.citationsDegraded).toBe(true);
  });

  it("present wire envelope keeps data and citations", () => {
    const envelope = {
      status: "ok",
      citationUrl: "https://example.test/setbacks",
      geojson: {
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[-97, 30], [-97.1, 30], [-97, 30]]],
        },
      },
    };
    const brief = buildR1Brief({ envelope, baseFacts: { landUse: { code: "A1" } } }, null);
    const envelopeSection = brief.sections.find(
      (section) => section.id === "setbacks-envelope",
    );
    expect(envelopeSection?.data).toEqual(envelope);
    expect(envelopeSection?.refusal).toBeUndefined();
    expect(envelopeSection?.citations).toContain("https://example.test/setbacks");
    expect(envelopeSection?.asOf).toBeNull();
  });
});

/**
 * F2 (v2 card, triage D5). A degraded flood section produced the most
 * quotable sentence in the brief. While the citation is degraded the prose
 * is withheld; with a citation it is emitted; and none of it carries an em
 * dash.
 */
describe("F2 flood prose is withheld while the citation is degraded", () => {
  it("gold-shaped present flood with no citation: citationsDegraded, empty citations, no zoneExposureSummary", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
      { floodHazardFact: atomPresentFixture },
    );
    const flood = brief.sections.find((section) => section.id === "flood");
    expect(flood?.data).toEqual(atomPresentFixture);
    expect(flood?.citations).toEqual([]);
    expect(flood?.citationsDegraded).toBe(true);
    expect(flood).not.toHaveProperty("zoneExposureSummary");
  });

  it("the same fact with a citation emits the summary", () => {
    const brief = buildR1Brief(
      { baseFacts: { landUse: { code: "A1" } } },
      null,
      { floodHazardFact: { ...atomPresentFixture, sourceCitation: femaCitation } },
    );
    const flood = brief.sections.find((section) => section.id === "flood");
    expect(flood?.citations).toEqual([femaCitation]);
    expect(flood).not.toHaveProperty("citationsDegraded");
    expect(flood?.zoneExposureSummary).toMatch(/Special Flood Hazard Area/);
  });

  it("no summary string, emitted or in source, contains an em dash", () => {
    const source = readFileSync(
      new URL("../lib/r1BriefCompose.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/—/);
    const fixtures: FloodHazardFactPresent[] = [
      atomPresentFixture,
      zoneXShadedFixture,
      zoneXUnsubtypedFixture,
      { ...zoneXShadedFixture, zoneSubtype: "AREA OF MINIMAL FLOOD HAZARD" },
      { ...zoneXShadedFixture, floodZone: "D" },
      { ...zoneXShadedFixture, floodZone: "" },
      { ...atomPresentFixture, baseFloodElevation: 412 },
    ];
    for (const fixture of fixtures) {
      expect(summarizeFloodZoneExposure(fixture) ?? "").not.toMatch(/—/);
    }
  });
});

/**
 * F7 (v2 card, triage D3). The stub advertises a drainage rail; node depth
 * must carry a drainage section so the rail can be opened. Until the facet
 * exists the section is unread with a reason; when the bake carries a
 * drainage facet the section carries it like the other sections.
 */
describe("F7 drainage is a section", () => {
  const BAKED_AT = "2026-08-20T00:00:00.000Z";

  it("node depth carries a drainage section, unread with a reason, until the facet exists", () => {
    const brief = buildR1Brief(
      { bakedAt: BAKED_AT, baseFacts: { landUse: { code: "A1" } } },
      null,
    );
    const drainage = brief.sections.find((section) => section.id === "drainage");
    expect(drainage).toEqual({
      id: "drainage",
      title: "Drainage",
      data: null,
      citations: [],
      asOf: BAKED_AT,
      disposition: "unread",
      reason: "drainage facet not produced for this parcel",
    });
  });

  it("a bake with a drainage facet carries it present like the other sections", () => {
    const facet = {
      catchmentAreaAcres: 1.2,
      flowLineCount: 2,
      sourceUrl: "https://example.test/drainage/48021-34137",
      evaluatedAt: "2026-08-25T00:00:00.000Z",
    };
    const brief = buildR1Brief({ bakedAt: BAKED_AT, drainage: facet }, null);
    const drainage = brief.sections.find((section) => section.id === "drainage");
    expect(drainage).toMatchObject({
      id: "drainage",
      title: "Drainage",
      data: facet,
      disposition: "present",
      citations: ["https://example.test/drainage/48021-34137"],
      asOf: "2026-08-25T00:00:00.000Z",
    });
    expect(drainage).not.toHaveProperty("reason");
    expect(drainage).not.toHaveProperty("citationsDegraded");
  });

  it("every section carries a disposition in the four-word vocabulary", () => {
    const brief = buildR1Brief(
      { bakedAt: BAKED_AT, zoning: { district: "SF-1" }, baseFacts: { landUse: null } },
      null,
      { floodHazardFact: atomMissFixture },
    );
    expect(brief.sections.map((section) => section.id)).toEqual([
      "zoning",
      "setbacks-envelope",
      "flood",
      "land-use",
      "drainage",
    ]);
    for (const section of brief.sections) {
      expect(["present", "absent", "refused", "unread"]).toContain(
        (section as { disposition?: unknown }).disposition,
      );
    }
  });
});
