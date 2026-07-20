/**
 * roads.ts tests — the F10 reliability fix: cache, retry/harden, and named-road
 * parsing. These are the reason the road tier now fires in prod instead of
 * being dark behind a starved Overpass call.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  fetchNearbyRoads,
  fetchNearestRoads,
  namedRoadsFromOverpass,
  roadPolylinesFromOverpass,
  _clearRoadCache,
  type FetchLike,
} from "./roads";

/** Build a fake Overpass 200/JSON response for the given ways. */
function overpassJson(
  ways: { name?: string; highway?: string; geom: [number, number][] }[],
): Response {
  const elements = ways.map((w) => ({
    type: "way",
    tags: {
      ...(w.name ? { name: w.name } : {}),
      highway: w.highway ?? "residential",
    },
    geometry: w.geom.map(([lon, lat]) => ({ lat, lon })),
  }));
  return new Response(JSON.stringify({ elements }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const SAMPLE_WAYS = [
  // Longer way (through street) — 4 pts.
  {
    name: "Center Street",
    geom: [
      [-97.8, 30.0],
      [-97.799, 30.0],
      [-97.798, 30.0],
      [-97.797, 30.0],
    ] as [number, number][],
  },
  // Shorter way (cul-de-sac) — 2 pts.
  {
    name: "Nolan Drive",
    geom: [
      [-97.8005, 30.0005],
      [-97.8003, 30.0006],
    ] as [number, number][],
  },
];

describe("namedRoadsFromOverpass", () => {
  it("parses ways into named roads, longest first, surfacing the name tag", () => {
    const json = { elements: overpassElements(SAMPLE_WAYS) };
    const roads = namedRoadsFromOverpass(json.elements);
    expect(roads).toHaveLength(2);
    // Longest first.
    expect(roads[0]!.name).toBe("Center Street");
    expect(roads[1]!.name).toBe("Nolan Drive");
    expect(roads[0]!.polyline.length).toBeGreaterThanOrEqual(2);
  });

  it("drops non-way / degenerate elements and untagged names -> null", () => {
    const els = [
      { type: "node", geometry: [{ lat: 30, lon: -97 }] },
      { type: "way", geometry: [{ lat: 30, lon: -97 }] }, // 1 pt -> dropped
      {
        type: "way",
        tags: { highway: "service" },
        geometry: [
          { lat: 30, lon: -97 },
          { lat: 30.001, lon: -97 },
        ],
      },
    ];
    const roads = namedRoadsFromOverpass(els);
    expect(roads).toHaveLength(1);
    expect(roads[0]!.name).toBeNull();
    expect(roads[0]!.highway).toBe("service");
  });

  it("roadPolylinesFromOverpass stays back-compat (bare polylines)", () => {
    const lines = roadPolylinesFromOverpass(overpassElements(SAMPLE_WAYS));
    expect(lines).toHaveLength(2);
    expect(Array.isArray(lines[0])).toBe(true);
    expect(lines[0]![0]!.length).toBe(2); // [lng, lat]
  });
});

function overpassElements(
  ways: { name?: string; highway?: string; geom: [number, number][] }[],
) {
  return ways.map((w) => ({
    type: "way",
    tags: {
      ...(w.name ? { name: w.name } : {}),
      highway: w.highway ?? "residential",
    },
    geometry: w.geom.map(([lon, lat]) => ({ lat, lon })),
  }));
}

describe("fetchNearbyRoads — hardening (retry) + cache", () => {
  beforeEach(() => _clearRoadCache());

  it("returns named roads on a clean 200", async () => {
    const fetchImpl: FetchLike = vi.fn(async () => overpassJson(SAMPLE_WAYS));
    const roads = await fetchNearbyRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(roads.map((r) => r.name)).toContain("Nolan Drive");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries ONCE on a 504 busy-server response, then succeeds", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response("<html>too busy</html>", { status: 504 }),
      )
      .mockResolvedValueOnce(overpassJson(SAMPLE_WAYS));
    const roads = await fetchNearbyRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(roads.length).toBe(2);
  });

  it("retries on a 200-with-HTML (non-JSON) busy body", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        new Response("<html>server too busy</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(overpassJson(SAMPLE_WAYS));
    const roads = await fetchNearbyRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(roads.length).toBe(2);
  });

  it("returns [] (never throws) when BOTH attempts fail", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockRejectedValue(new Error("network down"));
    const roads = await fetchNearbyRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one retry
    expect(roads).toEqual([]);
  });

  it("does NOT retry a terminal 400 (non-retryable)", async () => {
    const fetchImpl = vi
      .fn<FetchLike>()
      .mockResolvedValue(new Response("bad", { status: 400 }));
    const roads = await fetchNearbyRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(roads).toEqual([]);
  });

  it("caches: a second nearby request within the tile hits warm (no fetch)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => overpassJson(SAMPLE_WAYS));
    const a = await fetchNearbyRoads({ lat: 30.0, lng: -97.8, fetchImpl });
    // Second call at a coordinate rounding to the SAME tile: served from cache.
    const b = await fetchNearbyRoads({
      lat: 30.00002,
      lng: -97.80003,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(b.length).toBe(a.length);
  });

  it("cache misses for a far-away tile (fetches again)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => overpassJson(SAMPLE_WAYS));
    await fetchNearbyRoads({ lat: 30.0, lng: -97.8, fetchImpl });
    await fetchNearbyRoads({ lat: 31.5, lng: -96.0, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bad coords resolve to [] without fetching", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => overpassJson(SAMPLE_WAYS));
    const roads = await fetchNearbyRoads({
      lat: Number.NaN,
      lng: -97.8,
      fetchImpl,
    });
    expect(roads).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetchNearestRoads back-compat returns bare polylines", async () => {
    _clearRoadCache();
    const fetchImpl = vi.fn<FetchLike>(async () => overpassJson(SAMPLE_WAYS));
    const lines = await fetchNearestRoads({
      lat: 30.0,
      lng: -97.8,
      fetchImpl,
      noCache: true,
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]![0]!.length).toBe(2);
  });

  it("sends a urlencoded data= body (well-formed POST)", async () => {
    let capturedBody: string | undefined;
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      capturedBody = init?.body as string;
      return overpassJson(SAMPLE_WAYS);
    });
    await fetchNearbyRoads({ lat: 30.0, lng: -97.8, fetchImpl, noCache: true });
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.startsWith("data=")).toBe(true);
    // The around query with the coords is present, urlencoded.
    expect(decodeURIComponent(capturedBody!)).toContain("way(around:");
    expect(decodeURIComponent(capturedBody!)).toContain("30");
  });
});
