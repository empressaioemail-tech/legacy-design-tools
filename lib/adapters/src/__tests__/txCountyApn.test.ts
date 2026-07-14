/**
 * txCountyApn routing + resolution tests — the store-backed counties
 * (Hays/Comal, feat/txgio-parcel-geometry) next to the live-ArcGIS
 * five, including the injected `ParcelGeometryPointLookup` path and
 * the overlap regressions at the new county lines.
 */

import { describe, expect, it, vi } from "vitest";
import {
  COUNTY_APN_SOURCES,
  resolveCountyApnByPoint,
  resolveCountyApnSource,
} from "../txCountyApn";

const SAN_MARCOS = { latitude: 29.8833, longitude: -97.9414 };
const NEW_BRAUNFELS = { latitude: 29.703, longitude: -98.1245 };
const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };
const WIMBERLEY = { latitude: 30.0, longitude: -98.1 };
const HOUSTON = { latitude: 29.7604, longitude: -95.3698 };

describe("resolveCountyApnSource — store-backed county routing", () => {
  it("routes San Marcos to Hays (48209, txgio-store)", () => {
    const county = resolveCountyApnSource(SAN_MARCOS.latitude, SAN_MARCOS.longitude);
    expect(county?.fips).toBe("48209");
    expect(county?.lookup).toBe("txgio-store");
    expect(county?.cadName).toBe("Hays Central Appraisal District");
  });

  it("routes New Braunfels to Comal (48091) over the overlapping Bexar bbox", () => {
    const county = resolveCountyApnSource(
      NEW_BRAUNFELS.latitude,
      NEW_BRAUNFELS.longitude,
    );
    expect(county?.fips).toBe("48091");
    expect(county?.lookup).toBe("txgio-store");
  });

  it("routes Wimberley to Hays over the overlapping Comal bbox", () => {
    const county = resolveCountyApnSource(WIMBERLEY.latitude, WIMBERLEY.longitude);
    expect(county?.fips).toBe("48209");
  });

  it("REGRESSION: Austin still routes to Travis despite the new Hays bbox overlap", () => {
    const county = resolveCountyApnSource(AUSTIN.latitude, AUSTIN.longitude);
    expect(county?.fips).toBe("48453");
    expect(county?.lookup).toBe("arcgis");
  });

  it("still returns null outside every supported county", () => {
    expect(resolveCountyApnSource(HOUSTON.latitude, HOUSTON.longitude)).toBeNull();
  });

  it("registry sanity: exactly two txgio-store counties, both with TxGIO provenance URLs", () => {
    const store = COUNTY_APN_SOURCES.filter((c) => c.lookup === "txgio-store");
    expect(store.map((c) => c.fips).sort()).toEqual(["48091", "48209"]);
    for (const county of store) {
      expect(county.serviceUrl).toContain("data.geographic.texas.gov");
    }
  });
});

describe("resolveCountyApnByPoint — txgio-store counties", () => {
  it("resolves via the injected geometry lookup, provider 'txgio', no fetch", async () => {
    const parcelPointLookup = vi.fn(async () => ({
      propId: "12310",
      sourceUrl: "https://data.geographic.texas.gov/txgio-test",
    }));
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not fetch for a store-backed county");
    });
    const hit = await resolveCountyApnByPoint({
      ...SAN_MARCOS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      parcelPointLookup,
    });
    expect(hit).toEqual({
      apn: "12310",
      countyFips: "48209",
      countyName: "Hays",
      provider: "txgio",
      sourceUrl: "https://data.geographic.texas.gov/txgio-test",
      retrievedAt: expect.any(String),
    });
    expect(parcelPointLookup).toHaveBeenCalledWith(
      "48209",
      SAN_MARCOS.latitude,
      SAN_MARCOS.longitude,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves to null WITHOUT the injection (falls through like an unsupported county)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("must not fetch for a store-backed county");
    });
    const hit = await resolveCountyApnByPoint({
      ...SAN_MARCOS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(hit).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves to null when the store has no parcel containing the point", async () => {
    const parcelPointLookup = vi.fn(async () => null);
    const hit = await resolveCountyApnByPoint({
      ...NEW_BRAUNFELS,
      parcelPointLookup,
    });
    expect(hit).toBeNull();
    expect(parcelPointLookup).toHaveBeenCalledWith(
      "48091",
      NEW_BRAUNFELS.latitude,
      NEW_BRAUNFELS.longitude,
    );
  });

  it("arcgis counties keep their live path and never call the injected lookup", async () => {
    const parcelPointLookup = vi.fn(async () => ({
      propId: "999",
      sourceUrl: "unused",
    }));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ features: [{ attributes: { PROP_ID: "123456" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const hit = await resolveCountyApnByPoint({
      ...AUSTIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      parcelPointLookup,
    });
    expect(hit?.provider).toBe("county-gis");
    expect(hit?.apn).toBe("123456");
    expect(parcelPointLookup).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalled();
  });
});
