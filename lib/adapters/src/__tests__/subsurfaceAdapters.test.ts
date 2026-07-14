/**
 * Subsurface site-context adapters — Wave 1 (cc-agent-C, 2026-06-07).
 *
 * SSURGO soils, USGS geology / groundwater / seismic. Exercised against
 * recorded fixtures; runner integration covers gating, no-coverage pills,
 * and federal-tier cache eligibility.
 */

import { describe, expect, it, vi } from "vitest";
import {
  parseSdaTableRows,
  parseSsurgoWfsGml,
  usdaSsurgoSoilsAdapter,
} from "../federal/usda-ssurgo";
import { usgsGeologyAdapter } from "../federal/usgs-geology";
import { usgsGroundwaterAdapter } from "../federal/usgs-groundwater";
import { usgsSeismicAdapter, deriveSiteClassFromShrinkSwell } from "../federal/usgs-seismic";
import { runAdapters } from "../runner";
import {
  FEDERAL_TIER_CACHE_PREDICATE,
  type AdapterResultCache,
  type AdapterCacheHit,
  type AdapterCacheKey,
} from "../cache";
import {
  arcgisEmpty,
  jsonResponse,
} from "../__fixtures__/arcgisFixtures";
import {
  nwisGwIvReading,
  nwisSiteEmptyRdb,
  nwisSiteWithWellRdb,
  qfaultsEmpty,
  qfaultsFeature,
  sgmcGeologyFeature,
  ssurgoMapUnitFeature,
  ssurgoSdaTable,
  usgsSeismicDesignNoCoverage,
  usgsSeismicDesignSuccess,
} from "../__fixtures__/federalFixtures";
import type { AdapterContext, AdapterResult } from "../types";

const bastrop: AdapterContext = {
  parcel: { latitude: 30.1105, longitude: -97.3186 },
  jurisdiction: { stateKey: "texas", localKey: "bastrop-tx" },
};

const oceanNoSoils: AdapterContext = {
  parcel: { latitude: 0, longitude: -160 },
  jurisdiction: { stateKey: null, localKey: null },
};

const alaskaNoSgmc: AdapterContext = {
  parcel: { latitude: 64.2, longitude: -149.9 },
  jurisdiction: { stateKey: null, localKey: null },
};

function ssurgoFetchImpl() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("gssurgo") && url.includes("/query")) {
      return jsonResponse(ssurgoMapUnitFeature);
    }
    if (url.includes("sdmdataaccess.sc.egov.usda.gov")) {
      return jsonResponse(ssurgoSdaTable);
    }
    return jsonResponse({}, 404);
  });
}

class InMemoryCache implements AdapterResultCache {
  readonly store = new Map<string, AdapterCacheHit>();
  async get(key: AdapterCacheKey): Promise<AdapterCacheHit | null> {
    return (
      this.store.get(`${key.adapterKey}|${key.latRounded}|${key.lngRounded}`) ??
      null
    );
  }
  async put(key: AdapterCacheKey, result: AdapterResult): Promise<void> {
    this.store.set(`${key.adapterKey}|${key.latRounded}|${key.lngRounded}`, {
      result,
      cachedAt: new Date("2026-06-07T12:00:00.000Z"),
    });
  }
}

describe("USDA SSURGO soils adapter", () => {
  it("returns map-unit and dominant-component attributes for a Central Texas parcel", async () => {
    const fetchImpl = ssurgoFetchImpl();
    const outcomes = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      musym: string | null;
      drainageClass: string | null;
      hydrologicSoilGroup: string | null;
      shrinkSwellPotential: string | null;
    };
    expect(payload.kind).toBe("ssurgo-soils");
    expect(payload.musym).toBe("Pf");
    expect(payload.drainageClass).toBe("Well drained");
    expect(payload.hydrologicSoilGroup).toBe("C");
    expect(payload.shrinkSwellPotential).toBe("Moderate");
    expect(outcomes[0].result?.provider).toMatch(/USDA NRCS/);
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes("gssurgo"))).toBe(
      true,
    );
    expect(
      fetchImpl.mock.calls.some((c) =>
        String(c[0]).includes("sdmdataaccess.sc.egov.usda.gov"),
      ),
    ).toBe(true);
  });

  it("emits no-coverage when both gSSURGO and SDA return empty", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/query")) return jsonResponse(arcgisEmpty);
      if (url.includes("sdmdataaccess")) {
        return jsonResponse({ Table: [] });
      }
      return jsonResponse({}, 404);
    });
    const outcomes = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.code).toBe("no-coverage");
  });

  it("skips off-US parcels via appliesTo (neutral no-coverage pill)", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: { ...oceanNoSoils, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is eligible for the federal-tier 24h cache predicate", () => {
    expect(FEDERAL_TIER_CACHE_PREDICATE(usdaSsurgoSoilsAdapter)).toBe(true);
  });

  it("replays from cache on a second run without re-fetching", async () => {
    const fetchImpl = ssurgoFetchImpl();
    const cache = new InMemoryCache();
    const ctx = { ...bastrop, fetchImpl };
    const first = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: ctx,
      cache,
    });
    expect(first[0].status).toBe("ok");
    expect(first[0].fromCache).toBe(false);
    const callsAfterFirst = fetchImpl.mock.calls.length;

    const second = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: ctx,
      cache,
    });
    expect(second[0].status).toBe("ok");
    expect(second[0].fromCache).toBe(true);
    expect(fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it("succeeds via SDA when the gSSURGO ArcGIS host resets TLS", async () => {
    // The gSSURGO host (nrcsgeoservices) TLS-resets from Cloud Run; the
    // adapter must not fail when SDA answered (the old Promise.all did).
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("gssurgo")) {
        throw new TypeError("fetch failed: ECONNRESET");
      }
      if (url.includes("sdmdataaccess.sc.egov.usda.gov")) {
        return jsonResponse(ssurgoSdaTable);
      }
      return jsonResponse({}, 404);
    });
    const outcomes = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      musym: string | null;
      areaSymbol: string | null;
      waterTableDepthMinFeet: number | null;
      gssurgoEnrichmentAvailable: boolean;
    };
    expect(payload.musym).toBe("Pf");
    expect(payload.areaSymbol).toBe("TX021");
    // wtdepannmin is centimeters on the wire (60 cm ≈ 2.0 ft).
    expect(payload.waterTableDepthMinFeet).toBe(2);
    expect(payload.gssurgoEnrichmentAvailable).toBe(false);
  }, 30_000);

  it("fails with network-error only when BOTH SDA and gSSURGO are unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNRESET");
    });
    const outcomes = await runAdapters({
      adapters: [usdaSsurgoSoilsAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].error?.code).toBe("network-error");
  }, 60_000);
});

describe("SDA JSON+COLUMNNAME table parsing", () => {
  it("zips the header row onto value rows (real wire shape)", () => {
    const rows = parseSdaTableRows({
      Table: [
        ["mukey", "musym", "muname"],
        ["393475", "Oa", "Oakalla silty clay loam"],
        ["393653", "Tn", "Tinn clay"],
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ mukey: "393475", musym: "Oa" });
    expect(rows[1]).toMatchObject({ mukey: "393653", muname: "Tinn clay" });
  });

  it("tolerates legacy object rows", () => {
    const rows = parseSdaTableRows({
      Table: [{ mukey: "1", musym: "Xx" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].musym).toBe("Xx");
  });

  it("returns empty for missing or empty tables", () => {
    expect(parseSdaTableRows({})).toEqual([]);
    expect(parseSdaTableRows({ Table: [] })).toEqual([]);
    expect(parseSdaTableRows(null)).toEqual([]);
  });
});

describe("SDA WFS GML parsing", () => {
  const bbox = {
    westLng: -97.932,
    southLat: 29.871,
    eastLng: -97.9245,
    northLat: 29.8772,
  };

  it("parses lat,lng GML2 coordinates into GeoJSON [lng, lat] rings", () => {
    const gml = `
<wfs:FeatureCollection xmlns:ms="x" xmlns:gml="y" xmlns:wfs="z">
  <gml:featureMember>
    <ms:mapunitpoly>
      <ms:mupolygonkey>558575913</ms:mupolygonkey>
      <ms:areasymbol>TX604</ms:areasymbol>
      <ms:musym>Oa</ms:musym>
      <ms:mukey>393475</ms:mukey>
      <ms:multiPolygon>
        <gml:MultiPolygon srsName="EPSG:4326">
          <gml:polygonMember>
            <gml:Polygon>
              <gml:outerBoundaryIs>
                <gml:LinearRing>
                  <gml:coordinates>29.8710,-97.9320 29.8710,-97.9245 29.8772,-97.9245 29.8710,-97.9320</gml:coordinates>
                </gml:LinearRing>
              </gml:outerBoundaryIs>
            </gml:Polygon>
          </gml:polygonMember>
        </gml:MultiPolygon>
      </ms:multiPolygon>
    </ms:mapunitpoly>
  </gml:featureMember>
</wfs:FeatureCollection>`;
    const features = parseSsurgoWfsGml(gml, bbox);
    expect(features).toHaveLength(1);
    expect(features[0].properties.mukey).toBe("393475");
    expect(features[0].properties.musym).toBe("Oa");
    expect(features[0].geometry.type).toBe("MultiPolygon");
    expect(features[0].geometry.coordinates[0][0][0]).toEqual([
      -97.932, 29.871,
    ]);
  });

  it("returns no features for an empty collection", () => {
    expect(parseSsurgoWfsGml("<wfs:FeatureCollection/>", bbox)).toEqual([]);
  });
});

describe("USGS geology adapter", () => {
  it("returns SGMC formation attributes for a CONUS parcel", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(sgmcGeologyFeature));
    const outcomes = await runAdapters({
      adapters: [usgsGeologyAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      unitName: string | null;
      majorLithology1: string | null;
    };
    expect(payload.kind).toBe("geology-formation");
    expect(payload.unitName).toBe("Ft. Terk Formation");
    expect(payload.majorLithology1).toBe("Sedimentary");
  });

  it("emits no-coverage when SGMC returns no intersecting polygon", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(arcgisEmpty));
    const outcomes = await runAdapters({
      adapters: [usgsGeologyAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
  });

  it("does not run outside the CONUS SGMC envelope", async () => {
    const fetchImpl = vi.fn();
    const outcomes = await runAdapters({
      adapters: [usgsGeologyAdapter],
      context: { ...alaskaNoSgmc, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("buildNwisGwSiteBboxUrl", () => {
  it("clamps bBox components to <=7 decimal digits (NWIS 400s on float noise)", async () => {
    const { buildNwisGwSiteBboxUrl } = await import(
      "../federal/usgs-groundwater"
    );
    // Mirror the adapter's searchBbox arithmetic for the Bastrop parcel
    // that triggered the production failure: 30.1105 + 0.09 =
    // 30.200499999999998 in IEEE-754, which NWIS rejects with HTTP 400
    // ("requires a decimal number with at most 7 digits to the right of
    // the decimal point").
    const delta = 0.09;
    const latitude = 30.1105;
    const longitude = -97.3186;
    const url = new URL(
      buildNwisGwSiteBboxUrl({
        west: longitude - delta,
        south: latitude - delta,
        east: longitude + delta,
        north: latitude + delta,
      }),
    );
    const components = url.searchParams.get("bBox")!.split(",");
    expect(components).toHaveLength(4);
    for (const component of components) {
      expect(component).toMatch(/^-?\d+(\.\d{1,7})?$/);
    }
    // Rounding must not move the box: each component stays within 1e-6
    // of the exact arithmetic value.
    const exact = [
      longitude - delta,
      latitude - delta,
      longitude + delta,
      latitude + delta,
    ];
    components.forEach((component, i) => {
      expect(Math.abs(Number(component) - exact[i]!)).toBeLessThan(1e-6);
    });
  });
});

describe("USGS groundwater adapter", () => {
  it("returns nearest-well depth when NWIS sites and IV data exist", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(nwisSiteWithWellRdb, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(nwisGwIvReading));
    const outcomes = await runAdapters({
      adapters: [usgsGroundwaterAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      wellCount: number;
      depthToWaterFeet: number | null;
    };
    expect(payload.wellCount).toBe(1);
    expect(payload.depthToWaterFeet).toBeCloseTo(45.2, 1);
  });

  it("emits ok with wellCount=0 (not failed) when no wells are nearby", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(nwisSiteEmptyRdb, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    const outcomes = await runAdapters({
      adapters: [usgsGroundwaterAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as { wellCount: number };
    expect(payload.wellCount).toBe(0);
    expect(outcomes[0].result?.note).toMatch(/No active USGS groundwater/i);
  });
});

describe("USGS seismic adapter", () => {
  it("derives site class E from high shrink-swell soils", () => {
    const info = deriveSiteClassFromShrinkSwell("High");
    expect(info.siteClass).toBe("E");
    expect(info.degraded).toBe(false);
  });

  it("defaults to degraded site class D when soils absent", () => {
    const info = deriveSiteClassFromShrinkSwell(null);
    expect(info.siteClass).toBe("D");
    expect(info.degraded).toBe(true);
  });

  it("returns ASCE 7-22 design parameters for a covered parcel", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("sdmdataaccess.sc.egov.usda.gov")) {
        return jsonResponse(ssurgoSdaTable);
      }
      if (url.includes("designmaps/asce7-22")) {
        return jsonResponse(usgsSeismicDesignSuccess);
      }
      if (url.includes("Qfaults")) {
        return jsonResponse(qfaultsFeature);
      }
      return jsonResponse({}, 404);
    });
    const outcomes = await runAdapters({
      adapters: [usgsSeismicAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("ok");
    const payload = outcomes[0].result?.payload as {
      kind: string;
      seismicDesignCategory: string | null;
      sds: number | null;
      siteClass: string;
      siteClassDegraded: boolean;
      shrinkSwellPotential: string | null;
      nearestFault: { faultName: string | null } | null;
    };
    expect(payload.kind).toBe("seismic-design");
    expect(payload.siteClass).toBe("D");
    expect(payload.siteClassDegraded).toBe(false);
    expect(payload.shrinkSwellPotential).toBe("Moderate");
    expect(payload.seismicDesignCategory).toBe("A");
    expect(payload.sds).toBeCloseTo(0.088, 3);
    expect(payload.nearestFault?.faultName).toBe("Barton Springs Fault");
  });

  it("emits no-coverage when design maps return an error envelope", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("designmaps/asce7-22")) {
        return jsonResponse(usgsSeismicDesignNoCoverage);
      }
      if (url.includes("Qfaults")) {
        return jsonResponse(qfaultsEmpty);
      }
      return jsonResponse({}, 404);
    });
    const outcomes = await runAdapters({
      adapters: [usgsSeismicAdapter],
      context: { ...bastrop, fetchImpl },
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.code).toBe("no-coverage");
  });
});

describe("subsurface registry", () => {
  it("registers all four subsurface adapters in FEDERAL_ADAPTERS", async () => {
    const { FEDERAL_ADAPTERS } = await import("../registry");
    const keys = FEDERAL_ADAPTERS.map((a) => a.adapterKey);
    expect(keys).toContain("usda:ssurgo-soils");
    expect(keys).toContain("usgs:geology");
    expect(keys).toContain("usgs:groundwater");
    expect(keys).toContain("usgs:seismic");
  });
});
