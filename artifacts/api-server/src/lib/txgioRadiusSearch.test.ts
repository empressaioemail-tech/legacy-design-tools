import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    tileKey: "tile_key",
    situsAddress: "situs_address",
    geometry: "geometry",
    westLng: "west_lng",
    southLat: "south_lat",
    eastLng: "east_lng",
    northLat: "north_lat",
  },
  txCountyBoundary: {
    countyFips: "county_fips",
    westLng: "west_lng",
    southLat: "south_lat",
    eastLng: "east_lng",
    northLat: "north_lat",
  },
}));

const {
  RADIUS_SEARCH_CAP,
  RADIUS_SEARCH_CANDIDATE_CEILING,
  circleBbox,
  countiesOverlappingBbox,
  haversineFeet,
  pointToBboxDistanceFt,
  rankRadiusHits,
  searchParcelsByRadius,
  sliceRadiusHits,
} = await import("./txgioRadiusSearch");
const { cellKeysForBbox } = await import("@workspace/cad-ingest/txgio-geo");
const { texasCountyFipsList } = await import("./txgioAddressNormalize");
const src = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("./txgioRadiusSearch.ts", import.meta.url), "utf8"),
);

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

const HUNG_PT = { lat: 30.10592, lng: -97.32528 };

function mockRadiusDb(
  counties: string[],
  parcels: Array<{
    countyFips: string;
    propId: string;
    situsAddress: string | null;
    geometry: unknown;
    westLng: number;
    southLat: number;
    eastLng: number;
    northLat: number;
  }>,
) {
  return {
    select: () => ({
      from: (table: { propId?: unknown }) => ({
        where: () => {
          if (table.propId !== undefined) {
            return { limit: async () => parcels };
          }
          return Promise.resolve(counties.map((countyFips) => ({ countyFips })));
        },
      }),
    }),
  };
}

describe("countiesOverlappingBbox", () => {
  it("returns the trimmed FIPS the county query yielded", async () => {
    const db = mockRadiusDb(["48021", "48287"], []);
    const box = circleBbox(HUNG_PT.lat, HUNG_PT.lng, 500);
    await expect(countiesOverlappingBbox(box, db)).resolves.toEqual([
      "48021",
      "48287",
    ]);
  });
});

describe("searchParcelsByRadius county bound", () => {
  const inRange = {
    countyFips: "48021",
    propId: "34137",
    situsAddress: "908 PINE , BASTROP, TX 78602",
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [HUNG_PT.lng - 0.0002, HUNG_PT.lat - 0.0002],
          [HUNG_PT.lng + 0.0002, HUNG_PT.lat - 0.0002],
          [HUNG_PT.lng + 0.0002, HUNG_PT.lat + 0.0002],
          [HUNG_PT.lng - 0.0002, HUNG_PT.lat + 0.0002],
          [HUNG_PT.lng - 0.0002, HUNG_PT.lat - 0.0002],
        ],
      ],
    },
    westLng: HUNG_PT.lng - 0.0002,
    southLat: HUNG_PT.lat - 0.0002,
    eastLng: HUNG_PT.lng + 0.0002,
    northLat: HUNG_PT.lat + 0.0002,
  };

  it("returns hits when the county bound is one FIPS", async () => {
    const result = await searchParcelsByRadius({
      lat: HUNG_PT.lat,
      lng: HUNG_PT.lng,
      radiusFt: 500,
      database: mockRadiusDb(["48021"], [inRange]),
    });
    expect("refused" in result).toBe(false);
    if ("refused" in result) return;
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.parcelNodeId).toBe("48021:34137");
  });

  it("refuses when no county boundary overlaps rather than scanning 254", async () => {
    const result = await searchParcelsByRadius({
      lat: HUNG_PT.lat,
      lng: HUNG_PT.lng,
      radiusFt: 500,
      database: mockRadiusDb([], [inRange]),
    });
    expect(result).toMatchObject({
      refused: true,
      code: "radius_county_unresolved",
    });
  });

  it("refuses when the candidate ceiling is exceeded", async () => {
    const overflow = Array.from(
      { length: RADIUS_SEARCH_CANDIDATE_CEILING + 1 },
      (_, i) => ({ ...inRange, propId: String(i + 1) }),
    );
    const result = await searchParcelsByRadius({
      lat: HUNG_PT.lat,
      lng: HUNG_PT.lng,
      radiusFt: 500,
      database: mockRadiusDb(["48021"], overflow),
    });
    expect(result).toMatchObject({
      refused: true,
      code: "radius_unbounded",
    });
  });
});

describe("radius search does not use the 254-county IN list", () => {
  it("txgioRadiusSearch.ts no longer imports texasCountyFipsList", () => {
    expect(src).not.toMatch(/texasCountyFipsList/);
    expect(texasCountyFipsList()).toHaveLength(254);
  });

  it("50 ft and 500 ft at the hung point cover one cell, not a statewide scan", () => {
    for (const radiusFt of [50, 500]) {
      const box = circleBbox(HUNG_PT.lat, HUNG_PT.lng, radiusFt);
      const cells = cellKeysForBbox(box, undefined, 256);
      expect(cells).not.toBeNull();
      expect(cells!.length).toBe(1);
      expect(cells![0]).toBe("g0.02:-97.34000,30.10000");
    }
  });

  it("the 5280 ft ceiling still fits the tile-cell IN list", () => {
    const box = circleBbox(HUNG_PT.lat, HUNG_PT.lng, 5280);
    const cells = cellKeysForBbox(box, undefined, 256);
    expect(cells).not.toBeNull();
    expect(cells!.length).toBeGreaterThan(0);
    expect(cells!.length).toBeLessThanOrEqual(16);
  });
});
