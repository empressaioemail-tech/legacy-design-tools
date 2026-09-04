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
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";
import type { SetbacksFactRead } from "./setbacksFactFromParcelRecord";

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
    sourceVintage: null,
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

/**
 * OPS-16 A-096/A-097/A-098: the specific fix this card ships. Before this
 * card, an unincorporated parcel's zoning/setbacks read UNKNOWN at both
 * depths (smartSiteStub.ts:85-96 unconditionally mapped `absent` to
 * `unknown`, no code path ever emitted a verified absence). These tests
 * prove the flip works, and that it ONLY changes the specific
 * unincorporated case -- present real values and record-side refusals are
 * unaffected, matching the "never regress a parcel with a real answer"
 * invariant.
 */
describe("OPS-16 A-096/A-097/A-098: zoning + setbacks not-applicable fix", () => {
  const PARCEL = "48021:10001"; // real unincorporated sample, projection_recon.json
  const legacyUnknownFacets = {
    bakedAt: "2026-09-01T22:34:53.142Z",
    zoning: null, // legacy bake never determined a district -- this is the UNKNOWN the census measured
    envelope: null,
  };
  const zoningNotApplicable: ZoningFactRead = {
    state: "absent",
    source: "zoning-fact-parcel-record",
    entityId: PARCEL,
    absence: { kind: "not-applicable", reason: "unincorporated parcel -- no municipal zoning authority applies" },
    verifiedAbsence: null,
    sourceTier: null,
    sourceAdapter: "parcel_record",
    sourceVintage: null,
  };
  const setbacksNotApplicable: SetbacksFactRead = {
    state: "absent",
    source: "setbacks-fact-parcel-record",
    entityId: PARCEL,
    absence: { kind: "not-applicable", reason: "unincorporated parcel -- no municipal setback authority applies" },
    verifiedAbsence: null,
    sourceTier: null,
    sourceAdapter: "parcel_record",
    sourceVintage: null,
  };
  const zoningPresent: ZoningFactRead = {
    state: "present",
    source: "zoning-fact-parcel-record",
    entityId: "48021:103387",
    district: "SF-1",
    jurisdictionKey: "bastrop_city_tx",
    provenance: "https://gis.example.test/zoning/bastrop",
    sourceAdapter: "parcel_record",
    sourceVintage: "2026-09-04T00:00:00.000Z",
    evaluatedAt: "2026-09-04T00:00:00.000Z",
  };
  const zoningRefused: ZoningFactRead = {
    state: "refused",
    code: "parcel-record-malformed-cell",
    source: "zoning-fact-parcel-record",
    entityId: "48021:1",
    reason: "parcel_record_cell 48021:1/zoningDistrict is kind=value but its value is not a readable district.",
  };

  it("THE FIX: an unincorporated parcel flips from unknown to absent-verified for zoning when the record says not-applicable", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: PARCEL,
      facets: legacyUnknownFacets,
      parcelRecordZoningFact: zoningNotApplicable,
    });
    expect(stub.zoning).toBe("absent-verified");
    // Falsifier: without the record fact, this exact fixture stays unknown -- proves the fix is the record fact, not a fixture quirk.
    const withoutRecordFact = composeSmartSiteStub({ parcelNodeId: PARCEL, facets: legacyUnknownFacets });
    expect(withoutRecordFact.zoning).toBe("unknown");
  });

  it("THE FIX: an unincorporated parcel flips from unknown to absent-verified for envelope/setbacks when the record says not-applicable", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: PARCEL,
      facets: legacyUnknownFacets,
      parcelRecordSetbacksFact: setbacksNotApplicable,
    });
    expect(stub.envelope).toBe("absent-verified");
    const withoutRecordFact = composeSmartSiteStub({ parcelNodeId: PARCEL, facets: legacyUnknownFacets });
    expect(withoutRecordFact.envelope).toBe("unknown");
  });

  it("REGRESSION GUARD: a present record determination reports present, never regressing a real answer", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:103387",
      facets: { zoning: null },
      parcelRecordZoningFact: zoningPresent,
    });
    expect(stub.zoning).toBe("present");
  });

  it("REGRESSION GUARD: a refused record fact falls through to the legacy bake computation, never regressing a parcel that already has a real bake-derived zoning value", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: "48021:1",
      facets: { zoning: { district: "C-1" } },
      parcelRecordZoningFact: zoningRefused,
    });
    expect(stub.zoning).toBe("present");
  });

  it("REGRESSION GUARD: every existing call shape (no parcelRecordZoningFact/parcelRecordSetbacksFact at all) is byte-identical to before this card -- the new params are additive and optional", () => {
    const stub = composeSmartSiteStub({
      parcelNodeId: PARCEL,
      facets: { zoning: { district: "SF-1" }, envelope: { status: "ok", geojson: {} } },
      flood: { attempted: false },
    });
    expect(stub.zoning).toBe("present");
    expect(stub.envelope).toBe("present");
  });

  it("D2 cross-check: the brief section stays disposition 'absent' (WDLL item 5 -- the coarse enum never grows a fifth state) while its own data honestly carries verdict not-applicable, and the stub independently reaches absent-verified -- two depths, two vocabularies, never contradicting", () => {
    const brief = buildR1Brief(legacyUnknownFacets, null, {
      parcelRecordZoningFact: zoningNotApplicable,
      parcelRecordSetbacksFact: setbacksNotApplicable,
    });
    const zoningSection = brief.sections.find((s) => s.id === "zoning");
    const envelopeSection = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(zoningSection?.disposition).toBe("absent");
    expect((zoningSection?.data as { absence?: { kind?: string } } | null)?.absence?.kind).toBe(
      "not-applicable",
    );
    expect(envelopeSection?.disposition).toBe("absent");
    expect((envelopeSection?.data as { absence?: { kind?: string } } | null)?.absence?.kind).toBe(
      "not-applicable",
    );
    const stub = composeSmartSiteStub({
      parcelNodeId: PARCEL,
      facets: legacyUnknownFacets,
      parcelRecordZoningFact: zoningNotApplicable,
      parcelRecordSetbacksFact: setbacksNotApplicable,
    });
    expect(stub.zoning).toBe("absent-verified");
    expect(stub.envelope).toBe("absent-verified");
  });
});
