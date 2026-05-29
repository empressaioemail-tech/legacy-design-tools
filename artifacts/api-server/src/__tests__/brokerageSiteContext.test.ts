/**
 * brokerageSiteContext — FEMA + Regrid layers for Property Brief wedge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const runAdaptersMock = vi.hoisted(() => vi.fn());
const resolveJurisdictionMock = vi.hoisted(() => vi.fn());
const readPlaceLayerSnapshotMock = vi.hoisted(() => vi.fn());
const writePlaceLayerSnapshotMock = vi.hoisted(() => vi.fn());
const createAdapterResponseCacheMock = vi.hoisted(() => vi.fn());

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
  };
});

const {
  fetchBrokerageSiteContext,
  formatSiteContextForLlm,
} = await import("../lib/brokerageSiteContext");

describe("fetchBrokerageSiteContext", () => {
  beforeEach(() => {
    runAdaptersMock.mockReset();
    resolveJurisdictionMock.mockReset();
    readPlaceLayerSnapshotMock.mockReset();
    readPlaceLayerSnapshotMock.mockResolvedValue(null);
    writePlaceLayerSnapshotMock.mockReset();
    createAdapterResponseCacheMock.mockReturnValue(undefined);
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

  it("maps FEMA and Regrid adapter outcomes to siteContext.layers", async () => {
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
    expect(writePlaceLayerSnapshotMock).toHaveBeenCalledTimes(3);
    expect(ctx.layers).toHaveLength(3);
    expect(ctx.layers[0]?.layerKind).toBe("fema-nfhl-flood-zone");
    expect(ctx.layers[0]?.status).toBe("ok");
    expect(ctx.layers[0]?.summary).toMatch(/Flood Zone AE/);
    expect(ctx.layers[1]?.layerKind).toBe("regrid-parcel");
    expect(ctx.layers[1]?.summary).toMatch(/ac/);
    expect(ctx.layers[2]?.status).toBe("no-coverage");

    const llm = formatSiteContextForLlm(ctx);
    expect(llm).toContain("fema-nfhl-flood-zone");
    expect(llm).toContain("regrid-parcel");
    expect(llm).not.toContain("regrid-zoning");
  });

  it("serves archived layers without calling runAdapters when snapshots exist", async () => {
    const archivedPayload = {
      kind: "parcel",
      parcel: {
        properties: { fields: { parcelnumb: "ARCH-1", ll_gisacre: 1.0 } },
      },
    };
    readPlaceLayerSnapshotMock.mockImplementation(async ({ adapterKey }) => {
      if (adapterKey === "regrid:parcels") {
        return {
          payload: archivedPayload,
          snapshotAt: "2026-05-01T00:00:00.000Z",
          llUuid: null,
          contentHash: "abc",
        };
      }
      if (adapterKey === "fema:nfhl-flood-zone") {
        return {
          payload: { kind: "flood-zone", floodZone: "X" },
          snapshotAt: "2026-05-01T00:00:00.000Z",
          llUuid: null,
          contentHash: "def",
        };
      }
      if (adapterKey === "regrid:zoning") {
        return {
          payload: {},
          snapshotAt: "2026-05-01T00:00:00.000Z",
          llUuid: null,
          contentHash: "ghi",
        };
      }
      return null;
    });

    const ctx = await fetchBrokerageSiteContext({
      latitude: 30.11,
      longitude: -97.32,
      address: "251 Cool Water Dr, Bastrop, TX 78602",
    });

    expect(runAdaptersMock).not.toHaveBeenCalled();
    expect(ctx.layers.every((l) => l.fromArchive)).toBe(true);
    expect(writePlaceLayerSnapshotMock).not.toHaveBeenCalled();
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

    expect(writePlaceLayerSnapshotMock).toHaveBeenCalledTimes(3);
    const zoningWrite = writePlaceLayerSnapshotMock.mock.calls.find(
      (c) => c[0]?.adapterKey === "regrid:zoning",
    );
    expect(zoningWrite?.[0]?.result.payload).toEqual({});
  });
});
