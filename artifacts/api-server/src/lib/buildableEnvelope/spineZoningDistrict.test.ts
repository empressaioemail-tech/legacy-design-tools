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
    expect(result).toEqual({ district: "SF2", source: "parcel-record" });
    // The record answers first: the bake is never needed to reach a district.
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
    expect(result).toEqual({ district: "SF2", source: "parcel-record" });
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
    expect(note).toContain("parcel record rail");
    expect(note).toContain("not invented");
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
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ zoningFact: { district }, setbackRule: null }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("reads the atom chain when only BRIEF_RETRIEVAL_API_KEY is mounted", async () => {
    process.env.BRIEF_RETRIEVAL_API_KEY = "brief-key";
    const fetchMock = stubFetchOk("SF-2");
    const result = await resolveSpineZoningWhenGisAbsent("48209:150937", null);
    expect(result).toEqual({ district: "SF-2", source: "atom-chain" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/property-nodes/48209%3A150937/atom-chain");
    expect((init.headers as Record<string, string>).Authorization).toBe(
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
