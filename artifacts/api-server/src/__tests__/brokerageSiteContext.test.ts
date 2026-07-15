/**
 * brokerageSiteContext — federal environmental + Cotality investor depth.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const runAdaptersMock = vi.hoisted(() => vi.fn());
const resolveJurisdictionMock = vi.hoisted(() => vi.fn());
const readPlaceLayerSnapshotMock = vi.hoisted(() => vi.fn());
const writePlaceLayerSnapshotMock = vi.hoisted(() => vi.fn());
const createAdapterResponseCacheMock = vi.hoisted(() => vi.fn());
const isTceqEdwardsEnabledMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/placeLayerSnapshots", () => ({
  readPlaceLayerSnapshot: readPlaceLayerSnapshotMock,
  writePlaceLayerSnapshot: writePlaceLayerSnapshotMock,
}));

vi.mock("../lib/adapterCache", () => ({
  createAdapterResponseCache: createAdapterResponseCacheMock,
}));

vi.mock("@workspace/adapters", async () => {
  const actual = await vi.importActual<typeof import("@workspace/adapters")>(
    "@workspace/adapters",
  );
  return {
    ...actual,
    runAdapters: runAdaptersMock,
    resolveJurisdiction: resolveJurisdictionMock,
    isTceqEdwardsEnabled: isTceqEdwardsEnabledMock,
  };
});

const {
  fetchBrokerageSiteContext,
  formatSiteContextForLlm,
  BROKERAGE_SITE_CONTEXT_TIMEOUT_MS,
} = await import("../lib/brokerageSiteContext");

const FREE_ADAPTER_KEYS = [
  "fema:nfhl-flood-zone",
  "cotality:parcels",
  "cotality:zoning",
  // feat/cad-brief-adapters — free county appraisal-district slots.
  "cad:property",
  "cad:tax",
  "cad:owner-occupancy",
  // feat/permits-brief-slot — owned Austin/SA issued-permit corpus.
  "permits:record",
  "national:opportunity-zone",
];

describe("fetchBrokerageSiteContext", () => {
  beforeEach(() => {
    runAdaptersMock.mockReset();
    resolveJurisdictionMock.mockReset();
    readPlaceLayerSnapshotMock.mockReset();
    readPlaceLayerSnapshotMock.mockResolvedValue(null);
    writePlaceLayerSnapshotMock.mockReset();
    createAdapterResponseCacheMock.mockReturnValue(undefined);
    isTceqEdwardsEnabledMock.mockReturnValue(false);
    resolveJurisdictionMock.mockReturnValue({
      stateKey: "texas",
      localKey: "bastrop-tx",
    });
  });

  it("returns empty layers when coordinates are invalid", async () => {
    const ctx = await fetchBrokerageSiteContext({
      latitude: NaN,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
    });
    expect(ctx.layers).toEqual([]);
    expect(runAdaptersMock).not.toHaveBeenCalled();
  });

  it("maps FEMA and Cotality free-tier adapter outcomes to siteContext.layers", async () => {
    runAdaptersMock.mockResolvedValue([
      {
        adapterKey: "fema:nfhl-flood-zone",
        tier: "federal",
        layerKind: "fema-nfhl-flood-zone",
        status: "ok",
        result: {
          adapterKey: "fema:nfhl-flood-zone",
          tier: "federal",
          layerKind: "fema-nfhl-flood-zone",
          sourceKind: "federal-adapter",
          provider: "FEMA NFHL",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "flood-zone",
            inSpecialFloodHazardArea: true,
            floodZone: "AE",
            baseFloodElevation: 425.5,
          },
        },
      },
      {
        adapterKey: "cotality:parcels",
        tier: "federal",
        layerKind: "cotality-parcel",
        status: "ok",
        result: {
          adapterKey: "cotality:parcels",
          tier: "federal",
          layerKind: "cotality-parcel",
          sourceKind: "national-aggregator",
          provider: "Cotality",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "parcel",
            clip: "1234567890",
            parcel: {
              properties: { parcelnumb: "R12345" },
            },
          },
        },
      },
      {
        adapterKey: "cotality:zoning",
        tier: "federal",
        layerKind: "cotality-zoning",
        status: "no-coverage",
        error: {
          code: "no-coverage",
          message: "No zoning at this point",
        },
      },
      {
        adapterKey: "national:opportunity-zone",
        tier: "federal",
        layerKind: "opportunity-zone",
        status: "ok",
        result: {
          adapterKey: "national:opportunity-zone",
          tier: "federal",
          layerKind: "opportunity-zone",
          sourceKind: "federal-adapter",
          provider: "CDFI Fund / HUD (OZ tracts)",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "opportunity-zone",
            inOpportunityZone: false,
            ozRound: "oz-1.0",
          },
        },
      },
    ]);

    const ctx = await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      packageTier: "free",
    });

    expect(createAdapterResponseCacheMock).toHaveBeenCalled();
    expect(runAdaptersMock).toHaveBeenCalledOnce();
    const runInput = runAdaptersMock.mock.calls[0]?.[0];
    expect(runInput?.context?.signal).toBeDefined();
    expect(runInput?.adapters?.map((a: { adapterKey: string }) => a.adapterKey)).toEqual(
      FREE_ADAPTER_KEYS,
    );
    // The cad:* store accessor is service-injected into the adapter context.
    expect(typeof runInput?.context?.cadLookup).toBe("function");
    // 4 mocked outcomes + 4 store-backed adapters (3 cad + permits)
    // with no outcome from the mock.
    expect(ctx.layers).toHaveLength(8);
    expect(ctx.parcelClip).toBe("1234567890");

    expect(
      ctx.layers.find((l) => l.layerKind === "fema-nfhl-flood-zone")?.summary,
    ).toMatch(/Flood Zone AE/);
    expect(ctx.layers.find((l) => l.layerKind === "cotality-zoning")?.status).toBe(
      "no-coverage",
    );

    const llm = formatSiteContextForLlm(ctx);
    expect(llm).toContain("fema-nfhl-flood-zone");
    expect(llm).toContain("cotality-parcel");
    expect(llm).toContain("opportunity-zone");
  });

  it("passes a 45s abort signal budget to runAdapters", async () => {
    runAdaptersMock.mockResolvedValue([]);
    await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
    });
    expect(BROKERAGE_SITE_CONTEXT_TIMEOUT_MS).toBe(45_000);
    const signal = runAdaptersMock.mock.calls[0]?.[0]?.context?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("serves archived layers without calling runAdapters when snapshots exist", async () => {
    readPlaceLayerSnapshotMock.mockImplementation(async ({ adapterKey }) => {
      const payloads: Record<string, Record<string, unknown>> = {
        "cotality:parcels": {
          kind: "parcel",
          clip: "999",
          parcel: { properties: { parcelnumb: "ARCH-1" } },
        },
        "fema:nfhl-flood-zone": { kind: "flood-zone", floodZone: "X" },
        "cotality:zoning": {},
        "national:opportunity-zone": { inOpportunityZone: false },
        "cad:property": {
          kind: "cad-property",
          cadName: "Bastrop Central Appraisal District",
          taxYear: 2026,
          sourceVintage: "2026-preliminary",
          marketValue: 100000,
          valueBasis: "county-assessed",
        },
        "cad:tax": {
          kind: "cad-tax",
          cadName: "Bastrop Central Appraisal District",
          taxYear: 2026,
          sourceVintage: "2026-preliminary",
          assessedValue: 100000,
          exemptions: [{ code: "HS", label: "Homestead" }],
        },
        "cad:owner-occupancy": {
          kind: "cad-owner-occupancy",
          cadName: "Bastrop Central Appraisal District",
          taxYear: 2026,
          sourceVintage: "2026-preliminary",
          signal: "likely-owner-occupied",
          homesteadExemption: true,
          mailingMatchesSitus: "same",
        },
        // feat/permits-brief-slot — archived no-coverage snapshot
        // (Bastrop is outside the covered Austin/SA permit metros).
        "permits:record": {},
      };
      const payload = payloads[adapterKey];
      if (!payload) return null;
      return {
        payload,
        snapshotAt: "2026-05-01T00:00:00.000Z",
        llUuid: null,
        contentHash: "abc",
      };
    });

    const ctx = await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
    });

    expect(runAdaptersMock).not.toHaveBeenCalled();
    expect(ctx.layers.every((l) => l.fromArchive)).toBe(true);
    expect(writePlaceLayerSnapshotMock).not.toHaveBeenCalled();
    expect(ctx.layers).toHaveLength(8);
  });

  it("renders cad:* outcomes as brief layers with honest summaries and roll-vintage honesty (integration shape)", async () => {
    runAdaptersMock.mockResolvedValue([
      {
        adapterKey: "cad:property",
        tier: "local",
        layerKind: "cad-property",
        status: "ok",
        result: {
          adapterKey: "cad:property",
          tier: "local",
          layerKind: "cad-property",
          sourceKind: "local-adapter",
          provider: "Bastrop Central Appraisal District",
          snapshotDate: "2026-07-13T00:00:00.000Z",
          payload: {
            kind: "cad-property",
            cadName: "Bastrop Central Appraisal District",
            countyFips: "48021",
            countyName: "Bastrop",
            propId: "88213",
            taxYear: 2026,
            sourceVintage: "2026-preliminary-supp0",
            ownerName: "SAMPLE OWNER",
            situsAddress: "251 COOL WATER DR",
            situsCity: "BASTROP",
            yearBuilt: 2004,
            livingAreaSqft: 1850,
            landAcres: 1.02,
            propertyUseCode: "A1",
            landValue: 90000,
            improvementValue: 210000,
            marketValue: 300000,
            valueBasis: "county-assessed",
          },
        },
      },
      {
        adapterKey: "cad:tax",
        tier: "local",
        layerKind: "cad-tax",
        status: "ok",
        result: {
          adapterKey: "cad:tax",
          tier: "local",
          layerKind: "cad-tax",
          sourceKind: "local-adapter",
          provider: "Bastrop Central Appraisal District",
          snapshotDate: "2026-07-13T00:00:00.000Z",
          payload: {
            kind: "cad-tax",
            cadName: "Bastrop Central Appraisal District",
            taxYear: 2026,
            sourceVintage: "2026-preliminary-supp0",
            assessedValue: 285000,
            exemptionCodes: ["HS", "OV65"],
            exemptions: [
              { code: "HS", label: "Homestead" },
              { code: "OV65", label: "Over-65" },
            ],
            valueBasis: "county-assessed",
          },
        },
      },
      {
        adapterKey: "cad:owner-occupancy",
        tier: "local",
        layerKind: "cad-owner-occupancy",
        status: "ok",
        result: {
          adapterKey: "cad:owner-occupancy",
          tier: "local",
          layerKind: "cad-owner-occupancy",
          sourceKind: "local-adapter",
          provider: "Bastrop Central Appraisal District",
          snapshotDate: "2026-07-13T00:00:00.000Z",
          payload: {
            kind: "cad-owner-occupancy",
            cadName: "Bastrop Central Appraisal District",
            taxYear: 2026,
            sourceVintage: "2026-preliminary-supp0",
            signal: "likely-absentee",
            basis: ["no-homestead-exemption", "mailing-differs-from-situs"],
            homesteadExemption: false,
            mailingMatchesSitus: "different",
            method:
              "derived from CAD homestead exemption + mailing/situs comparison",
          },
        },
      },
    ]);

    const ctx = await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      packageTier: "free",
    });

    const property = ctx.layers.find((l) => l.layerKind === "cad-property");
    expect(property?.status).toBe("ok");
    expect(property?.provider).toBe("Bastrop Central Appraisal District");
    // HONESTY: assessed labeling, never a market estimate / AVM.
    expect(property?.summary).toContain("CAD market value (assessed): $300,000");
    expect(property?.summary).not.toMatch(/AVM|market estimate/i);
    // engineHonesty carries the CAD roll drop as the data vintage.
    expect(property?.engineHonesty?.dataVintage).toBe("2026-preliminary-supp0");
    expect(property?.readContract).toBeTruthy();

    const tax = ctx.layers.find((l) => l.layerKind === "cad-tax");
    expect(tax?.summary).toContain("CAD assessed value $285,000 (tax year 2026)");
    expect(tax?.summary).toContain("Homestead (HS), Over-65 (OV65)");

    const occ = ctx.layers.find((l) => l.layerKind === "cad-owner-occupancy");
    expect(occ?.summary).toContain("Likely absentee owner");
    expect(occ?.summary).toContain(
      "derived from CAD homestead exemption + mailing/situs comparison",
    );

    // The layers flow into the LLM context block like every other slot.
    const llm = formatSiteContextForLlm(ctx);
    expect(llm).toContain("cad-property (Bastrop Central Appraisal District)");
    expect(llm).toContain("Likely absentee owner");
  });
});

describe("stripSiteContextForClient", () => {
  const fatPayload = { geo: "x".repeat(8000) };

  it("removes layer payloads while keeping summary fields", async () => {
    const { stripSiteContextForClient, stripBriefPayloadForClient } =
      await import("../lib/brokerageSiteContext");

    const ctx = {
      placeKey: "coord:30.50000:-97.60000",
      parcelClip: "1234567890",
      layers: [
        {
          layerKind: "cotality-parcel",
          adapterKey: "cotality:parcels",
          tier: "federal",
          status: "ok" as const,
          provider: "Cotality",
          summary: "CLIP 123 · APN R123",
          payload: fatPayload,
        },
      ],
    };

    const slim = stripSiteContextForClient(ctx);
    expect(slim.layers[0]).not.toHaveProperty("payload");
    expect(slim.layers[0]?.summary).toBe("CLIP 123 · APN R123");
    expect(slim.parcelClip).toBe("1234567890");

    const brief = stripBriefPayloadForClient({
      runId: "abc",
      siteContext: ctx,
    });
    expect(
      (brief.siteContext as typeof slim).layers[0],
    ).not.toHaveProperty("payload");

    const fullBytes = Buffer.byteLength(JSON.stringify({ siteContext: ctx }), "utf8");
    const slimBytes = Buffer.byteLength(JSON.stringify({ siteContext: slim }), "utf8");
    expect(slimBytes).toBeLessThan(fullBytes * 0.05);
  });
});
