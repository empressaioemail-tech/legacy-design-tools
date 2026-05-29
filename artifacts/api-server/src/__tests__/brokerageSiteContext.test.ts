/**
 * brokerageSiteContext — federal environmental + Regrid layers for Property Brief.
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

const DEFAULT_ADAPTER_KEYS = [
  "fema:nfhl-flood-zone",
  "usgs:ned-elevation",
  "epa:ejscreen",
  "regrid:parcels",
  "regrid:zoning",
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

  it("maps FEMA, USGS, EPA, and Regrid adapter outcomes to siteContext.layers", async () => {
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
        adapterKey: "usgs:ned-elevation",
        tier: "federal",
        layerKind: "usgs-ned-elevation",
        status: "ok",
        result: {
          adapterKey: "usgs:ned-elevation",
          tier: "federal",
          layerKind: "usgs-ned-elevation",
          sourceKind: "federal-adapter",
          provider: "USGS National Elevation Dataset (3DEP)",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "elevation-point",
            elevationFeet: 512,
            units: "Feet",
          },
        },
      },
      {
        adapterKey: "epa:ejscreen",
        tier: "federal",
        layerKind: "epa-ejscreen-blockgroup",
        status: "ok",
        result: {
          adapterKey: "epa:ejscreen",
          tier: "federal",
          layerKind: "epa-ejscreen-blockgroup",
          sourceKind: "federal-adapter",
          provider: "EJScreen 2023 — CalEPA mirror",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "ejscreen-blockgroup",
            demographicIndexPercentile: 65,
            pm25Percentile: 72,
          },
        },
      },
      {
        adapterKey: "regrid:parcels",
        tier: "federal",
        layerKind: "regrid-parcel",
        status: "ok",
        result: {
          adapterKey: "regrid:parcels",
          tier: "federal",
          layerKind: "regrid-parcel",
          sourceKind: "national-aggregator",
          provider: "Regrid",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "parcel",
            parcel: {
              properties: { fields: { parcelnumb: "R12345", ll_gisacre: 0.42 } },
            },
          },
        },
      },
      {
        adapterKey: "regrid:zoning",
        tier: "federal",
        layerKind: "regrid-zoning",
        status: "no-coverage",
        error: {
          code: "no-coverage",
          message: "No zoning at this point",
        },
      },
    ]);

    const ctx = await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
    });

    expect(createAdapterResponseCacheMock).toHaveBeenCalled();
    expect(runAdaptersMock).toHaveBeenCalledOnce();
    const runInput = runAdaptersMock.mock.calls[0]?.[0];
    expect(runInput?.context?.signal).toBeDefined();
    expect(runInput?.adapters?.map((a: { adapterKey: string }) => a.adapterKey)).toEqual(
      DEFAULT_ADAPTER_KEYS,
    );
    expect(writePlaceLayerSnapshotMock).toHaveBeenCalledTimes(5);
    expect(ctx.layers).toHaveLength(5);

    const federalBeyondFemaRegrid = ctx.layers.filter(
      (l) =>
        l.status === "ok" &&
        !l.layerKind.startsWith("regrid-") &&
        l.layerKind !== "fema-nfhl-flood-zone",
    );
    expect(federalBeyondFemaRegrid.length).toBeGreaterThanOrEqual(2);

    expect(
      ctx.layers.find((l) => l.layerKind === "fema-nfhl-flood-zone")?.summary,
    ).toMatch(/Flood Zone AE/);
    expect(ctx.layers.find((l) => l.layerKind === "usgs-ned-elevation")?.summary).toMatch(
      /512/,
    );
    expect(ctx.layers.find((l) => l.layerKind === "regrid-zoning")?.status).toBe(
      "no-coverage",
    );

    const llm = formatSiteContextForLlm(ctx);
    expect(llm).toContain("fema-nfhl-flood-zone");
    expect(llm).toContain("usgs-ned-elevation");
    expect(llm).toContain("epa-ejscreen-blockgroup");
    expect(llm).toContain("regrid-parcel");
    expect(llm).not.toContain("regrid-zoning");
  });

  it("passes a 30s abort signal budget to runAdapters", async () => {
    runAdaptersMock.mockResolvedValue([]);
    await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
    });
    expect(BROKERAGE_SITE_CONTEXT_TIMEOUT_MS).toBe(30_000);
    const signal = runAdaptersMock.mock.calls[0]?.[0]?.context?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("serves archived layers without calling runAdapters when snapshots exist", async () => {
    readPlaceLayerSnapshotMock.mockImplementation(async ({ adapterKey }) => {
      const payloads: Record<string, Record<string, unknown>> = {
        "regrid:parcels": {
          kind: "parcel",
          parcel: {
            properties: { fields: { parcelnumb: "ARCH-1", ll_gisacre: 1.0 } },
          },
        },
        "fema:nfhl-flood-zone": { kind: "flood-zone", floodZone: "X" },
        "usgs:ned-elevation": {
          kind: "elevation-point",
          elevationFeet: 400,
          units: "Feet",
        },
        "epa:ejscreen": {
          kind: "ejscreen-blockgroup",
          demographicIndexPercentile: 50,
        },
        "regrid:zoning": {},
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
    expect(ctx.layers).toHaveLength(5);
  });

  it("archives no-coverage adapter outcomes so repeat fetches skip live calls", async () => {
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
          payload: { kind: "flood-zone", floodZone: "X" },
        },
      },
      {
        adapterKey: "usgs:ned-elevation",
        tier: "federal",
        layerKind: "usgs-ned-elevation",
        status: "ok",
        result: {
          adapterKey: "usgs:ned-elevation",
          tier: "federal",
          layerKind: "usgs-ned-elevation",
          sourceKind: "federal-adapter",
          provider: "USGS",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: { kind: "elevation-point", elevationFeet: 100, units: "Feet" },
        },
      },
      {
        adapterKey: "epa:ejscreen",
        tier: "federal",
        layerKind: "epa-ejscreen-blockgroup",
        status: "ok",
        result: {
          adapterKey: "epa:ejscreen",
          tier: "federal",
          layerKind: "epa-ejscreen-blockgroup",
          sourceKind: "federal-adapter",
          provider: "EPA",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: { kind: "ejscreen-blockgroup", demographicIndexPercentile: 40 },
        },
      },
      {
        adapterKey: "regrid:parcels",
        tier: "federal",
        layerKind: "regrid-parcel",
        status: "ok",
        result: {
          adapterKey: "regrid:parcels",
          tier: "federal",
          layerKind: "regrid-parcel",
          sourceKind: "national-aggregator",
          provider: "Regrid",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: {
            kind: "parcel",
            parcel: { properties: { fields: { parcelnumb: "R1" } } },
          },
        },
      },
      {
        adapterKey: "regrid:zoning",
        tier: "federal",
        layerKind: "regrid-zoning",
        status: "no-coverage",
        error: { code: "no-coverage", message: "none" },
      },
    ]);

    await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
    });

    expect(writePlaceLayerSnapshotMock).toHaveBeenCalledTimes(5);
    const zoningWrite = writePlaceLayerSnapshotMock.mock.calls.find(
      (c) => c[0]?.adapterKey === "regrid:zoning",
    );
    expect(zoningWrite?.[0]?.result.payload).toEqual({});
  });

  it("includes TCEQ Edwards adapter when TCEQ_EDWARDS_ENABLED", async () => {
    isTceqEdwardsEnabledMock.mockReturnValue(true);
    runAdaptersMock.mockResolvedValue([]);

    await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      jurisdictionState: "TX",
    });

    const keys = runAdaptersMock.mock.calls[0]?.[0]?.adapters?.map(
      (a: { adapterKey: string }) => a.adapterKey,
    );
    expect(keys).toContain("tceq:edwards-aquifer");
    expect(keys).toHaveLength(6);
  });
});

describe("stripSiteContextForClient", () => {
  const fatPayload = { geo: "x".repeat(8000) };

  it("removes layer payloads while keeping summary fields", async () => {
    const { stripSiteContextForClient, stripBriefPayloadForClient } =
      await import("../lib/brokerageSiteContext");

    const ctx = {
      placeKey: "coord:30.50000:-97.60000",
      layers: [
        {
          layerKind: "regrid-parcel",
          adapterKey: "regrid:parcels",
          tier: "national",
          status: "ok" as const,
          provider: "regrid",
          summary: "APN R123 · 0.25 ac",
          payload: fatPayload,
        },
      ],
    };

    const slim = stripSiteContextForClient(ctx);
    expect(slim.layers[0]).not.toHaveProperty("payload");
    expect(slim.layers[0]?.summary).toBe("APN R123 · 0.25 ac");
    expect(slim.layers[0]?.provider).toBe("regrid");

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
