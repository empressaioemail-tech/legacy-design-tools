import { describe, expect, it } from "vitest";
import type { EnvelopeBriefRefusal } from "./envelopeBriefRefusal";
import type { FloodHazardFactRead } from "./floodHazardFactRead";
import { buildR1Brief } from "./r1BriefCompose";
import {
  composeSmartSiteStub,
  railStateFromRead,
  SMART_SITE_STUB_RAILS,
  type RailReadInput,
  type SmartSiteRailState,
} from "./smartSiteStub";

const ATOM_MISS = {
  attempted: true,
  state: "refused" as const,
  code: "atom-miss",
  kind: "flood" as const,
};

describe("railStateFromRead", () => {
  it("returns unread only when the read was not attempted", () => {
    expect(railStateFromRead({ attempted: false })).toBe("unread");
  });

  it("maps atom-miss to unknown, never absent-verified", () => {
    expect(railStateFromRead(ATOM_MISS)).toBe("unknown");
    expect(railStateFromRead(ATOM_MISS)).not.toBe("absent-verified");
  });

  it("maps pipeline present-outside to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "present",
        kind: "pipeline",
        presentOutside: true,
      }),
    ).toBe("absent-verified");
  });

  it("maps :sd:outside to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "absent",
        kind: "sd",
        entityId: "48021:34137:sd:outside",
      }),
    ).toBe("absent-verified");
  });

  it("does not promote flood typed-absence to absent-verified", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "absent",
        kind: "flood",
      }),
    ).toBe("unknown");
  });

  it("maps a non-miss refusal to refused", () => {
    expect(
      railStateFromRead({
        attempted: true,
        state: "refused",
        code: "atoms-store-not-configured",
      }),
    ).toBe("refused");
  });
});

describe("composeSmartSiteStub", () => {
  it("emits five-state rails only, with drainage unread when never fetched", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:34137",
      facets: {
        situsAddress: "908 PINE, BASTROP, TX 78602",
        zoning: { district: "SF-1" },
        baseFacts: { landUse: { landUseCode: "A1" } },
      },
      flood: {
        attempted: true,
        state: "present",
        kind: "flood",
      },
      envelopeBriefRefusal: { state: "refused" },
    });
    expect(Object.keys(stub).sort()).toEqual(
      [
        "drainage",
        "envelope",
        "flood",
        "label",
        "landUse",
        "parcelNodeId",
        "situs",
        "url",
        "zoning",
      ].sort(),
    );
    for (const rail of SMART_SITE_STUB_RAILS) {
      expect(["present", "absent-verified", "unknown", "refused", "unread"]).toContain(
        stub[rail],
      );
    }
    expect(stub.label).toBe("908 PINE, BASTROP, TX 78602");
    expect(stub.url).toBe("https://smartsite.cloud/p/48021:34137");
    expect(stub.situs).toBe("present");
    expect(stub.zoning).toBe("present");
    expect(stub.landUse).toBe("present");
    expect(stub.flood).toBe("present");
    expect(stub.drainage).toBe("unread");
    expect(stub.envelope).toBe("refused");
  });

  it("A4: flood atom-miss is unknown and drainage unread stay distinct", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:25420",
      facets: { baseFacts: { situsAddress: ", ," } },
      flood: ATOM_MISS,
    });
    expect(stub.situs).toBe("unknown");
    expect(stub.label).toBe("48021:25420");
    expect(stub.flood).toBe("unknown");
    expect(stub.drainage).toBe("unread");
    expect(stub.flood).not.toBe(stub.drainage);
  });

  it("falsifier: unread does not collapse into unknown", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:34137",
      facets: { zoning: { district: "SF-1" } },
      flood: ATOM_MISS,
      drainage: { attempted: false },
    });
    expect(stub.drainage).toBe("unread");
    expect(stub.flood).toBe("unknown");
    if (stub.drainage === stub.flood) {
      throw new Error("unread collapsed into unknown");
    }
  });
});

/**
 * D2 (triage, v2 card F7 check). The stub is a projection of the node: each
 * rail that has a section equals that section disposition mapped into the
 * rail vocabulary (present, refused, absent to unknown, unread). Both are
 * composed from one baked snapshot fixture and each is asserted against the
 * expected state (WDLL item 5 and the stub law in this module), so two wrong
 * sides cannot pass by agreeing with each other.
 */
describe("D2 stub is a projection of node", () => {
  const PARCEL = "48021:34137";
  const PARCEL_PADDED = "48021:34137.00000000";
  const BAKED_AT = "2026-08-20T00:00:00.000Z";
  const RAIL_FROM_DISPOSITION: Record<string, SmartSiteRailState | undefined> = {
    present: "present",
    refused: "refused",
    absent: "unknown",
    unread: "unread",
  };
  const SECTION_FOR_RAIL = {
    zoning: "zoning",
    landUse: "land-use",
    flood: "flood",
    drainage: "drainage",
    envelope: "setbacks-envelope",
  } as const;
  type SectionRail = keyof typeof SECTION_FOR_RAIL;
  const SECTION_RAILS = Object.keys(SECTION_FOR_RAIL) as SectionRail[];

  /** Mirrors floodReadToRail in routes/propertyExplorer.ts. */
  function floodReadToRail(flood: FloodHazardFactRead): RailReadInput {
    return {
      attempted: true,
      state: flood.state,
      code: flood.state === "refused" ? flood.code : undefined,
      kind: "flood",
    };
  }

  const floodPresent: FloodHazardFactRead = {
    state: "present",
    source: "flood-hazard-fact",
    boundAs: PARCEL,
    tried: [PARCEL, PARCEL_PADDED],
    entityId: PARCEL,
    inSpecialFloodHazardArea: false,
    floodZone: "X",
    zoneSubtype: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
    baseFloodElevation: null,
    sourceAdapter: "fema-nfhl-bulk-v1",
    sourceVintage: "NFHL_48_20260101",
    sourceCitation: null,
    evaluatedAt: "2026-08-11T23:13:43.774Z",
  };
  const floodTypedAbsence: FloodHazardFactRead = {
    state: "absent",
    source: "flood-hazard-fact",
    boundAs: PARCEL,
    tried: [PARCEL, PARCEL_PADDED],
    entityId: PARCEL,
    absence: {
      kind: "outside-mapped-zones",
      reason: "no NFHL polygon intersects the parcel",
    },
    verifiedAbsence: null,
    sourceTier: "public",
    sourceAdapter: "fema-nfhl-bulk-v1",
  };
  const floodAtomMiss: FloodHazardFactRead = {
    state: "refused",
    code: "atom-miss",
    source: "flood-hazard-fact",
    tried: [PARCEL, PARCEL_PADDED],
    reason: "No flood-hazard-fact atom. Atom miss, not a flood determination.",
  };
  const floodStoreRefusal: FloodHazardFactRead = {
    state: "refused",
    code: "atoms-store-not-configured",
    source: "flood-hazard-fact",
    tried: [PARCEL, PARCEL_PADDED],
    reason: "ATOMS store not configured.",
  };
  const envelopeDeclined: EnvelopeBriefRefusal = {
    state: "refused",
    code: "declined-in-bake",
    producer: "baked-envelope-facet",
    supersededBy: "buildable-envelope",
    reason: "Envelope declined in bake.",
    declineReason: "atom_path_pending",
  };
  const tier2Retired = {
    flood: null,
    floodDisposition: {
      state: "refused",
      code: "retired-instrument",
      producer: "fema:nfhl-flood-zone",
      retiredOn: "2026-08-19",
      supersededBy: "flood-hazard-fact",
      reason: "Retired 2026-08-19 (lane SS-W16, P-45).",
    },
  };
  const goldFacets = {
    bakedAt: BAKED_AT,
    situsAddress: "908 PINE, BASTROP, TX 78602",
    zoning: {
      district: "SF-1",
      jurisdictionKey: "bastrop_city_tx",
      provenance: { sourceUrl: "https://gis.example.test/zoning/bastrop" },
    },
    baseFacts: { landUse: null },
    envelope: null,
  };

  type Case = {
    name: string;
    facets: unknown;
    tier2?: unknown;
    flood?: FloodHazardFactRead;
    envelopeBriefRefusal?: EnvelopeBriefRefusal | null;
    expect: Record<SectionRail, SmartSiteRailState>;
  };

  const CASES: Case[] = [
    {
      name: "gold: zoning stamped, no land use, flood present uncited, envelope declined, no drainage facet",
      facets: goldFacets,
      flood: floodPresent,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "present", drainage: "unread", envelope: "refused" },
    },
    {
      name: "land use code from the CAD roll is present",
      facets: {
        ...goldFacets,
        baseFacts: {
          landUse: { code: "A1", description: "Single-family", source: "cad-roll", vintage: "2025" },
        },
      },
      flood: floodPresent,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "present", flood: "present", drainage: "unread", envelope: "refused" },
    },
    {
      name: "flood typed absence is not promoted: unknown on both",
      facets: goldFacets,
      flood: floodTypedAbsence,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "unknown", drainage: "unread", envelope: "refused" },
    },
    {
      name: "flood atom-miss with the retired tier2 disposition is unknown on both",
      facets: goldFacets,
      tier2: tier2Retired,
      flood: floodAtomMiss,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "unknown", drainage: "unread", envelope: "refused" },
    },
    {
      name: "flood store refusal is refused on both",
      facets: goldFacets,
      flood: floodStoreRefusal,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "refused", drainage: "unread", envelope: "refused" },
    },
    {
      name: "a drainage facet in the bake is present on both",
      facets: {
        ...goldFacets,
        drainage: {
          catchmentAreaAcres: 1.2,
          sourceUrl: "https://example.test/drainage",
          evaluatedAt: "2026-08-25T00:00:00.000Z",
        },
      },
      flood: floodPresent,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "present", drainage: "present", envelope: "refused" },
    },
    {
      name: "envelope product data is present on both",
      facets: {
        ...goldFacets,
        envelope: { status: "ok", geojson: { type: "FeatureCollection", features: [] } },
      },
      flood: floodPresent,
      envelopeBriefRefusal: null,
      expect: { zoning: "present", landUse: "unknown", flood: "present", drainage: "unread", envelope: "present" },
    },
    {
      name: "empty records are not determinations: zoning {} and landUse {} are unknown on both",
      facets: { ...goldFacets, zoning: {}, baseFacts: { landUse: {} } },
      flood: floodPresent,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "unknown", landUse: "unknown", flood: "present", drainage: "unread", envelope: "refused" },
    },
    {
      name: "a land use record with no code is not a determination",
      facets: {
        ...goldFacets,
        baseFacts: { landUse: { description: null, source: "cad-roll", vintage: "2025" } },
      },
      flood: floodPresent,
      envelopeBriefRefusal: envelopeDeclined,
      expect: { zoning: "present", landUse: "unknown", flood: "present", drainage: "unread", envelope: "refused" },
    },
  ];

  function composeBoth(c: Case) {
    const node = buildR1Brief(c.facets, c.tier2 ?? null, {
      floodHazardFact: c.flood,
      envelopeBriefRefusal: c.envelopeBriefRefusal,
    });
    const stub = composeSmartSiteStub({
      parcelNodeId: PARCEL,
      facets: c.facets,
      flood: c.flood ? floodReadToRail(c.flood) : undefined,
      drainage: { attempted: false },
      envelopeBriefRefusal: c.envelopeBriefRefusal,
    });
    const projected: Record<string, string | undefined> = {};
    const stubRails: Record<string, string | undefined> = {};
    for (const rail of SECTION_RAILS) {
      const section = node.sections.find((s) => s.id === SECTION_FOR_RAIL[rail]) as
        | { disposition?: unknown }
        | undefined;
      const disposition = section ? String(section.disposition) : "<no section>";
      projected[rail] = section
        ? (RAIL_FROM_DISPOSITION[disposition] ?? "<" + disposition + ">")
        : disposition;
      stubRails[rail] = stub[rail];
    }
    return { node, stub, projected, stubRails };
  }

  it.each(CASES)("$name", (c) => {
    const { projected, stubRails } = composeBoth(c);
    expect(stubRails).toEqual(c.expect);
    expect(projected).toEqual(c.expect);
  });
});
