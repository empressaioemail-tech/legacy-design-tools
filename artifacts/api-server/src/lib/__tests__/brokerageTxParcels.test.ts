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
  resolvePointCountyByPip,
  queryTxCountyParcelsGeoJson,
  txCountyAdapterKey,
  txCountyDisclaimer,
  txCountyProviderLabel,
  type TxParcelCounty,
} from "../brokerageTxParcels";
import {
  countyStoreContainsPoint,
  type TxgioStoreDb,
} from "../txgioParcelStore";
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

  it("resolves a San Antonio pin to Bexar (now store-backed, F4i)", () => {
    const c = resolveTxParcelCounty({ latitude: 29.4254, longitude: -98.4925 });
    expect(c?.fips).toBe("48029");
    expect(c?.source).toBe("txgio-store");
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

  it("SYNC centroid router (bbox viewport path): SW-Travis near the Hays line still centroid-routes to Hays; the POINT path is fixed by F4j PIP", () => {
    // Real Travis parcel center (11412 ESPERANZA DR, 78739): 30.17047,
    // -97.87057. `resolveTxParcelCounty` is the SYNCHRONOUS nearest-centroid
    // router — retained UNCHANGED for the bbox VIEWPORT tile-fetch (a viewport
    // wants a dominant county, has no single point to PIP-test). Travis' mass
    // centroid sits far east, so this SW point is nearer Hays' centroid and
    // the sync router still returns Hays here. That is fine for a viewport:
    // the Hays store filters by county_fips=48209, has no Travis rows, and
    // returns honest no-coverage — never a wrong parcel.
    //
    // The POINT pin-query + rooftop paths NO LONGER use this centroid router:
    // F4j routes them through `resolvePointCountyByPip`, which PIP-resolves
    // this exact point to Travis (48453) because the Travis parcel CONTAINS
    // it (proven in f4j_pip_county_live_e2e.integration.test.ts). So the
    // route-level behavior IS fixed; this assertion pins the sync viewport
    // router's unchanged contract, not the route outcome.
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

  it("REGRESSION: Bastrop/Caldwell stay live-ArcGIS; Bexar now store-backed (F4i); Hays/Comal unchanged", () => {
    // Bexar was flipped to the store in F4i (see the F4i describe block).
    expect(resolveTxParcelCounty({ bbox: BBOXES.sanAntonio })?.source).toBe(
      "txgio-store",
    );
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

describe("F4i: Bexar flipped to the TxGIO store (last metro county)", () => {
  function county(fips: string): TxParcelCounty {
    const c = TX_PARCEL_COUNTIES.find((x) => x.fips === fips);
    if (!c) throw new Error(`no county ${fips}`);
    return c;
  }

  it("Bexar (48029) is a store entry pointing at the StratMap resource, no arcgis fields", () => {
    const b = county("48029");
    expect(b.source).toBe("txgio-store");
    expect(b.serviceUrl).toContain("data.geographic.texas.gov");
    expect(b.serviceUrl).toContain("stratmap25-landparcels_48029_lp.zip");
    // No live-ArcGIS field-mapping: identity is stamped by the store from
    // its own prop_id column, so no rawPropId and normalizeProps passes
    // through unchanged.
    expect(b.rawPropId).toBeUndefined();
    const passthrough = { anything: 1 };
    expect(b.normalizeProps(passthrough)).toBe(passthrough);
    // The old BCAD maps.bexar.org MapServer URL is gone.
    expect(b.serviceUrl).not.toContain("maps.bexar.org");
    // Store label + adapter key + disclaimer.
    expect(txCountyProviderLabel(b)).toBe("Bexar County parcels (TxGIO/StratMap)");
    expect(txCountyAdapterKey(b)).toBe("txgio:parcels:48029");
    expect(txCountyDisclaimer(b)).toBe(TXGIO_PARCEL_DISCLAIMER);
  });

  it("San Antonio urban core (~29.42, -98.49) resolves to Bexar via the store", () => {
    // Interior San Antonio, near the Bexar parcel-mass centroid.
    const c = resolveTxParcelCounty({ latitude: 29.4241, longitude: -98.4936 });
    expect(c?.fips).toBe("48029");
    expect(c?.source).toBe("txgio-store");
    // And from an in-city bbox.
    const cb = resolveTxParcelCounty({ bbox: BBOXES.sanAntonio });
    expect(cb?.fips).toBe("48029");
    expect(cb?.source).toBe("txgio-store");
  });

  it("delegates a Bexar bbox to the store reader (no upstream fetch)", async () => {
    const STORE_RESULT = {
      geojson: {
        type: "FeatureCollection" as const,
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [] },
            properties: {
              apn: "618327",
              provider: "txgio",
              countyFips: "48029",
              countyName: "Bexar",
              parcel_node_id: "48029:618327",
              notSurveyGrade: true,
            },
          },
        ],
      },
      featureCount: 1,
      queryMode: "bbox" as const,
    };
    vi.mocked(queryTxgioParcelsGeoJson).mockResolvedValueOnce(STORE_RESULT);
    const fetchSpy = vi.fn(async () => {
      throw new Error("store-backed Bexar must not fetch upstream");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await queryTxCountyParcelsGeoJson({
      county: county("48029"),
      bbox: BBOXES.sanAntonio,
    });
    expect(result).toEqual(STORE_RESULT);
    expect(queryTxgioParcelsGeoJson).toHaveBeenCalledWith({
      countyFips: "48029",
      countyName: "Bexar",
      bbox: BBOXES.sanAntonio,
      latitude: undefined,
      longitude: undefined,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getTxParcelTile).not.toHaveBeenCalled();
    expect(putTxParcelTile).not.toHaveBeenCalled();
  });

  it("KNOWN EDGE (documented sliver): NE Bexar near the Comal/Guadalupe line may route to a neighbor store under nearest-centroid", () => {
    // Bexar's routing bbox overlaps Comal (NE) and Guadalupe (E). A small
    // residual (~5.5% of sampled Bexar parcels, all along the E/NE edge) is
    // handed to the neighbor store under nearest-centroid — honest
    // no-coverage there (the neighbor store filters by its own county_fips
    // and has no Bexar rows), never a WRONG parcel. Reverse leak is
    // negligible (Guadalupe/Hays -> Bexar 0.00%, Comal 0.47%). For a
    // situs-bearing border address the multi-county situs pre-pass still
    // includes Bexar, so it resolves regardless of centroid distance.
    // The San Antonio core itself is unaffected (asserted above). This test
    // documents the limit; it does not assert a wrong-parcel outcome.
    const bexar = county("48029");
    // The core is contained by Bexar's routing bbox (recovery-path guarantee).
    const inBexarBbox =
      -98.4936 >= bexar.bbox.westLng &&
      -98.4936 <= bexar.bbox.eastLng &&
      29.4241 >= bexar.bbox.southLat &&
      29.4241 <= bexar.bbox.northLat;
    expect(inBexarBbox).toBe(true);
  });

  it("REGRESSION: Travis/Williamson/Hays/Comal store routing unchanged by the Bexar flip", () => {
    expect(resolveTxParcelCounty({ bbox: BBOXES.austin })?.fips).toBe("48453");
    expect(resolveTxParcelCounty({ bbox: BBOXES.roundRock })?.fips).toBe("48491");
    expect(
      resolveTxParcelCounty({ latitude: 29.88, longitude: -97.94 })?.fips,
    ).toBe("48209");
    // Bastrop/Caldwell stay live-ArcGIS.
    expect(resolveTxParcelCounty({ bbox: BBOXES.bastrop })?.source).toBeUndefined();
    expect(
      resolveTxParcelCounty({ latitude: 29.885, longitude: -97.673 })?.source,
    ).toBeUndefined();
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
    // Bexar is store-backed (F4i); Bastrop/Caldwell stay live-ArcGIS. San
    // Antonio still routes to Bexar (48029), now via the store.
    expect(resolveTxParcelCounty({ bbox: BBOXES.sanAntonio })?.source).toBe(
      "txgio-store",
    );
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
  // Travis + Williamson attribute-normalization tests were removed in F4h,
  // and Bexar's in F4i: all four are now source: "txgio-store", so
  // queryTxCountyParcelsGeoJson delegates to the txgio_parcel store reader
  // (mocked here / covered by the integration suite) and no longer runs the
  // live-ArcGIS normalizeProps path. The store-side feature shape
  // (apn/situs/owner/landUse via the cad_property join) is exercised in the
  // txgioParcelStore + f4e integration suites. Bastrop/Caldwell below still
  // cover the live-ArcGIS normalizers.
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
    // Bastrop is still live-ArcGIS (Bexar was flipped to the store in F4i).
    await expect(
      queryTxCountyParcelsGeoJson({
        county: countyByName("Bastrop"),
        bbox: BBOXES.bastrop,
        fetchImpl: fixtureFetchFor({ type: "FeatureCollection", features: [] }),
      }),
    ).rejects.toMatchObject({ code: "no-coverage" });
  });

  it("propagates a county upstream failure as a named AdapterRunError (no Cotality fallthrough)", async () => {
    const failFetch = vi.fn(async () =>
      new Response("Service unavailable", { status: 503 }),
    ) as unknown as typeof fetch;
    const err = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
      fetchImpl: failFetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterRunError);
    expect(String((err as Error).message)).toContain("Bastrop County GIS parcels");
  });
});

describe("truncation at the Cotality-parity cap", () => {
  it("caps merged pages at TX_PARCEL_FEATURE_CAP and flags truncated", async () => {
    // Bastrop is still live-ArcGIS (Bexar was flipped to the store in F4i;
    // the store path has its own cap/truncation test in the txgio suite).
    const template = TX_COUNTY_PARCEL_FIXTURES.bastrop.features[0];
    const page = {
      type: "FeatureCollection",
      exceededTransferLimit: true,
      features: Array.from({ length: 50 }, (_, i) => ({
        type: "Feature",
        geometry: template.geometry,
        properties: { ...template.properties, prop_id: 100000 + i },
      })),
    };
    const pagedFetch = vi.fn(async () =>
      new Response(JSON.stringify(page), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      bbox: BBOXES.bastrop,
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
    // Bastrop is still live-ArcGIS (Bexar was flipped to the store in F4i).
    await queryTxCountyParcelsGeoJson({
      county: countyByName("Bastrop"),
      latitude: 30.106,
      longitude: -97.316,
      fetchImpl: fixtureFetchFor(TX_COUNTY_PARCEL_FIXTURES.bastrop),
    });
    expect(vi.mocked(getTxParcelTile)).not.toHaveBeenCalled();
    expect(vi.mocked(putTxParcelTile)).not.toHaveBeenCalled();
  });
});

describe("dispatcher routing (queryGisLayerGeoJson parcels branch)", () => {
  it("serves an in-county live-ArcGIS bbox (Bastrop) from the county provider with the honesty envelope", async () => {
    // Bexar was flipped to the store in F4i, so the live-ArcGIS dispatcher
    // path is now exercised via Bastrop (still a live county service). The
    // store-backed Bexar/Travis/Williamson dispatch is covered by the Hays
    // store dispatcher test below.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("maps.co.bastrop.tx.us")) {
          return new Response(JSON.stringify(TX_COUNTY_PARCEL_FIXTURES.bastrop), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const result = await queryGisLayerGeoJson({
      layer: "parcels",
      bbox: BBOXES.bastrop,
    });
    expect(result.provider).toBe("Bastrop County GIS parcels");
    expect(result.adapterKey).toBe("county-gis:parcels:48021");
    expect(result.serviceUrl).toContain("maps.co.bastrop.tx.us");
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
      if (url.includes("maps.co.bastrop.tx.us")) {
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
      bbox: BBOXES.bastrop,
    });
    expect(result.provider).toBe("Cotality Spatial Tile");
    expect(result.adapterKey).toBe("cotality:parcels");
    expect(result.notSurveyGrade).toBeUndefined();
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("maps.co.bastrop.tx.us"))).toBe(false);
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
  it("adapter key and provider label are county-scoped (live-ArcGIS Bastrop)", () => {
    // Bexar was flipped to the store in F4i; Bastrop is a live-ArcGIS county.
    const bastrop = countyByName("Bastrop");
    expect(txCountyAdapterKey(bastrop)).toBe("county-gis:parcels:48021");
    expect(txCountyProviderLabel(bastrop)).toBe("Bastrop County GIS parcels");
  });

  it("store-backed counties label as TxGIO with txgio: adapter keys and their own disclaimer", () => {
    const hays = countyByName("Hays");
    expect(hays.source).toBe("txgio-store");
    expect(txCountyAdapterKey(hays)).toBe("txgio:parcels:48209");
    expect(txCountyProviderLabel(hays)).toBe("Hays County parcels (TxGIO/StratMap)");
    expect(txCountyDisclaimer(hays)).toBe(TXGIO_PARCEL_DISCLAIMER);
    // Bexar is now store-backed (F4i): TxGIO label/key/disclaimer.
    const bexar = countyByName("Bexar");
    expect(bexar.source).toBe("txgio-store");
    expect(txCountyAdapterKey(bexar)).toBe("txgio:parcels:48029");
    expect(txCountyProviderLabel(bexar)).toBe("Bexar County parcels (TxGIO/StratMap)");
    expect(txCountyDisclaimer(bexar)).toBe(TXGIO_PARCEL_DISCLAIMER);
    // A still-live-ArcGIS county keeps the county-GIS disclaimer.
    expect(txCountyDisclaimer(countyByName("Bastrop"))).toBe(TX_COUNTY_PARCEL_DISCLAIMER);
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

  it("SYNC centroid router (bbox viewport path): the New Braunfels east interleave still centroid-routes to Guadalupe; the POINT path is fixed by F4j PIP", () => {
    // The point (29.703, -98.1245) is a genuine Comal parcel (3 Comal / 0
    // Guadalupe parcels cover it) but sits closer to Guadalupe's parcel-mass
    // centroid. The SYNCHRONOUS `resolveTxParcelCounty` — retained for the
    // bbox VIEWPORT tile-fetch — still returns Guadalupe here (nearest
    // centroid). F4g called true separation "out of scope"; F4j delivers it
    // for the POINT paths: `resolvePointCountyByPip` PIP-resolves this exact
    // NB-interleave point to Comal (48091) because a Comal parcel CONTAINS it
    // and no Guadalupe parcel does (the same fix the live e2e proves for the
    // 1400 E Common St straddle). This assertion pins the unchanged sync
    // viewport router; the route outcome is now Comal, not a no-coverage
    // Guadalupe decline.
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

// ── F4j: point-in-polygon county pre-resolution ─────────────────────────────
//
// `countyStoreContainsPoint` is unit-tested with an injected fake db returning
// controlled geometry rows (containment + tightest-parcel tiebreak logic). The
// full `resolvePointCountyByPip` orchestration over the REAL prod store — the
// NB/Comal straddle fix and the Travis border-leak fix — is proven live in
// `src/__tests__/f4j_pip_county_live_e2e.integration.test.ts`.

/** Minimal drizzle-select stub: `.select().from().where()` awaits to `rows`,
 *  ignoring the (opaque) predicate — each test controls the returned set. */
function fakeStoreDb(rows: unknown[]): TxgioStoreDb {
  const thenable = {
    from: () => thenable,
    where: () => Promise.resolve(rows),
  };
  return { select: () => thenable } as unknown as TxgioStoreDb;
}

/** Axis-aligned square polygon (GeoJSON), given center + half-size (deg). */
function squarePolygon(cx: number, cy: number, half: number) {
  return {
    type: "Polygon",
    coordinates: [
      [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
      ],
    ],
  };
}

function storeRow(propId: string | null, cx: number, cy: number, half: number) {
  return {
    featureIndex: 1,
    propId,
    geoId: null,
    ownerName: null,
    situsAddress: null,
    situsCity: null,
    situsZip: null,
    geometry: squarePolygon(cx, cy, half),
    westLng: cx - half,
    southLat: cy - half,
    eastLng: cx + half,
    northLat: cy + half,
    sourceVintage: "stratmap25",
  };
}

describe("countyStoreContainsPoint (F4j PIP probe)", () => {
  it("returns the containing parcel's prop id when a polygon contains the point", async () => {
    const db = fakeStoreDb([storeRow("29336", -98.1, 29.72, 0.001)]);
    const hit = await countyStoreContainsPoint({
      countyFips: "48091",
      latitude: 29.72,
      longitude: -98.1,
      database: db,
    });
    expect(hit?.propId).toBe("29336");
  });

  it("returns null when no polygon contains the point (honest gap)", async () => {
    // Row's bbox is near the point but the polygon is a tiny square that does
    // NOT enclose it -> no containment.
    const db = fakeStoreDb([storeRow("1", -98.2, 29.72, 0.0005)]);
    const hit = await countyStoreContainsPoint({
      countyFips: "48091",
      latitude: 29.72,
      longitude: -98.1,
      database: db,
    });
    expect(hit).toBeNull();
  });

  it("prefers the TIGHTEST containing parcel (smallest bbox) when the point is inside several", async () => {
    const db = fakeStoreDb([
      storeRow("big", -98.1, 29.72, 0.01), // large enclosing parcel
      storeRow("small", -98.1, 29.72, 0.0008), // the real lot
    ]);
    const hit = await countyStoreContainsPoint({
      countyFips: "48091",
      latitude: 29.72,
      longitude: -98.1,
      database: db,
    });
    expect(hit?.propId).toBe("small");
  });

  it("skips a containing parcel with no prop id (cannot identify the parcel)", async () => {
    const db = fakeStoreDb([
      storeRow(null, -98.1, 29.72, 0.0008), // contains, but no id
      storeRow("29336", -98.1, 29.72, 0.01), // contains, has id
    ]);
    const hit = await countyStoreContainsPoint({
      countyFips: "48091",
      latitude: 29.72,
      longitude: -98.1,
      database: db,
    });
    expect(hit?.propId).toBe("29336");
  });

  it("returns null for a non-finite point", async () => {
    const db = fakeStoreDb([storeRow("29336", -98.1, 29.72, 0.01)]);
    expect(
      await countyStoreContainsPoint({
        countyFips: "48091",
        latitude: Number.NaN,
        longitude: -98.1,
        database: db,
      }),
    ).toBeNull();
  });
});

describe("resolvePointCountyByPip (F4j fallback + guardrails)", () => {
  it("returns none for a point outside every supported county bbox", async () => {
    const res = await resolvePointCountyByPip({
      latitude: 27.0,
      longitude: -95.0,
    });
    expect(res.county).toBeNull();
    expect(res.resolvedBy).toBe("none");
  });

  it("returns none for a non-finite point", async () => {
    const res = await resolvePointCountyByPip({
      latitude: Number.NaN,
      longitude: -98.1,
    });
    expect(res.county).toBeNull();
    expect(res.resolvedBy).toBe("none");
  });
});
