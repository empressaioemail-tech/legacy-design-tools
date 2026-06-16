import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COTALITY_PROPERTY_BASE_URL_DEFAULT,
  __resetCotalityClipDedupForTests,
  __resetCotalityTokenCacheForTests,
  cotalityPropertyBaseUrl,
  parseCotalityCatalogAddress,
  resolveCotalityClip,
} from "../national/cotalityClient";

describe("parseCotalityCatalogAddress", () => {
  it("parses San Marcos address into catalog components", () => {
    expect(
      parseCotalityCatalogAddress({
        address: "613 Sturgeon Dr, San Marcos, TX 78666",
      }),
    ).toEqual({
      streetAddress: "613 Sturgeon Dr",
      city: "San Marcos",
      state: "TX",
    });
  });

  it("prefers explicit city/state over parsed address", () => {
    expect(
      parseCotalityCatalogAddress({
        address: "613 Sturgeon Dr, San Marcos, TX 78666",
        city: "San Marcos",
        state: "Texas",
      }),
    ).toEqual({
      streetAddress: "613 Sturgeon Dr",
      city: "San Marcos",
      state: "TX",
    });
  });
});

describe("resolveCotalityClip catalog geocode", () => {
  beforeEach(() => {
    process.env.COTALITY_PROPERTY_KEY = "prop-key";
    process.env.COTALITY_PROPERTY_SECRET = "prop-secret";
    __resetCotalityTokenCacheForTests();
    __resetCotalityClipDedupForTests();
  });

  afterEach(() => {
    delete process.env.COTALITY_PROPERTY_KEY;
    delete process.env.COTALITY_PROPERTY_SECRET;
    vi.restoreAllMocks();
  });

  it("uses api1 host and catalog query params", async () => {
    expect(cotalityPropertyBaseUrl()).toBe(COTALITY_PROPERTY_BASE_URL_DEFAULT);
    expect(cotalityPropertyBaseUrl()).toContain("api1.cotality.com");

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toContain("api1.cotality.com/v2/properties/search/geocode");
      expect(url).toContain("streetAddress=613");
      expect(url).toContain("city=San+Marcos");
      expect(url).toContain("state=TX");
      expect(url).toContain("bestMatch=true");
      expect(url).not.toContain("lat=");
      expect(url).not.toContain("fullAddress=");
      return new Response(
        JSON.stringify({
          items: [{ clip: "8031593485", latitude: 29.87, longitude: -97.92 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const clip = await resolveCotalityClip({
      latitude: 29.870188,
      longitude: -97.927538,
      address: "613 Sturgeon Dr, San Marcos, TX 78666",
      city: "San Marcos",
      state: "Texas",
      fetchImpl,
      adapterKeyForLog: "cotality:property",
    });

    expect(clip.clip).toBe("8031593485");
  });

  it("maps Clip not found 404 to no-coverage", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          properties: [],
          messages: [{ messageType: "error", message: "Clip not found" }],
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    });

    await expect(
      resolveCotalityClip({
        latitude: 30.2672,
        longitude: -97.7431,
        address: "999 Fake St, Austin, TX 78701",
        city: "Austin",
        state: "TX",
        fetchImpl,
        adapterKeyForLog: "cotality:property",
      }),
    ).rejects.toMatchObject({
      code: "no-coverage",
      message: expect.stringContaining("not in Cotality coverage"),
    });
  });

  it("maps blank-body 404 to upstream routing error", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "tok", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 404 });
    });

    await expect(
      resolveCotalityClip({
        latitude: 29.87,
        longitude: -97.92,
        address: "613 Sturgeon Dr, San Marcos, TX 78666",
        city: "San Marcos",
        state: "TX",
        fetchImpl,
        adapterKeyForLog: "cotality:property",
      }),
    ).rejects.toMatchObject({
      code: "upstream-error",
      message: expect.stringContaining("routing/host misconfiguration"),
    });
  });
});
