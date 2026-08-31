import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    situsAddress: "situs_address",
    situsCity: "situs_city",
    situsState: "situs_state",
    situsZip: "situs_zip",
  },
}));

const {
  STREET_SEARCH_CAP,
  searchParcelsByBareStreet,
  sliceStreetHits,
} = await import("./txgioStreetSearch");
const {
  normalizeBareStreetLine,
  situsSearchBareStreetVariants,
} = await import("./txgioAddressNormalize");

describe("normalizeBareStreetLine", () => {
  it("canonicalizes a bare street and rejects a house-numbered query", () => {
    expect(normalizeBareStreetLine("Pine St")).toBe("PINE ST");
    expect(normalizeBareStreetLine("Pine Street, Bastrop, TX")).toBe("PINE ST");
    expect(normalizeBareStreetLine("908 Pine St")).toBeNull();
    expect(normalizeBareStreetLine("ST")).toBeNull();
  });
});

describe("situsSearchBareStreetVariants", () => {
  it("keeps the type-stripped form so PINE ST hits 908 PINE", () => {
    expect(situsSearchBareStreetVariants("Pine St")).toEqual(["PINE ST", "PINE"]);
  });
});

describe("sliceStreetHits truncation", () => {
  function hits(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      parcelNodeId: `48021:${i + 1}`,
      situsAddress: `${i} PINE ST`,
      countyFips: "48021",
    }));
  }

  it("declares truncation when the set exceeds cap", () => {
    const sliced = sliceStreetHits(hits(STREET_SEARCH_CAP + 1), STREET_SEARCH_CAP);
    expect(sliced.hits).toHaveLength(STREET_SEARCH_CAP);
    expect(sliced.truncated).toBe(true);
  });
});

describe("searchParcelsByBareStreet refuse", () => {
  function mockDb(rows: unknown[]) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    };
  }

  it("refuses a house-numbered query", async () => {
    const result = await searchParcelsByBareStreet({
      query: "908 Pine St, Bastrop, TX",
      database: mockDb([]) as never,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "bare_street_not_a_street",
    });
  });

  it("refuses an unbounded bare street", async () => {
    const result = await searchParcelsByBareStreet({
      query: "Pine St",
      database: mockDb([]) as never,
    });
    expect(result).toMatchObject({
      refused: true,
      code: "bare_street_unbounded",
    });
  });

  it("returns hits and declares truncation when over cap", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      countyFips: "48021",
      propId: String(34137 + i),
      situsAddress: `${900 + i} PINE ST, BASTROP, TX 78602`,
    }));
    const result = await searchParcelsByBareStreet({
      query: "Pine St, Bastrop, TX",
      cap: 2,
      database: mockDb(rows) as never,
    });
    expect("refused" in result).toBe(false);
    if ("refused" in result) return;
    expect(result.cap).toBe(2);
    expect(result.hits).toHaveLength(2);
    expect(result.received).toBe(2);
    expect(result.truncated).toBe(true);
  });
});
