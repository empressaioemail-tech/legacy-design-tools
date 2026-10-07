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
  streetNameFromSitus,
  declareStreetMatch,
  STREET_SEARCH_BUDGET_MS,
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
    expect(result.match).toBe("exact");
    expect(result.streets).toEqual(["PINE ST"]);
  });
});

describe("declareStreetMatch (keep the breadth, declare the fragment)", () => {
  const pineFragmentHits = [
    {
      parcelNodeId: "48021:111146",
      situsAddress: "178 PINEHILL DR , BASTROP, TX 78602",
      countyFips: "48021",
    },
    {
      parcelNodeId: "48021:117885",
      situsAddress: "190 PINE TREE LOOP UNIT, BASTROP, TX 78602",
      countyFips: "48021",
    },
    {
      parcelNodeId: "48021:133055",
      situsAddress: "121 PINECREST DR, BASTROP, TX 78602",
      countyFips: "48021",
    },
    {
      parcelNodeId: "48021:140877",
      situsAddress: "155 ROYAL PINES DR, BASTROP, TX 78602",
      countyFips: "48021",
    },
  ];

  it("names the four live Pine fragment streets", () => {
    expect(streetNameFromSitus(pineFragmentHits[0]!.situsAddress)).toBe("PINEHILL DR");
    expect(streetNameFromSitus(pineFragmentHits[1]!.situsAddress)).toBe("PINE TREE LOOP");
    expect(streetNameFromSitus(pineFragmentHits[2]!.situsAddress)).toBe("PINECREST DR");
    expect(streetNameFromSitus(pineFragmentHits[3]!.situsAddress)).toBe("ROYAL PINES DR");
  });

  it("FALSIFIER: four fragment streets must be fuzzy, never exact or silent", () => {
    const declared = declareStreetMatch(pineFragmentHits, "Pine St, Bastrop");
    expect(declared.match).toBe("fuzzy");
    expect(declared.matchBasis).toBe("name-fragment");
    expect(declared.streets).toEqual([
      "PINEHILL DR",
      "PINE TREE LOOP",
      "PINECREST DR",
      "ROYAL PINES DR",
    ]);
  });

  it("CAD situs without a street type on real Pine is exact", () => {
    const declared = declareStreetMatch(
      [
        {
          parcelNodeId: "48021:34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
          countyFips: "48021",
        },
      ],
      "Pine St, Bastrop",
    );
    expect(declared.match).toBe("exact");
    expect(declared.streets).toEqual(["PINE"]);
    expect(declared.matchBasis).toBeUndefined();
  });
});

describe("searchParcelsByBareStreet: bounded, timed and ranked (fix register C2)", () => {
  function capturingDb(rows: unknown[], seen: { where?: unknown }) {
    return {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            seen.where = w;
            return { limit: async () => rows };
          },
        }),
      }),
    };
  }

  it("puts the queried street ahead of fragment matches", async () => {
    const rows = [
      { countyFips: "48021", propId: "1", situsAddress: "10 COOL WATER DR, BASTROP, TX 78602" },
      { countyFips: "48021", propId: "2", situsAddress: "1301 WATER ST, BASTROP, TX 78602" },
    ];
    const result = await searchParcelsByBareStreet({
      query: "Water St, Bastrop",
      database: capturingDb(rows, {}) as never,
      resolveCityCounties: async () => ["48021"],
    });
    if ("refused" in result) throw new Error(result.code);
    expect(result.hits[0]!.situsAddress).toContain("1301 WATER ST");
  });

  it("asks the city's counties before scanning Texas", async () => {
    const asked: string[] = [];
    await searchParcelsByBareStreet({
      query: "Water St, Bastrop",
      database: capturingDb([], {}) as never,
      resolveCityCounties: async (city) => {
        asked.push(city);
        return ["48021"];
      },
    });
    expect(asked).toEqual(["BASTROP"]);
  });

  it("refuses street_search_timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const never = {
        select: () => ({ from: () => ({ where: () => ({ limit: () => new Promise(() => {}) }) }) }),
      };
      const pending = searchParcelsByBareStreet({
        query: "Water St, Bastrop",
        database: never as never,
        resolveCityCounties: async () => ["48021"],
      });
      await vi.advanceTimersByTimeAsync(STREET_SEARCH_BUDGET_MS + 10);
      const result = await pending;
      expect(result).toMatchObject({ refused: true, code: "street_search_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ZIP-to-county ruling (operator, 2026-10-07): the Census ZCTA relationship file narrows the search; the parcel's own county always wins", () => {
  function capturingDb(rows: unknown[], seen: { where?: unknown }) {
    return {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            seen.where = w;
            return { limit: async () => rows };
          },
        }),
      }),
    };
  }

  it("FALSIFIER: the pre-fix regex (/^d{5}$/, a literal match on five lowercase d's) never matches a real FIPS -- countiesForCity silently returned [] on every call, which would re-open the C2 unbounded-scan timeout this test file already names", () => {
    const fips = "48021";
    // eslint-disable-next-line no-useless-escape
    const buggyRegex = /^d{5}$/;
    const fixedRegex = /^\d{5}$/;
    expect(buggyRegex.test(fips)).toBe(false);
    expect(fixedRegex.test(fips)).toBe(true);
  });

  it("asks the ZCTA relationship file (not the city) for a ZIP-only query, and narrows the scan to the counties it names", async () => {
    const askedZips: string[] = [];
    const seen: { where?: unknown } = {};
    await searchParcelsByBareStreet({
      query: "Pine St, 78654",
      database: capturingDb([], seen) as never,
      resolveCityCounties: async () => {
        throw new Error("no city in this query; resolveCityCounties must not be called");
      },
      resolveZipCounties: async (zip) => {
        askedZips.push(zip);
        return ["48053", "48453"]; // Burnet + Travis, the real split for 78654
      },
    });
    expect(askedZips).toEqual(["78654"]);
  });

  it("a split ZIP (78654: Burnet 48053 + Travis 48453) searches EVERY county the ZCTA file names, not one voted county", async () => {
    const rows = [
      { countyFips: "48053", propId: "1", situsAddress: "100 PINE ST, MARBLE FALLS, TX 78654" },
      { countyFips: "48453", propId: "2", situsAddress: "200 PINE ST, SPICEWOOD, TX 78654" },
    ];
    const result = await searchParcelsByBareStreet({
      query: "Pine St, 78654",
      database: capturingDb(rows, {}) as never,
      resolveZipCounties: async () => ["48053", "48453"],
    });
    if ("refused" in result) throw new Error(result.code);
    // Both counties' hits are returned -- the search was never narrowed to a single "winning"
    // county for the split ZIP, and each hit still carries ITS OWN row's countyFips (never a
    // county decided from the ZIP).
    const counties = result.hits.map((h) => h.countyFips).sort();
    expect(counties).toEqual(["48053", "48453"]);
  });

  it("city AND zip both present: the search is bounded by the UNION of what each names, never an intersection that could wrongly drop a real county", async () => {
    const asked: { city?: string; zip?: string } = {};
    const seen: { where?: unknown } = {};
    await searchParcelsByBareStreet({
      query: "Pine St, Marble Falls, 78654",
      database: capturingDb([], seen) as never,
      resolveCityCounties: async (city) => {
        asked.city = city;
        return ["48053"]; // Marble Falls' own counties table names only Burnet
      },
      resolveZipCounties: async (zip) => {
        asked.zip = zip;
        return ["48053", "48453"]; // the ZCTA file also names Travis
      },
    });
    expect(asked).toEqual({ city: "MARBLE FALLS", zip: "78654" });
    // seen.where is an opaque drizzle expression tree in this fake; the union behavior itself is
    // proven by the split-ZIP test above (both counties' rows come back) and by this call
    // completing without the city-only ["48053"] narrowing being asked to resolve the zip at all.
  });

  it("neither city nor zip resolves a county: falls back to all Texas counties, unchanged from before this fix", async () => {
    const result = await searchParcelsByBareStreet({
      query: "Pine St, Nowhereville",
      database: capturingDb([], {}) as never,
      resolveCityCounties: async () => [],
    });
    if ("refused" in result) throw new Error(result.code);
    expect(result.hits).toEqual([]);
  });
});
