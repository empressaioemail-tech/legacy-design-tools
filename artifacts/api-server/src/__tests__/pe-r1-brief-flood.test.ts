/**
 * R1 research/brief composition — unit tests (no DATABASE_URL required).
 */

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
    expect(floodSection?.zoneExposureSummary).toMatch(/Special Flood Hazard Area/);
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
      { floodHazardFact: zoneXShadedFixture },
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
    });
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
