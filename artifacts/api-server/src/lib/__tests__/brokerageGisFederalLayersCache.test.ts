import { describe, expect, it, vi, beforeEach } from "vitest";

// In-memory stand-in for the persistent spatial-tile cache, so a cache-hit
// can be asserted without a live DB. tileKey stays real (the real key
// derivation is what namespaces federal rows), only the get/put persistence
// is swapped for a Map. Mirrors the mock discipline in
// brokerageGisLayers.test.ts, which mocks the same module.
const store = new Map<
  string,
  { payload: unknown; featureCount: number; cachedAt: Date }
>();

vi.mock("../brokerageGisCache", async () => {
  const actual = await vi.importActual<
    typeof import("../brokerageGisCache")
  >("../brokerageGisCache");
  return {
    ...actual,
    getSpatialTile: vi.fn(async (key: string) => store.get(key) ?? null),
    putSpatialTile: vi.fn(
      async (key: string, payload: unknown, featureCount: number) => {
        store.set(key, { payload, featureCount, cachedAt: new Date() });
      },
    ),
  };
});

const GW_BBOX = {
  westLng: -97.4,
  southLat: 30.0,
  eastLng: -97.2,
  northLat: 30.2,
};

// A single NWIS RDB site row. Reused across calls so we can prove the
// second call is served from cache (no additional upstream fetch).
const NWIS_RDB = `#
#
agency_cd\tsite_no\tstation_nm\tsite_tp_cd\tdec_lat_va\tdec_long_va
5s\t15s\t50s\t7s\t16s\t16s
USGS\t293801097320001\tTest GW\tGW\t30.1105\t-97.3186
`;

function stubNwisFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () =>
    new Response(NWIS_RDB, {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("queryFederalGisLayerGeoJson read-through cache", () => {
  beforeEach(() => {
    store.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("fetches upstream on a miss, then serves the second identical request from cache (zero extra upstream calls)", async () => {
    const fetchMock = stubNwisFetch();
    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );

    const first = await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: GW_BBOX,
    });
    expect(first.featureCount).toBe(1);
    const upstreamAfterFirst = fetchMock.mock.calls.length;
    expect(upstreamAfterFirst).toBeGreaterThan(0);

    // Same bbox again -> must hit the cache -> no new upstream fetch.
    const second = await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: GW_BBOX,
    });
    expect(second.featureCount).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(upstreamAfterFirst);

    // The cached result reconstructs the full FederalGisLayerResult shape,
    // including the endpoint metadata, not just the raw geojson.
    expect(second.geojson.type).toBe("FeatureCollection");
    expect(second.provider).toBe(first.provider);
    expect(second.adapterKey).toBe(first.adapterKey);
    expect(second.queryMode).toBe("bbox");
  });

  it("forceRefresh bypasses a cached entry and re-fetches upstream", async () => {
    const fetchMock = stubNwisFetch();
    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );

    await queryFederalGisLayerGeoJson({ layer: "groundwater", bbox: GW_BBOX });
    const afterWarm = fetchMock.mock.calls.length;
    expect(afterWarm).toBeGreaterThan(0);

    await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: GW_BBOX,
      forceRefresh: true,
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterWarm);
  });

  it("namespaces the cache per layer — a groundwater entry is never served for a different layer key", async () => {
    stubNwisFetch();
    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );
    const { tileKey } = await import("../brokerageGisCache");
    const {
      listFederalGisLayerEndpoints,
    } = await import("../brokerageGisFederalLayers");

    await queryFederalGisLayerGeoJson({ layer: "groundwater", bbox: GW_BBOX });

    const meta = listFederalGisLayerEndpoints();
    const gwKey = tileKey(
      meta.find((l) => l.layer === "groundwater")!.adapterKey!,
      GW_BBOX,
    );
    const soilKey = tileKey(
      meta.find((l) => l.layer === "ssurgo-soils")!.adapterKey!,
      GW_BBOX,
    );
    expect(store.has(gwKey)).toBe(true);
    expect(store.has(soilKey)).toBe(false);
    expect(gwKey).not.toBe(soilKey);
  });

  it("degrades to a live fetch when the cache always misses (helper-level failure isolation)", async () => {
    // The failure-isolation contract lives in the cache helpers: a DB error
    // makes getSpatialTile return null (never throw) and putSpatialTile
    // no-op. From the caller's side that is indistinguishable from a cold
    // cache. Model that here by forcing the cache to always miss and never
    // persist, then prove every request still returns correct live data —
    // the request path never depends on the cache succeeding.
    const fetchMock = stubNwisFetch();
    const cacheMod = await import("../brokerageGisCache");
    vi.mocked(cacheMod.getSpatialTile).mockResolvedValue(null);
    vi.mocked(cacheMod.putSpatialTile).mockResolvedValue(undefined);

    const { queryFederalGisLayerGeoJson } = await import(
      "../brokerageGisFederalLayers"
    );

    const a = await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: GW_BBOX,
    });
    const b = await queryFederalGisLayerGeoJson({
      layer: "groundwater",
      bbox: GW_BBOX,
    });
    expect(a.featureCount).toBe(1);
    expect(b.featureCount).toBe(1);
    // Cache never serves -> both requests fetch upstream, and neither throws.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
