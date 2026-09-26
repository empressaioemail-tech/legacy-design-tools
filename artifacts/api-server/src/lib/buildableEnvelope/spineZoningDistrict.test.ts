import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../routes/brokerageNodeFacets", () => ({
  loadBakedNodeFacetSnapshot: vi.fn(),
}));

vi.mock("../zoningFactServeCutover", () => ({
  loadZoningFactForServe: vi.fn(),
}));

import { loadBakedNodeFacetSnapshot } from "../../routes/brokerageNodeFacets";
import { loadZoningFactForServe } from "../zoningFactServeCutover";
import {
  recordJurisdictionKeyForDistrict,
  resolveSpineZoningWhenGisAbsent,
  spineZoningProvenanceNote,
} from "./spineZoningDistrict";

const loadBaked = vi.mocked(loadBakedNodeFacetSnapshot);
const loadRecordZoning = vi.mocked(loadZoningFactForServe);

const testEnvelopeBriefRefusal = {
  state: "refused" as const,
  code: "not-in-bake" as const,
  producer: "baked-envelope-facet" as const,
  supersededBy: "buildable-envelope" as const,
  reason: "test fixture",
};

/** Every credential/base name this module (and its sibling) can read. */
const RETRIEVAL_ENV_NAMES = [
  "HAUSKA_RETRIEVAL_API_KEY",
  "RETRIEVAL_API_KEY",
  "BRIEF_RETRIEVAL_API_KEY",
  "HAUSKA_RETRIEVAL_API_URL",
  "RETRIEVAL_API_URL",
  "BRIEF_RETRIEVAL_API_URL",
] as const;

describe("resolveSpineZoningWhenGisAbsent", () => {
  beforeEach(() => {
    loadBaked.mockReset();
    loadRecordZoning.mockReset();
    // Default: the (county, rail) pair is unslated, so no record answer.
    loadRecordZoning.mockResolvedValue(null);
    for (const name of RETRIEVAL_ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when GIS zoningCode is present, consulting neither reader", async () => {
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", "P-5");
    expect(result).toBeNull();
    expect(loadRecordZoning).not.toHaveBeenCalled();
    expect(loadBaked).not.toHaveBeenCalled();
  });

  it("P-366: reads the district the LEDGER serves from the parcel-record rail", async () => {
    // The regression this lane exists for: the card served this district from
    // the record rail ({serve:"record", atomBacked:false}) while the drawing
    // route had no record read at all and declined no-zoning-stamp.
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SF2",
      jurisdictionKey: "round-rock-tx",
      provenance: "https://maps.roundrocktexas.gov/arcgis/rest/services/Planning/Planning_Multi/MapServer/12",
    } as never);
    const result = await resolveSpineZoningWhenGisAbsent("48453:482441", null);
    // P-339/P-366 residual (2026-09-21): the rail's `zoningJurisdictionKey`
    // cell is read BESIDE the district and travels with it, because the
    // district's own source city is the jurisdiction whose setback table
    // governs it. Without this, the derivation keyed the table off the situs or
    // geocoded city — which on `48491:R415488` is Round Rock's, not
    // Pflugerville's, and refused `no-district` for a district Pflugerville
    // codifies.
    expect(result).toEqual({
      district: "SF2",
      source: "parcel-record",
      jurisdictionKey: "round-rock-tx",
    });
    // The record answers first: the bake is never needed to reach a district.
    expect(loadBaked).not.toHaveBeenCalled();
  });

  it("a source that names NO jurisdiction resolves with null, never a guess", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "R-MD",
      jurisdictionKey: null,
      provenance: null,
    } as never);
    const result = await resolveSpineZoningWhenGisAbsent("48055:40428", null);
    expect(result).toEqual({
      district: "R-MD",
      source: "parcel-record",
      jurisdictionKey: null,
    });
    expect(loadBaked).not.toHaveBeenCalled();
  });

  it("record wins over the bake when both hold one (card precedence parity)", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SF2",
      jurisdictionKey: "round-rock-tx",
      provenance: null,
    } as never);
    loadBaked.mockResolvedValue({
      parcelNodeId: "48453:482441",
      facets: { zoning: { district: "SF1", jurisdictionKey: "round-rock-tx" } },
      snapshotAt: "2026-09-10T22:36:30.509Z",
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48453:482441", "");
    expect(result).toEqual({
      district: "SF2",
      source: "parcel-record",
      jurisdictionKey: "round-rock-tx",
    });
  });

  it("falls through to the bake when the record cell is absent", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "absent",
      entityId: "48021:33512",
      reason: "no zoning determination on record",
    } as never);
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:33512",
      facets: {
        zoning: { district: "P-5", jurisdictionKey: "bastrop_city_tx" },
      },
      snapshotAt: "2026-07-20T12:00:00.000Z",
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", null);
    expect(result).toEqual({
      district: "P-5",
      source: "baked-snapshot",
      jurisdictionKey: "bastrop_city_tx",
      snapshotAt: "2026-07-20T12:00:00.000Z",
    });
  });

  it("never invents a district from a refused record cell", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "refused",
      code: "pack-refused",
      source: "zoning-fact-parcel-record",
      entityId: "48021:33512",
      reason: "cell unaccounted",
    } as never);
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:33512",
      facets: { zoning: null },
      snapshotAt: null,
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", null);
    expect(result).toBeNull();
  });

  it("falls through to the bake when the rail is unslated (null)", async () => {
    loadRecordZoning.mockResolvedValue(null);
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:33512",
      facets: {
        zoning: { district: "P-5", jurisdictionKey: "bastrop_city_tx" },
      },
      snapshotAt: "2026-07-20T12:00:00.000Z",
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:33512", "");
    expect(result?.source).toBe("baked-snapshot");
  });

  it("returns null when GIS blank, record silent and bake lacks a district", async () => {
    loadBaked.mockResolvedValue({
      parcelNodeId: "48021:99999",
      facets: { zoning: null },
      snapshotAt: null,
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    const result = await resolveSpineZoningWhenGisAbsent("48021:99999", "");
    expect(result).toBeNull();
  });

  it("returns null when no parcelNodeId is available at all", async () => {
    const result = await resolveSpineZoningWhenGisAbsent(null, null);
    expect(result).toBeNull();
    expect(loadRecordZoning).not.toHaveBeenCalled();
    expect(loadBaked).not.toHaveBeenCalled();
  });

  it("formats baked provenance without inventing", () => {
    const note = spineZoningProvenanceNote({
      district: "P-5",
      source: "baked-snapshot",
      snapshotAt: "2026-07-20T12:00:00.000Z",
    });
    expect(note).toContain("P-5");
    expect(note).toContain("baked node-facet snapshot");
    expect(note).toContain("not invented");
  });

  it("formats parcel-record provenance without inventing", () => {
    const note = spineZoningProvenanceNote({
      district: "SF2",
      source: "parcel-record",
    });
    expect(note).toContain("SF2");
    expect(note).toContain("parcel record rails");
  });
});

describe("P-366 falsifier F5 — the atom-chain read is live on the PRODUCTION credential name", () => {
  beforeEach(() => {
    loadBaked.mockReset();
    loadRecordZoning.mockReset();
    loadRecordZoning.mockResolvedValue(null);
    loadBaked.mockResolvedValue({
      parcelNodeId: "48209:150937",
      facets: { zoning: null },
      snapshotAt: null,
      tier2: null,
      envelopeBriefRefusal: testEnvelopeBriefRefusal,
    });
    for (const name of RETRIEVAL_ENV_NAMES) delete process.env[name];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchOk(district: string) {
    // Parameters are declared (and threaded through) so `mock.calls[n]` is
    // typed as a real [url, init] tuple rather than `[]` — a zero-arg mock
    // gives `calls[0]: []`, which TS refuses to narrow to the fetch signature.
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return new Response(
        JSON.stringify({ zoningFact: { district }, setbackRule: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the atom chain when only BRIEF_RETRIEVAL_API_KEY is mounted", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    // D-25 (2026-09-23): the ADDRESS is named here too. It used to come from the
    // module's hardcoded Google Cloud default, so this test proved the BRIEF_
    // credential-name fallback by riding a production default it never named.
    // `retrievalEndpoint.test.ts` asserts the unset-address refusal directly.
    process.env.BRIEF_RETRIEVAL_API_URL = "https://brief.example.com";
    const fetchMock = stubFetchOk("SF-2");
    const result = await resolveSpineZoningWhenGisAbsent("48209:150937", null);
    // The atom-chain wire this build reads names no jurisdiction, so none is
    // carried and the caller keeps its own derivation — nothing is guessed for
    // a rail that does not state it.
    expect(result).toEqual({
      district: "SF-2",
      source: "atom-chain",
      jurisdictionKey: null,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/property-nodes/48209%3A150937/atom-chain");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer brief-key",
    );
  });

  it("does not attempt the atom-chain read when no credential name is mounted", async () => {
    const fetchMock = stubFetchOk("SF-2");
    const result = await resolveSpineZoningWhenGisAbsent("48209:150937", null);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("recordJurisdictionKeyForDistrict — the record's pair, for the district being probed", () => {
  beforeEach(() => {
    loadRecordZoning.mockReset();
    loadRecordZoning.mockResolvedValue(null);
  });

  it("returns the record's jurisdiction when it names the SAME district the caller will probe", async () => {
    // `48453:239852`'s shape: the county stamp names SF-3 and no jurisdiction,
    // the record cell names the pair (`zoningDistrict` + `zoningJurisdictionKey`
    // are written together off one city's zoning layer).
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SF-3",
      jurisdictionKey: "austin-tx",
      provenance: "https://services.arcgis.com/0L95CJ0VTaxqcmED/arcgis/rest/services/Publish_Zoning_AGOL/FeatureServer/0",
    } as never);
    await expect(
      recordJurisdictionKeyForDistrict("48453:239852", "SF-3"),
    ).resolves.toBe("austin-tx");
  });

  it("reads the pair for a BASE code too, when the record names that district's own widening", async () => {
    // P-340's shape: Austin's base `SF` resolves to the parcel's own `SF-3`
    // inside the jurisdiction's table, so the pair still has to be read.
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SF-3",
      jurisdictionKey: "austin-tx",
      provenance: "x",
    } as never);
    await expect(
      recordJurisdictionKeyForDistrict("48453:239852", "SF"),
    ).resolves.toBe("austin-tx");
  });

  it("returns null for a DIFFERENT district — it reads a value beside the district, it never searches jurisdictions", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SU",
      jurisdictionKey: "cedar-park-tx",
      provenance: "x",
    } as never);
    await expect(
      recordJurisdictionKeyForDistrict("48453:239852", "SF-3"),
    ).resolves.toBeNull();
  });

  it("returns null when the record names no jurisdiction, or holds no present cell", async () => {
    loadRecordZoning.mockResolvedValue({
      state: "present",
      district: "SF-3",
      jurisdictionKey: null,
      provenance: "x",
    } as never);
    await expect(
      recordJurisdictionKeyForDistrict("48453:239852", "SF-3"),
    ).resolves.toBeNull();

    loadRecordZoning.mockResolvedValue({
      state: "refused",
      district: "",
      jurisdictionKey: null,
      reason: "unaccounted",
    } as never);
    await expect(
      recordJurisdictionKeyForDistrict("48453:239852", "SF-3"),
    ).resolves.toBeNull();
  });

  it("makes no read at all without an identity or a district to prob", async () => {
    await expect(recordJurisdictionKeyForDistrict(null, "SF-3")).resolves.toBeNull();
    await expect(recordJurisdictionKeyForDistrict("48453:239852", "")).resolves.toBeNull();
    expect(loadRecordZoning).not.toHaveBeenCalled();
  });
});
