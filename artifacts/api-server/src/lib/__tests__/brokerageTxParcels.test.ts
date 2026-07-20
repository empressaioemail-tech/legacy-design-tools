/**
 * Central TX county-GIS parcels provider tests.
 *
 * No live county service is hit: upstream responses are the committed
 * real-probe fixtures in `__fixtures__/txCountyParcels.ts` served through
 * a stubbed global fetch. The gis cache (drizzle-backed) is mocked.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../brokerageGisCache", () => ({
  tileKey: vi.fn(
    (layer: string, bbox: Record<string, number>) =>
      `${layer}:${bbox.westLng},${bbox.southLat},${bbox.eastLng},${bbox.northLat}`,
  ),
  normalizeAddrKey: vi.fn(),
  getSpatialTile: vi.fn(async () => null),
  putSpatialTile: vi.fn(async () => {}),
  getPropertyAttr: vi.fn(async () => null),
  putPropertyAttr: vi.fn(async () => {}),
  getGeocodeClip: vi.fn(async () => null),
  putGeocodeClip: vi.fn(async () => {}),
  getTxParcelTile: vi.fn(async () => null),
  putTxParcelTile: vi.fn(async () => {}),
}));

// Store-backed counties (Hays/Comal) delegate to the txgio_parcel
// store reader — mocked here (the integration suite covers the real
// drizzle reader over real geometry). The disclaimer/url constants
// stay real.
vi.mock("../txgioParcelStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../txgioParcelStore")>();
  return { ...actual, queryTxgioParcelsGeoJson: vi.fn() };
});

import { AdapterRunError } from "@workspace/adapters/types";
import {
  TX_PARCEL_COUNTIES,
  TX_PARCEL_FEATURE_CAP,
  TX_COUNTY_PARCEL_DISCLAIMER,
  txParcelProviderMode,
  resolveTxParcelCounty,
  queryTxCountyParcelsGeoJson,
  txCountyAdapterKey,
  txCountyDisclaimer,
  txCountyProviderLabel,
  type TxParcelCounty,
} from "../brokerageTxParcels";
import { queryGisLayerGeoJson } from "../brokerageGisLayers";
import { getTxParcelTile, putTxParcelTile } from "../brokerageGisCache";
import {
  queryTxgioParcelsGeoJson,
  TXGIO_PARCEL_DISCLAIMER,
} from "../txgioParcelStore";
import { TX_COUNTY_PARCEL_FIXTURES } from "./__fixtures__/txCountyParcels";

function countyByName(name: string): TxParcelCounty {
  const county = TX_PARCEL_COUNTIES.find((c) => c.name === name);
  if (!county) throw new Error(`no county fixture: ${name}`);
  return county;
}

/** Small bbox fully inside the given city, WGS84. */
const BBOXES = {
  austin: { westLng: -97.745, southLat: 30.265, eastLng: -97.74, northLat: 30.268 },
  roundRock: { westLng: -97.68, southLat: 30.505, eastLng: -97.675, northLat: 30.508 },
  sanAntonio: { westLng: -98.495, southLat: 29.424, eastLng: -98.49, northLat: 29.427 },
  bastrop: { westLng: -97.32, southLat: 30.105, eastLng: -97.315, northLat: 30.108 },
  lockhart: { westLng: -97.675, southLat: 29.884, eastLng: -97.67, northLat: 29.887 },
  moabUt: { westLng: -109.56, southLat: 38.56, eastLng: -109.54, northLat: 38.58 },
} as const;

function fixtureFetchFor(fixture: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(fixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv.TX_PARCEL_PROVIDER = process.env.TX_PARCEL_PROVIDER;
  savedEnv.COTALITY_SPATIALTILE_KEY = process.env.COTALITY_SPATIALTILE_KEY;
  savedEnv.COTALITY_SPATIALTILE_SECRET = process.env.COTALITY_SPATIALTILE_SECRET;
  delete process.env.TX_PARCEL_PROVIDER;
  vi.clearAllMocks();
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe("txParcelProviderMode", () => {
  it("defaults to county-gis", () => {
    expect(txParcelProviderMode(undefined)).toBe("county-gis");
    expect(txParcelProviderMode("")).toBe("county-gis");
  });

  it("off disables (case/whitespace-insensitive)", () => {
    expect(txParcelProviderMode("off")).toBe("off");
    expect(txParcelProviderMode(" OFF ")).toBe("off");
  });

  it("unknown values fall back to county-gis", () => {
    expect(txParcelProviderMode("cotality")).toBe("county-gis");
  });
});

describe("resolveTxParcelCounty", () => {
  it("resolves downtown Austin bbox to Travis (now store-backed, F4h)", () => {
    const c = resolveTxParcelCounty({ bbox: BBOXES.austin });
    expect(c?.fips).toBe("48453");
    expect(c?.source).toBe("txgio-store");
  });

  it("resolves Round Rock to Williamson (store-backed) despite Travis bbox overlap (nearest centroid)", () => {
    const c = resolveTxParcelCounty({ bbox: BBOXES.roundRock });
    expect(c?.fips).toBe("48491");
    expect(c?.source).toBe("txgio-store");
  });

  it("resolves a San Antonio pin to Bexar", () => {
    expect(
      resolveTxParcelCounty({ latitude: 29.4254, longitude: -98.4925 })?.fips,
    ).toBe("48029");
  });

  it("resolves Bastrop city bbox to Bastrop", () => {
    expect(resolveTxParcelCounty({ bbox: BBOXES.bastrop })?.fips).toBe("48021");
  });

  it("resolves a Lockhart pin to Caldwell", () => {
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.fips,
    ).toBe("48055");
  });

  it("returns null outside the supported counties (out of state)", () => {
    expect(resolveTxParcelCounty({ bbox: BBOXES.moabUt })).toBeNull();
  });

  it("returns null with neither bbox nor pin", () => {
    expect(resolveTxParcelCounty({})).toBeNull();
  });
});

describe("F4h: Travis/Williamson flipped to the TxGIO store", () => {
  function county(fips: string): TxParcelCounty {
    const c = TX_PARCEL_COUNTIES.find((x) => x.fips === fips);
    if (!c) throw new Error(`no county ${fips}`);
    return c;
  }

  it("Travis (48453) is a store entry pointing at the StratMap resource, no arcgis fields", () => {
    const t = county("48453");
    expect(t.source).toBe("txgio-store");
    expect(t.serviceUrl).toContain(
      "data.geographic.texas.gov",
    );
    expect(t.serviceUrl).toContain("stratmap25-landparcels_48453_lp.zip");
    // Store entries carry no live-ArcGIS field-mapping (identity normalizer,
    // no rawPropId — the store stamps parcel_node_id from its own prop_id).
    expect(t.rawPropId).toBeUndefined();
    const passthrough = { anything: 1 };
    expect(t.normalizeProps(passthrough)).toBe(passthrough);
    // Store label + adapter key + disclaimer.
    expect(txCountyProviderLabel(t)).toBe(
      "Travis County parcels (TxGIO/StratMap)",
    );
    expect(txCountyAdapterKey(t)).toBe("txgio:parcels:48453");
    expect(txCountyDisclaimer(t)).toBe(TXGIO_PARCEL_DISCLAIMER);
  });

  it("Williamson (48491) is a store entry pointing at the StratMap resource, no arcgis fields", () => {
    const w = county("48491");
    expect(w.source).toBe("txgio-store");
    expect(w.serviceUrl).toContain("stratmap25-landparcels_48491_lp.zip");
    expect(w.rawPropId).toBeUndefined();
    expect(txCountyProviderLabel(w)).toBe(
      "Williamson County parcels (TxGIO/StratMap)",
    );
    expect(txCountyAdapterKey(w)).toBe("txgio:parcels:48491");
  });

  it("downtown Austin resolves to Travis via the store", () => {
    // ~30.27, -97.74 (downtown), interior Travis.
    const c = resolveTxParcelCounty({ latitude: 30.27, longitude: -97.74 });
    expect(c?.fips).toBe("48453");
    expect(c?.source).toBe("txgio-store");
  });

  it("Georgetown resolves to Williamson via the store", () => {
    // ~30.63, -97.68 (Georgetown), interior Williamson near the mass centroid.
    const c = resolveTxParcelCounty({ latitude: 30.63, longitude: -97.68 });
    expect(c?.fips).toBe("48491");
    expect(c?.source).toBe("txgio-store");
  });

  it("interior in-county bboxes route correctly (both directions across the shared border)", () => {
    // A Travis bbox just SOUTH of the Travis/Williamson line -> Travis.
    expect(
      resolveTxParcelCounty({
        bbox: { westLng: -97.72, southLat: 30.30, eastLng: -97.70, northLat: 30.32 },
      })?.fips,
    ).toBe("48453");
    // A Williamson bbox just NORTH of the line (Round Rock) -> Williamson.
    expect(resolveTxParcelCounty({ bbox: BBOXES.roundRock })?.fips).toBe("48491");
  });

  it("KNOWN EDGE (documented sliver): SW-Travis near the Hays line routes to the Hays store under nearest-centroid", () => {
    // Real Travis parcel center (11412 ESPERANZA DR, 78739): 30.17047,
    // -97.87057. Travis' parcel mass centroid sits far east (dense east
    // Austin), so this SW-Austin point is closer to Hays' centroid and
    // nearest-centroid pre-routing hands the bbox tile-fetch to the Hays
    // store. That NEVER returns a wrong parcel: the Hays store filters by
    // county_fips=48209 and has no Travis rows, so the query is an honest
    // no-coverage. For ADDRESS resolution the multi-county situs pre-pass
    // (storeCountiesContainingPoint) still includes Travis, so a
    // situs-bearing border address resolves regardless of centroid distance;
    // Travis' mostly-blank situs rides the rooftop path instead. This is the
    // known bbox+centroid limit at a straddle (~7.5% of sampled Travis
    // parcels, all along the SW/W edge). If a later change adds point-in-
    // polygon pre-resolution, flip this expectation to "48453".
    expect(
      resolveTxParcelCounty({ latitude: 30.17047, longitude: -97.87057 })?.fips,
    ).toBe("48209");
    // The same point IS contained by Travis' routing bbox, so the situs
    // multi-county candidate set (all store counties containing the point)
    // includes Travis — the recovery path for a situs-bearing address.
    const t = TX_PARCEL_COUNTIES.find((c) => c.fips === "48453")!;
    const inTravisBbox =
      -97.87057 >= t.bbox.westLng &&
      -97.87057 <= t.bbox.eastLng &&
      30.17047 >= t.bbox.southLat &&
      30.17047 <= t.bbox.northLat;
    expect(inTravisBbox).toBe(true);
  });

  it("REGRESSION: Bexar/Bastrop/Caldwell stay live-ArcGIS; Hays/Comal unchanged", () => {
    expect(resolveTxParcelCounty({ bbox: BBOXES.sanAntonio })?.source).toBeUndefined();
    expect(resolveTxParcelCounty({ bbox: BBOXES.bastrop })?.source).toBeUndefined();
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.source,
    ).toBeUndefined();
    // Hays / Comal cores still resolve to their store entries.
    expect(
      resolveTxParcelCounty({ latitude: 29.88, longitude: -97.94 })?.fips,
    ).toBe("48209");
  });
});

describe("gap counties routed to the TxGIO store (Bell/McLennan/Guadalupe)", () => {
  // Interior pins well inside each county's real staging geometry bounds.
  it("routes a Temple/Belton pin to Bell via the store", () => {
    const c = resolveTxParcelCounty({ latitude: 31.06, longitude: -97.46 });
    expect(c?.fips).toBe("48027");
    expect(c?.source).toBe("txgio-store");
  });

  it("routes a Waco pin to McLennan via the store", () => {
    const c = resolveTxParcelCounty({ latitude: 31.549, longitude: -97.147 });
    expect(c?.fips).toBe("48309");
    expect(c?.source).toBe("txgio-store");
  });

  it("routes a Seguin pin to Guadalupe via the store", () => {
    const c = resolveTxParcelCounty({ latitude: 29.568, longitude: -97.964 });
    expect(c?.fips).toBe("48187");
    expect(c?.source).toBe("txgio-store");
  });

  it("also resolves a small in-county bbox for each", () => {
    expect(
      resolveTxParcelCounty({
        bbox: { westLng: -97.47, southLat: 31.05, eastLng: -97.45, northLat: 31.07 },
      })?.fips,
    ).toBe("48027");
    expect(
      resolveTxParcelCounty({
        bbox: { westLng: -97.15, southLat: 31.54, eastLng: -97.13, northLat: 31.56 },
      })?.fips,
    ).toBe("48309");
    expect(
      resolveTxParcelCounty({
        bbox: { westLng: -97.97, southLat: 29.56, eastLng: -97.95, northLat: 29.58 },
      })?.fips,
    ).toBe("48187");
  });

  it("REGRESSION: metro routing is unchanged by the gap-county bboxes", () => {
    // Bexar/Bastrop/Caldwell stay on their live-ArcGIS entries.
    expect(resolveTxParcelCounty({ bbox: BBOXES.sanAntonio })?.source).toBeUndefined();
    expect(resolveTxParcelCounty({ bbox: BBOXES.sanAntonio })?.fips).toBe("48029");
    expect(resolveTxParcelCounty({ bbox: BBOXES.bastrop })?.source).toBeUndefined();
    expect(resolveTxParcelCounty({ bbox: BBOXES.bastrop })?.fips).toBe("48021");
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.source,
    ).toBeUndefined();
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.fips,
    ).toBe("48055");
    // Travis/Williamson are now store-backed (F4h) but still route to the
    // right county from an in-county bbox.
    expect(resolveTxParcelCounty({ bbox: BBOXES.austin })?.fips).toBe("48453");
    expect(resolveTxParcelCounty({ bbox: BBOXES.roundRock })?.fips).toBe("48491");
  });
});

describe("per-county attribute normalization (real probed fixtures)", () => {
  // Travis + Williamson attribute-normalization tests were removed in F4h:
  // both are now source: "txgio-store", so queryTxCountyParcelsGeoJson
  // delegates to the txgio_parcel store reader (mocked here / covered by the
  // integration suite) and no longer runs the live-ArcGIS normalizeProps
  // path. The store-side feature shape (apn/situs/owner/landUse via the
  // cad_property join) is exercised in the txgioParcelStore + f4e integration
  // suites. Bexar/Bastrop/Caldwell below still cover the live-ArcGIS
  // normalizers.
  it("Bexar: apn/situs/owner/land-use code; 'NULL' string sentinels dropped", async () => {
    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bexar"),
      bbox: BBOXES.sanAntonio,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bexar),
    });
    const props = (result.geojson.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect(props.apn).toBe("101650");
    expect(props.situsAddress).toBe("510 W MARKET ST");
    expect(props.owner).toBe("CITY OF SAN ANTONIO");
    expect(props.landUseCode).toBe("5000");
    expect(props.landUseDescription).toBeUndefined();
    expect(props.countyFips).toBe("48029");
  });

  it("Bastrop: apn/owner from prop_id/file_as_name; situs omitted when county has none", async () => {
    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bastrop),
    });
    const props = (result.geojson.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect(props.apn).toBe("8741600");
    expect(props.owner).toBe("BARE MIN LAND LLC");
    // This real parcel has null situs_num/situs_street — key must be absent.
    expect(props.situsAddress).toBeUndefined();
    expect(props.countyFips).toBe("48021");
  });

  it("Caldwell: geometry + apn only, marked attributesDegraded", async () => {
    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Caldwell"),
      bbox: BBOXES.lockhart,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.caldwell),
    });
    const props = (result.geojson.features[0] as { properties: Record<string, unknown> })
      .properties;
    expect(props.apn).toBe("17025");
    expect(props.owner).toBeUndefined();
    expect(props.situsAddress).toBeUndefined();
    expect(props.attributesDegraded).toBe(true);
    expect(props.countyFips).toBe("48055");
  });

  it("throws no-coverage when the county returns zero features", async () => {
    // Bexar is still live-ArcGIS (Travis was flipped to the store in F4h).
    await expect(
      queryTxCountyParcelsGeoJson({
        county: countyByName("Bexar"),
        bbox: BBOXES.sanAntonio,
        fetchImpl: fixtureFetchFor({ type: "FeatureCollection", features: [] }),
      }),
    ).rejects.toMatchObject({ code: "no-coverage" });
  });

  it("propagates a county upstream failure as a named AdapterRunError (no Cotality fallthrough)", async () => {
    const failFetch = vi.fn(async () =>
      new Response("Service unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    const err = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bexar"),
      bbox: BBOXES.sanAntonio,
      fetchImpl: failFetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterRunError);
    expect(String((err as Error).message)).toContain("Bexar County GIS parcels");
  });
});

describe("truncation at the Cotality-parity cap", () => {
  it("caps merged pages at TX_PARCEL_FEATURE_CAP and flags truncated", async () => {
    // Bexar is still live-ArcGIS (Travis was flipped to the store in F4h;
    // the store path has its own cap/truncation test in the txgio suite).
    const template = TX_COUNTY_PARCEL_FIXTURES.bexar.features[0];
    const page = {
      type: "FeatureCollection",
      exceededTransferLimit: true,
      features: Array.from({ length: 50 }, (_, i) => ({
        type: "Feature",
        geometry: template.geometry,
        properties: { ...template.properties, PropID: 100000 + i },
      })),
    };
    const pagedFetch = vi.fn(async () =>
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bexar"),
      bbox: BBOXES.sanAntonio,
      fetchImpl: pagedFetch,
    });
    expect(result.featureCount).toBe(TX_PARCEL_FEATURE_CAP);
    expect(result.truncated).toBe(true);
    // 4 pages of 50 = the 200 cap; a 5th page is never requested.
    expect(vi.mocked(pagedFetch).mock.calls.length).toBe(4);
  });
});

describe("tile cache read-through", () => {
  it("serves from tx_parcel_tile_cache without fetching upstream", async () => {
    const cachedPayload = {
      geojson: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: null, properties: { apn: "cached" } }],
      },
      featureCount: 1,
      queryMode: "bbox" as const,
    };
    vi.mocked(getTxParcelTile).mockResolvedValueOnce({
      payload: cachedPayload,
      featureCount: 1,
      cachedAt: new Date(),
    });
    const upstreamFetch = vi.fn() as unknown as typeof fetch;

    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
      fetchImpl: upstreamFetch,
    });
    expect(result.featureCount).toBe(1);
    expect(vi.mocked(upstreamFetch)).not.toHaveBeenCalled();
    expect(vi.mocked(putTxParcelTile)).not.toHaveBeenCalled();
  });

  it("on a miss, fetches upstream and writes the tile keyed by county fips", async () => {
    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bastrop),
    });
    expect(result.featureCount).toBe(2);
    expect(vi.mocked(putTxParcelTile)).toHaveBeenCalledTimes(1);
    const [key, fips, payload, count] = vi.mocked(putTxParcelTile).mock.calls[0];
    expect(String(key)).toContain("parcels:");
    expect(fips).toBe("48021");
    expect((payload as { featureCount: number }).featureCount).toBe(2);
    expect(count).toBe(2);
  });

  it("forceRefresh skips the cache read", async () => {
    await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
      forceRefresh: true,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bastrop),
    });
    expect(vi.mocked(getTxParcelTile)).not.toHaveBeenCalled();
    expect(vi.mocked(putTxParcelTile)).toHaveBeenCalledTimes(1);
  });

  it("pin queries are uncached (mirrors the Cotality path)", async () => {
    // Bexar is still live-ArcGIS (Travis was flipped to the store in F4h).
    await queryTxCountyParcelsGeoJson({
      county: countyByName("Bexar"),
      latitude: 29.4254,
      longitude: -98.4925,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bexar),
    });
    expect(vi.mocked(getTxParcelTile)).not.toHaveBeenCalled();
    expect(vi.mocked(putTxParcelTile)).not.toHaveBeenCalled();
  });
});

describe("dispatcher routing (queryGisLayerGeoJson parcels branch)", () => {
  it("serves an in-county live-ArcGIS bbox (Bexar) from the county provider with the honesty envelope", async () => {
    // Travis was flipped to the store in F4h, so the live-ArcGIS dispatcher
    // path is now exercised via Bexar (still a live county service). The
    // store-backed Travis/Williamson dispatch is covered by the Hays store
    // dispatcher test below.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("maps.bexar.org")) {
          return new Response(JSON.stringify(TX_COUNTY_PARCEL_FIXTURES.bexar), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await queryGisLayerGeoJson({
      layer: "parcels",
      bbox: BBOXES.sanAntonio,
    });
    expect(result.provider).toBe("Bexar County GIS parcels");
    expect(result.adapterKey).toBe("county-gis:parcels:48029");
    expect(result.serviceUrl).toContain("maps.bexar.org");
    expect(result.notSurveyGrade).toBe(true);
    expect(result.disclaimer).toBe(TX_COUNTY_PARCEL_DISCLAIMER);
    expect(result.featureCount).toBe(2);
    expect(result.queryMode).toBe("bbox");
  });

  it("TX_PARCEL_PROVIDER=off bypasses the county provider (Cotality branch runs)", async () => {
    process.env.TX_PARCEL_PROVIDER = "off";
    process.env.COTALITY_SPATIALTILE_KEY = "test-key";
    process.env.COTALITY_SPATIALTILE_SECRET = "test-secret";
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("maps.bexar.org")) {
        throw new Error("county provider must not be hit when off");
      }
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "tile-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // Cotality Spatial Tile parcels page.
      return new Response(
        JSON.stringify({
          parcels: [
            {
              clip: "1234567890",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-97.7425, 30.2665],
                    [-97.742, 30.2665],
                    [-97.742, 30.267],
                    [-97.7425, 30.267],
                    [-97.7425, 30.2665],
                  ],
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await queryGisLayerGeoJson({
      layer: "parcels",
      bbox: BBOXES.sanAntonio,
    });
    expect(result.provider).toBe("Cotality Spatial Tile");
    expect(result.adapterKey).toBe("cotality:parcels");
    expect(result.notSurveyGrade).toBeUndefined();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("maps.bexar.org"))).toBe(false);
  });

  it("out-of-coverage bbox flows to the Cotality branch unchanged", async () => {
    process.env.COTALITY_SPATIALTILE_KEY = "test-key";
    process.env.COTALITY_SPATIALTILE_SECRET = "test-secret";
    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "tile-token", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          parcels: [
            {
              clip: "0987654321",
              geometry: {
                type: "Polygon",
                coordinates: [
                  [
                    [-109.55, 38.57],
                    [-109.549, 38.57],
                    [-109.549, 38.571],
                    [-109.55, 38.571],
                    [-109.55, 38.57],
                  ],
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await queryGisLayerGeoJson({
      layer: "parcels",
      bbox: BBOXES.moabUt,
    });
    expect(result.provider).toBe("Cotality Spatial Tile");
    expect(result.featureCount).toBe(1);
  });
});

describe("labels", () => {
  it("adapter key and provider label are county-scoped", () => {
    const bexar = countyByName("Bexar");
    expect(txCountyAdapterKey(bexar)).toBe("county-gis:parcels:48029");
    expect(txCountyProviderLabel(bexar)).toBe("Bexar County GIS parcels");
  });

  it("store-backed counties label as TxGIO with txgio: adapter keys and their own disclaimer", () => {
    const hays = countyByName("Hays");
    expect(hays.source).toBe("txgio-store");
    expect(txCountyAdapterKey(hays)).toBe("txgio:parcels:48209");
    expect(txCountyProviderLabel(hays)).toBe("Hays County parcels (TxGIO/StratMap)");
    expect(txCountyDisclaimer(hays)).toBe(TXGIO_PARCEL_DISCLAIMER);
    expect(txCountyDisclaimer(countyByName("Bexar"))).toBe(TX_COUNTY_PARCEL_DISCLAIMER);
  });
});

describe("store-backed counties (Hays/Comal — feat/txgio-parcel-geometry)", () => {
  const SAN_MARCOS_BBOX = {
    westLng: -97.945,
    southLat: 29.88,
    eastLng: -97.94,
    northLat: 29.885,
  };

  const STORE_RESULT = {
    geojson: {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [] },
          properties: {
            apn: "12310",
            provider: "txgio",
            countyFips: "48209",
            countyName: "Hays",
            notSurveyGrade: true,
          },
        },
      ],
    },
    featureCount: 1,
    queryMode: "bbox" as const,
  };

  it("routes San Marcos to Hays and New Braunfels (Comal core) to Comal", () => {
    expect(resolveTxParcelCounty({ bbox: SAN_MARCOS_BBOX })?.fips).toBe("48209");
    // New Braunfels core (Comal side, verified: 4 Comal parcels / 0 Guadalupe
    // parcels cover this point). Was (29.703, -98.1245) before Guadalupe was
    // added; that eastern point sits in the genuine Comal/Guadalupe parcel
    // interleave (both counties have parcels within a few hundred meters) and
    // now resolves to Guadalupe under nearest-centroid routing — see the
    // documented edge case below. This assertion uses a point squarely in the
    // Comal core so it stays authoritative.
    expect(
      resolveTxParcelCounty({ latitude: 29.71, longitude: -98.2 })?.fips,
    ).toBe("48091");
  });

  it("KNOWN EDGE: the New Braunfels east interleave (a Comal parcel) resolves to Guadalupe under bbox+centroid routing", () => {
    // Documents a real limitation introduced by adding Guadalupe: the point
    // (29.703, -98.1245) is a genuine Comal parcel (3 Comal / 0 Guadalupe
    // parcels cover it) but sits closer to Guadalupe's parcel-mass centroid,
    // so nearest-centroid pre-routing hands it to the Guadalupe store, which
    // will read as no-coverage. True separation of interleaved store counties
    // needs point-in-polygon pre-resolution (out of scope for F4g). If a
    // later change fixes this, flip the expectation to "48091".
    expect(
      resolveTxParcelCounty({ latitude: 29.703, longitude: -98.1245 })?.fips,
    ).toBe("48187");
  });

  it("REGRESSION: Austin/Lockhart routing is unchanged by the new bboxes", () => {
    expect(resolveTxParcelCounty({ bbox: BBOXES.austin })?.fips).toBe("48453");
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.fips,
    ).toBe("48055");
  });

  it("delegates to the store reader — no upstream fetch, no tile cache", async () => {
    vi.mocked(queryTxgioParcelsGeoJson).mockResolvedValueOnce(STORE_RESULT);
    const fetchSpy = vi.fn(async () => {
      throw new Error("store-backed county must not fetch upstream");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const county = countyByName("Hays");
    const result = await queryTxCountyParcelsGeoJson({
      county,
      bbox: SAN_MARCOS_BBOX,
    });
    expect(result).toEqual(STORE_RESULT);
    expect(queryTxgioParcelsGeoJson).toHaveBeenCalledWith({
      countyFips: "48209",
      countyName: "Hays",
      bbox: SAN_MARCOS_BBOX,
      latitude: undefined,
      longitude: undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getTxParcelTile).not.toHaveBeenCalled();
    expect(putTxParcelTile).not.toHaveBeenCalled();
  });

  it("dispatcher serves a Hays bbox with the TxGIO honesty envelope", async () => {
    vi.mocked(queryTxgioParcelsGeoJson).mockResolvedValueOnce(STORE_RESULT);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("store-backed county must not fetch upstream");
      }),
    );

    const result = await queryGisLayerGeoJson({
      layer: "parcels",
      bbox: SAN_MARCOS_BBOX,
    });
    expect(result.provider).toBe("Hays County parcels (TxGIO/StratMap)");
    expect(result.adapterKey).toBe("txgio:parcels:48209");
    expect(result.serviceUrl).toContain("data.geographic.texas.gov");
    expect(result.notSurveyGrade).toBe(true);
    expect(result.disclaimer).toBe(TXGIO_PARCEL_DISCLAIMER);
    expect(result.featureCount).toBe(1);
    expect(result.queryMode).toBe("bbox");
  });

  it("propagates the store reader's named no-coverage error (no Cotality fallthrough)", async () => {
    vi.mocked(queryTxgioParcelsGeoJson).mockRejectedValueOnce(
      new AdapterRunError(
        "no-coverage",
        "Comal County parcels (TxGIO/StratMap) has no ingested parcel polygons for this query.",
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("must not fall through to Cotality");
      }),
    );
    await expect(
      queryGisLayerGeoJson({
        layer: "parcels",
        latitude: 29.703,
        longitude: -98.1245,
      }),
    ).rejects.toThrow(/Comal County parcels \(TxGIO\/StratMap\) has no ingested/);
  });
});
