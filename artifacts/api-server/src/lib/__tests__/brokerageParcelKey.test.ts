/**
 * Provider-neutral parcel-key capture tests.
 *
 * The load-bearing case: Cotality (CLIP vendor) is dark — credentials
 * missing or the resolver throwing — and capture must still succeed with
 * an `apn:<fips>:<apn>` county-GIS key or a `geo:` fallback, never throw.
 * No live vendor or county service is hit: the Cotality client, the
 * geocoder, and the ArcGIS point query are all mocked.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@workspace/adapters/national/cotalityClient", () => ({
  resolveCotalityClip: vi.fn(),
  readCotalityAppCredentials: vi.fn(() => null),
}));

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: vi.fn(),
}));

vi.mock("@workspace/adapters/arcgis", () => ({
  arcgisPointQuery: vi.fn(),
}));

import {
  resolveCotalityClip,
  readCotalityAppCredentials,
} from "@workspace/adapters/national/cotalityClient";
import { geocodeAddress } from "@workspace/site-context/server";
import { arcgisPointQuery } from "@workspace/adapters/arcgis";
import {
  captureParcelKey,
  parcelKeyKind,
  formatApnParcelKey,
  formatGeoParcelKey,
} from "../brokerageParcelKey";
import {
  COUNTY_APN_SOURCES,
  resolveCountyApnSource,
  resolveCountyApnByPoint,
} from "../brokerageParcelApn";

const mockResolveClip = vi.mocked(resolveCotalityClip);
const mockReadCreds = vi.mocked(readCotalityAppCredentials);
const mockGeocode = vi.mocked(geocodeAddress);
const mockPointQuery = vi.mocked(arcgisPointQuery);

/** Downtown Austin — inside the Travis routing bbox. */
const AUSTIN = { latitude: 30.2672, longitude: -97.7431 };
/** Houston — outside every supported county bbox. */
const HOUSTON = { latitude: 29.7604, longitude: -95.3698 };

function travisFeature(attributes: Record<string, unknown>) {
  return { features: [{ attributes }], raw: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockReadCreds.mockReturnValue(null);
  mockGeocode.mockResolvedValue(null as never);
});

describe("captureParcelKey — clip-paste (unchanged contract)", () => {
  it("returns the pasted CLIP as a bare key without touching any vendor", async () => {
    const result = await captureParcelKey({
      clip: "1234567890",
      address: "111 Congress Ave",
    });
    expect(result.parcelKey).toBe("1234567890");
    expect(result.keyKind).toBe("clip");
    expect(result.clip).toBe("1234567890");
    expect(result.source).toBe("clip-paste");
    expect(result.provenance.provider).toBe("user-paste");
    expect(mockResolveClip).not.toHaveBeenCalled();
    expect(mockPointQuery).not.toHaveBeenCalled();
  });
});

describe("captureParcelKey — precedence", () => {
  it("uses the CLIP resolver first when credentials are configured and it succeeds", async () => {
    mockReadCreds.mockReturnValue({ clientId: "id", clientSecret: "secret" });
    mockResolveClip.mockResolvedValue({
      clip: "9876543210",
      latitude: AUSTIN.latitude,
      longitude: AUSTIN.longitude,
      county: "Travis",
      raw: {},
    });
    const result = await captureParcelKey({
      address: "111 Congress Ave, Austin, TX",
      ...AUSTIN,
    });
    expect(result.parcelKey).toBe("9876543210");
    expect(result.keyKind).toBe("clip");
    expect(result.clip).toBe("9876543210");
    expect(result.provenance.provider).toBe("cotality");
    expect(mockPointQuery).not.toHaveBeenCalled();
  });

  it("skips the CLIP resolver entirely when credentials are absent", async () => {
    mockPointQuery.mockResolvedValue(travisFeature({ PROP_ID: "123456" }));
    const result = await captureParcelKey({
      address: "111 Congress Ave, Austin, TX",
      ...AUSTIN,
    });
    expect(mockResolveClip).not.toHaveBeenCalled();
    expect(result.parcelKey).toBe("apn:48453:123456");
    expect(result.keyKind).toBe("apn");
    expect(result.clip).toBeNull();
    expect(result.apn).toBe("123456");
    expect(result.countyFips).toBe("48453");
    expect(result.county).toBe("Travis");
    expect(result.provenance.provider).toBe("county-gis");
    expect(result.provenance.sourceUrl).toContain("gis.traviscountytx.gov");
    expect(result.provenance.retrievedAt).toBeTruthy();
  });
});

describe("captureParcelKey — Cotality failure path (the dark-vendor case)", () => {
  it("still captures an apn key when the CLIP resolver throws", async () => {
    mockReadCreds.mockReturnValue({ clientId: "id", clientSecret: "secret" });
    mockResolveClip.mockRejectedValue(new Error("oauth dead: invalid_client"));
    mockPointQuery.mockResolvedValue(travisFeature({ PROP_ID: "555001" }));
    const result = await captureParcelKey({
      address: "111 Congress Ave, Austin, TX",
      ...AUSTIN,
    });
    expect(result.parcelKey).toBe("apn:48453:555001");
    expect(result.keyKind).toBe("apn");
    expect(result.source).toBe("address-geocode");
  });

  it("falls back to the geo key when Cotality AND the county service both fail", async () => {
    mockReadCreds.mockReturnValue({ clientId: "id", clientSecret: "secret" });
    mockResolveClip.mockRejectedValue(new Error("oauth dead"));
    mockPointQuery.mockRejectedValue(new Error("county upstream 502"));
    const result = await captureParcelKey({
      address: "111 Congress Ave, Austin, TX",
      ...AUSTIN,
    });
    expect(result.parcelKey).toBe("geo:30.26720,-97.74310");
    expect(result.keyKind).toBe("geo");
    expect(result.clip).toBeNull();
    expect(result.apn).toBeNull();
    expect(result.provenance.provider).toBe("geocode");
  });

  it("captures coordinates-only input (no address) as a neutral key", async () => {
    // Pre-widening this ALWAYS threw: resolveCotalityClip requires a
    // street+city+state catalog address even before OAuth.
    mockPointQuery.mockResolvedValue(travisFeature({ PROP_ID: "777002" }));
    const result = await captureParcelKey({ ...AUSTIN });
    expect(result.parcelKey).toBe("apn:48453:777002");
    expect(result.source).toBe("coordinates");
    expect(mockResolveClip).not.toHaveBeenCalled();
  });

  it("geo key outside the supported counties, with no county query issued", async () => {
    const result = await captureParcelKey({ ...HOUSTON });
    expect(result.parcelKey).toBe("geo:29.76040,-95.36980");
    expect(result.keyKind).toBe("geo");
    expect(mockPointQuery).not.toHaveBeenCalled();
  });

  it("still throws when there is neither address nor coordinates (unchanged)", async () => {
    await expect(captureParcelKey({})).rejects.toThrow(
      "parcel_key_capture_requires_address_or_coordinates",
    );
  });
});

describe("county APN resolution", () => {
  it("routes Austin to Travis, San Antonio to Bexar, Houston to nothing", () => {
    expect(resolveCountyApnSource(AUSTIN.latitude, AUSTIN.longitude)?.fips).toBe(
      "48453",
    );
    expect(resolveCountyApnSource(29.4241, -98.4936)?.fips).toBe("48029");
    expect(
      resolveCountyApnSource(HOUSTON.latitude, HOUSTON.longitude),
    ).toBeNull();
  });

  it("reads numeric parcel ids and skips string NULL sentinels", async () => {
    mockPointQuery.mockResolvedValue(
      travisFeature({ PROP_ID: "NULL", geo_id: 445566 }),
    );
    const hit = await resolveCountyApnByPoint(AUSTIN);
    expect(hit).not.toBeNull();
    expect(hit!.apn).toBe("445566");
    expect(hit!.countyFips).toBe("48453");
  });

  it("returns null when the county returns no parcel at the point", async () => {
    mockPointQuery.mockResolvedValue({ features: [], raw: {} });
    const hit = await resolveCountyApnByPoint(AUSTIN);
    expect(hit).toBeNull();
  });

  it("covers the seven supported counties with distinct FIPS (five live-GIS + two txgio-store)", () => {
    expect(COUNTY_APN_SOURCES.map((c) => c.fips).sort()).toEqual([
      "48021",
      "48029",
      "48055",
      "48091", // Comal — self-hosted TxGIO store (no live county GIS)
      "48209", // Hays — self-hosted TxGIO store (no live county GIS)
      "48453",
      "48491",
    ]);
  });
});

describe("existing-key compatibility", () => {
  it("classifies stored bare CLIPs, apn keys, geo keys, and junk", () => {
    expect(parcelKeyKind("1234567890")).toBe("clip");
    expect(parcelKeyKind(formatApnParcelKey("48453", "123456"))).toBe("apn");
    expect(parcelKeyKind(formatGeoParcelKey(30.2672, -97.7431))).toBe("geo");
    expect(parcelKeyKind("not-a-key")).toBeNull();
    expect(parcelKeyKind("")).toBeNull();
  });

  it("mixed state: when a site-context CLIP outranks an apn capture, the kind follows the winning key", async () => {
    // Cotality is dark on the capture path (no credentials), so capture
    // falls through to the county-GIS apn key...
    mockPointQuery.mockResolvedValue(travisFeature({ PROP_ID: "999888" }));
    const captured = await captureParcelKey({
      address: "111 Congress Ave, Austin, TX",
      ...AUSTIN,
    });
    expect(captured.keyKind).toBe("apn");

    // ...but the site-context layers produced a CLIP (that rail was
    // alive). The brief route resolves the key with the CLIP winning;
    // the emitted kind must classify the WINNING key, never echo the
    // capture's own kind (a CLIP labeled "apn" is the defect).
    const siteContextClip: string | null = "1234567890";
    const parcelKey = siteContextClip ?? captured.parcelKey;
    expect(parcelKey).toBe("1234567890");
    expect(parcelKeyKind(parcelKey)).toBe("clip");
    expect(parcelKeyKind(parcelKey)).not.toBe(captured.keyKind);

    // Inverse mixed state: no site-context CLIP — the captured apn key
    // wins and classifies as "apn".
    const noClip: string | null = null;
    const fallbackKey = noClip ?? captured.parcelKey;
    expect(parcelKeyKind(fallbackKey)).toBe("apn");
  });

  it("keeps geo keys at 5 decimal places", () => {
    expect(formatGeoParcelKey(30.123456789, -97.987654321)).toBe(
      "geo:30.12346,-97.98765",
    );
  });
});
