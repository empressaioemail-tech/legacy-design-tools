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

function nominatimHit(lat: string, lon: string, city: string, state: string) {
  return [
    {
      lat,
      lon,
      display_name: `${city}, ${state}`,
      address: { town: city, state },
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
