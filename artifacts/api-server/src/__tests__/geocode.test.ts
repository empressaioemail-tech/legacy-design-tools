/**
 * P0-2 — the hardened geocoder.
 *
 * `geocodeAddress` (lib/site-context/src/server/geocode.ts) is the single
 * geocode primitive behind the PATCH-address handler, the manual
 * re-geocode route, the snapshot-create warmup, and the generate-layers
 * self-heal. The verified P0-2 failure was a single Nominatim free-text
 * query that missed a rural street address and gave up — leaving the
 * engagement with no coordinates and the whole site-context loop
 * dead-ended. These tests pin the broaden-on-miss ladder and the
 * error/miss semantics that recovery depends on.
 *
 * `fetch` is stubbed so no test touches the real Nominatim service.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildQueryLadder, geocodeAddress } from "@workspace/site-context/server";

/**
 * A house-grade answer, as Nominatim returns for a house-number query.
 * `effectiveMatchRung` only keeps a street query's "street" claim when the
 * ANSWER is house-grade, so the fixture carries the fields that decide it
 * (`class`/`type`/`address.house_number`).
 */
function nominatimHit(lat: string, lon: string, city: string, state: string) {
  return [
    {
      lat,
      lon,
      display_name: `1144, North Kayenta Drive, ${city}, ${state}`,
      class: "place",
      type: "house",
      address: {
        house_number: "1144",
        road: "North Kayenta Drive",
        town: city,
        state,
      },
    },
  ];
}

function fakeResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe("buildQueryLadder", () => {
  it("walks a multi-line US address full → city/ZIP line → bare ZIP", () => {
    expect(buildQueryLadder("1144 NORTH KAYENTA DR\nMoab UT 84532")).toEqual([
      "1144 NORTH KAYENTA DR Moab UT 84532",
      "Moab UT 84532",
      "84532, USA",
    ]);
  });

  it("collapses tabs / runs of whitespace in the full-address rung", () => {
    const ladder = buildQueryLadder("123\t Main   St\nBastrop  TX 78602");
    expect(ladder[0]).toBe("123 Main St Bastrop TX 78602");
  });

  it("a single-line address still yields a bare-ZIP fallback rung", () => {
    expect(buildQueryLadder("Moab, UT 84532")).toEqual([
      "Moab, UT 84532",
      "84532, USA",
    ]);
  });

  it("an address with no ZIP yields just the full rung", () => {
    expect(buildQueryLadder("Moab, UT")).toEqual(["Moab, UT"]);
  });

  it("de-duplicates identical rungs", () => {
    // full == last line == "84532" — no duplicate rungs.
    expect(buildQueryLadder("84532")).toEqual(["84532", "84532, USA"]);
  });

  it("returns an empty ladder for a blank address", () => {
    expect(buildQueryLadder("   \n  ")).toEqual([]);
  });
});

describe("geocodeAddress", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the first rung's hit without walking the ladder", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse(nominatimHit("38.5", "-109.5", "Moab", "Utah")),
    );
    const geo = await geocodeAddress("1144 N Kayenta Dr\nMoab UT 84532");
    expect(geo).not.toBeNull();
    expect(geo!.latitude).toBe(38.5);
    expect(geo!.longitude).toBe(-109.5);
    expect(geo!.jurisdictionCity).toBe("Moab");
    // The house-number street rung is rooftop-grade (F4d).
    expect(geo!.matchRung).toBe("street");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the city/ZIP rung when the street rung misses", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse([])) // street miss
      .mockResolvedValueOnce(
        fakeResponse(nominatimHit("38.57", "-109.55", "Moab", "Utah")),
      ); // city hit
    const geo = await geocodeAddress("1144 N Kayenta Dr\nMoab UT 84532");
    expect(geo).not.toBeNull();
    expect(geo!.latitude).toBe(38.57);
    // The centroid rung is NOT rooftop — it must be tagged as such so a
    // consumer never treats it like a precise point (the F4d bug).
    expect(geo!.matchRung).toBe("locality");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("tags a bare-ZIP-rung hit as 'zip' (coarsest, never rooftop)", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse([])) // street miss
      .mockResolvedValueOnce(fakeResponse([])) // city miss
      .mockResolvedValueOnce(
        fakeResponse(nominatimHit("38.6", "-109.6", "Moab", "Utah")),
      ); // zip centroid hit
    const geo = await geocodeAddress("1144 N Kayenta Dr\nMoab UT 84532");
    expect(geo).not.toBeNull();
    expect(geo!.matchRung).toBe("zip");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 15_000);

  it("re-labels a street-rung hit Nominatim answered with the ZIP centroid (P-393)", async () => {
    // The measured 2026-09-21 case: "8459 ROCK CREEK RD, WACO, TX 76708"
    // came back as the 76708 POSTCODE node. The query's shape says "street";
    // the answer is a ZIP centroid ~3.5 km from the parcel, and stamping it
    // "street" is what let it become the front-edge reference.
    fetchMock.mockResolvedValueOnce(
      fakeResponse([
        {
          lat: "31.58903",
          lon: "-97.18525",
          display_name: "76708, Waco, McLennan County, Texas, United States",
          class: "place",
          type: "postcode",
          address: { postcode: "76708", city: "Waco", state: "Texas" },
        },
      ]),
    );
    const geo = await geocodeAddress("1144 N Kayenta Dr\nWaco TX 76708");
    expect(geo).not.toBeNull();
    // The coordinates are still whatever the ladder's first hit gave...
    expect(geo!.latitude).toBeCloseTo(31.58903, 5);
    // ...but the rung now reports the answer's own precision, so the
    // consumer's geocode-centroid gate can fire instead of trusting it.
    expect(geo!.matchRung).toBe("zip");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-labels a street-rung hit that came back locality-grade", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse([
        {
          lat: "31.55451",
          lon: "-97.13256",
          display_name: "Waco, McLennan County, Texas, United States",
          class: "boundary",
          type: "administrative",
          address: { city: "Waco", state: "Texas" },
        },
      ]),
    );
    const geo = await geocodeAddress("1144 N Kayenta Dr\nWaco TX 76708");
    expect(geo!.matchRung).toBe("locality");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps 'street' when the answer is the street the query named (road class)", async () => {
    // Measured 2026-09-20: 4 of the 33 corpus addresses get a road-class
    // answer on the street rung. That is a street match, not a centroid —
    // it must not be downgraded into a decline.
    fetchMock.mockResolvedValueOnce(
      fakeResponse([
        {
          lat: "29.88795",
          lon: "-97.87044",
          display_name: "Airport Drive, San Marcos, Caldwell County, Texas",
          class: "highway",
          type: "unclassified",
          address: { road: "Airport Drive", town: "San Marcos", state: "Texas" },
        },
      ]),
    );
    const geo = await geocodeAddress("1825 AIRPORT DR\nSAN MARCOS TX 78656");
    expect(geo!.matchRung).toBe("street");
  });

  it("keeps 'street' when the answer carries a house number (no class/type needed)", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse([
        {
          lat: "31.62991",
          lon: "-97.19727",
          display_name: "8459, Rock Creek Road, Waco, Texas, United States",
          address: {
            house_number: "8459",
            road: "Rock Creek Road",
            city: "Waco",
            state: "Texas",
            postcode: "76708",
          },
        },
      ]),
    );
    const geo = await geocodeAddress("8459 ROCK CREEK RD\nWACO TX 76708");
    expect(geo!.matchRung).toBe("street");
  });

  it("returns null when every rung is a clean miss", async () => {
    fetchMock.mockResolvedValue(fakeResponse([]));
    const geo = await geocodeAddress("1 Nowhere Rd\nVoid UT 00000");
    expect(geo).toBeNull();
  }, 15_000);

  it("recovers from an upstream error on an earlier rung", async () => {
    fetchMock
      .mockResolvedValueOnce(fakeResponse(null, false, 503)) // street errors
      .mockResolvedValueOnce(
        fakeResponse(nominatimHit("38.57", "-109.55", "Moab", "Utah")),
      );
    const geo = await geocodeAddress("1144 N Kayenta Dr\nMoab UT 84532");
    expect(geo).not.toBeNull();
    expect(geo!.latitude).toBe(38.57);
  }, 15_000);

  it("throws only when every rung errors (service unavailable)", async () => {
    fetchMock.mockResolvedValue(fakeResponse(null, false, 503));
    await expect(
      geocodeAddress("1144 N Kayenta Dr\nMoab UT 84532"),
    ).rejects.toThrow(/HTTP 503/);
  }, 15_000);
});
