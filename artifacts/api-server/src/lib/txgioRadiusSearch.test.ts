import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    situsAddress: "situs_address",
    geometry: "geometry",
    westLng: "west_lng",
    southLat: "south_lat",
    eastLng: "east_lng",
    northLat: "north_lat",
  },
}));

const {
  RADIUS_SEARCH_CAP,
  circleBbox,
  haversineFeet,
  pointToBboxDistanceFt,
  rankRadiusHits,
  sliceRadiusHits,
} = await import("./txgioRadiusSearch");

const GOLD_PT = { lat: 30.10981, lng: -97.31654 };

describe("haversineFeet", () => {
  it("is zero at the same point", () => {
    expect(haversineFeet(GOLD_PT.lat, GOLD_PT.lng, GOLD_PT.lat, GOLD_PT.lng)).toBe(0);
  });

  it("is about 364000 feet per degree of latitude", () => {
    const ft = haversineFeet(30, -97, 31, -97);
    expect(ft).toBeGreaterThan(360000);
    expect(ft).toBeLessThan(370000);
  });
});

describe("pointToBboxDistanceFt", () => {
  it("is zero when the point is inside the bbox", () => {
    expect(
      pointToBboxDistanceFt(30.11, -97.316, {
        westLng: -97.32,
        southLat: 30.10,
        eastLng: -97.31,
        northLat: 30.12,
      }),
    ).toBe(0);
  });
});

describe("circleBbox", () => {
  it("contains the centre", () => {
    const box = circleBbox(GOLD_PT.lat, GOLD_PT.lng, 500);
    expect(box.westLng).toBeLessThan(GOLD_PT.lng);
    expect(box.eastLng).toBeGreaterThan(GOLD_PT.lng);
    expect(box.southLat).toBeLessThan(GOLD_PT.lat);
    expect(box.northLat).toBeGreaterThan(GOLD_PT.lat);
  });
});

describe("sliceRadiusHits truncation", () => {
  function hits(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      parcelNodeId: `48021:${i + 1}`,
      situsAddress: null,
      countyFips: "48021",
      distanceFt: i,
    }));
  }

  it("declares truncation when ranked length exceeds cap", () => {
    const sliced = sliceRadiusHits(hits(RADIUS_SEARCH_CAP + 1), RADIUS_SEARCH_CAP);
    expect(sliced.hits).toHaveLength(RADIUS_SEARCH_CAP);
    expect(sliced.truncated).toBe(true);
  });

  it("does not declare truncation when the set fits", () => {
    const sliced = sliceRadiusHits(hits(3), RADIUS_SEARCH_CAP);
    expect(sliced.hits).toHaveLength(3);
    expect(sliced.truncated).toBe(false);
  });

  it("the silent-first-N shape is the failing fixture: cap hits without truncated", () => {
    const ranked = hits(RADIUS_SEARCH_CAP + 1);
    const silent = ranked.slice(0, RADIUS_SEARCH_CAP);
    expect(silent).toHaveLength(RADIUS_SEARCH_CAP);
    expect(silent.length === RADIUS_SEARCH_CAP && ranked.length > RADIUS_SEARCH_CAP).toBe(
      true,
    );
    const honest = sliceRadiusHits(ranked, RADIUS_SEARCH_CAP);
    expect(honest.truncated).toBe(true);
  });
});

describe("rankRadiusHits", () => {
  const square = {
    type: "Polygon" as const,
    coordinates: [
      [
        [-97.317, 30.109],
        [-97.316, 30.109],
        [-97.316, 30.110],
        [-97.317, 30.110],
        [-97.317, 30.109],
      ],
    ],
  };

  it("dedupes tile copies and keeps the nearer distance", () => {
    const ranked = rankRadiusHits(
      [
        {
          countyFips: "48021",
          propId: "34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
          geometry: square,
          westLng: -97.317,
          southLat: 30.109,
          eastLng: -97.316,
          northLat: 30.110,
        },
        {
          countyFips: "48021",
          propId: "34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
          geometry: square,
          westLng: -97.317,
          southLat: 30.109,
          eastLng: -97.316,
          northLat: 30.110,
        },
      ],
      GOLD_PT.lat,
      GOLD_PT.lng,
      500,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.parcelNodeId).toBe("48021:34137");
    expect(ranked[0]?.distanceFt).toBe(0);
  });
});
