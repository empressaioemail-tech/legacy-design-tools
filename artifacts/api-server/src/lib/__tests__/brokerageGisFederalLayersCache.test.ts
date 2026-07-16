import { describe, expect, it, vi, beforeEach } from "vitest";

// Fully mock the cache module so the real one (which imports @workspace/db
// and throws without DATABASE_URL) never loads under vitest. This mirrors
// brokerageGisLayers.test.ts, which mocks the same module for the same
// reason. The in-memory Map stands in for cotality_spatial_tile_cache so a
// cache-hit can be asserted without a live DB, and a self-contained tileKey
// reproduces the real per-(layer,bbox) key namespacing.
const store = new Map<
  string,
  { payload: unknown; featureCount: number; cachedAt: Date }
>();

// Stand-in matching brokerageGisCache.tileKey's contract: a stable,
// layer-namespaced, snapped-bbox key. Grid + precision mirror the real
// helper so the namespacing assertion is meaningful.
function fakeTileKey(
  layer: string,
  bbox: {
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  },
  gridDeg = 0.02,
): string {
  const snap = (v: number) => (Math.floor(v / gridDeg) * gridDeg).toFixed(5);
  return `${layer}:g${gridDeg}:${snap(bbox.westLng)},${snap(bbox.southLat)},${snap(bbox.eastLng)},${snap(bbox.northLat)}`;
}

vi.mock("../brokerageGisCache", () => ({
  tileKey: vi.fn(fakeTileKey),
  getSpatialTile: vi.fn(async (key: string) => store.get(key) ?? null),
  putSpatialTile: vi.fn(
    async (key: string, payload: unknown, featureCount: number) => {
      store.set(key, { payload, featureCount, cachedAt: new Date() });
    },
  ),
}));

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
    const { queryFederalGisLayerGeoJson, listFederalGisLayerEndpoints } =
      await import("../brokerageGisFederalLayers");

    await queryFederalGisLayerGeoJson({ layer: "groundwater", bbox: GW_BBOX });

    const meta = listFederalGisLayerEndpoints();
    const gwKey = fakeTileKey(
      meta.find((l) => l.layer === "groundwater")!.adapterKey!,
      GW_BBOX,
    );
    const soilKey = fakeTileKey(
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
