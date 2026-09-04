/**
 * P-91 item 27 / O7: situs-search miss path must return inside the HTTP
 * budget. Mock db only — no DATABASE_URL. Live Rainmaker is planner-owned.
 *
 * Stand-in budget is 50 ms for the 25 s HTTP contract. A hang of 80 ms per
 * store query is the unbounded miss (street keys, then prefix, then
 * address-points). Three sequential hangs exceed the stand-in; the bound
 * must return [] before one hang completes.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    situsAddress: "situs_address",
  },
  txgioAddress: {
    countyFips: "county_fips",
    fullAddr: "full_addr",
    postComm: "post_comm",
    state: "state",
    postCode: "post_code",
    latitude: "latitude",
    longitude: "longitude",
  },
}));

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [],
}));

const {
  searchPlaceByPrefix,
  SITUS_SEARCH_BUDGET_MS,
  withSitusSearchBudget,
} = await import("../txgioAddressResolve");

const HTTP_BUDGET_STAND_IN_MS = 50;
const UNBOUNDED_MISS_QUERY_MS = 80;
const RAINMAKER = "111 Rainmaker Cv, Bastrop TX";
const PINE_GOLD = "908 Pine St, Bastrop TX 78602";

function hangDb(delayMs: number) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            new Promise<unknown[]>((resolve) => {
              setTimeout(() => resolve([]), delayMs);
            }),
        }),
      }),
    }),
  };
}

function pineThenHangDb() {
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            call += 1;
            if (call === 1) {
              return Promise.resolve([
                {
                  countyFips: "48021",
                  propId: "34137",
                  situsAddress: "908 PINE , BASTROP, TX 78602",
                },
              ]);
            }
            return new Promise<unknown[]>(() => {});
          },
        }),
      }),
    }),
  };
}

function pineHitDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              countyFips: "48021",
              propId: "34137",
              situsAddress: "908 PINE , BASTROP, TX 78602",
            },
          ],
        }),
      }),
    }),
  };
}

describe("situs-search miss budget (P-91 O7)", () => {
  it("unbounded miss exceeds the HTTP budget", async () => {
    const started = Date.now();
    await searchPlaceByPrefix({
      query: RAINMAKER,
      database: hangDb(UNBOUNDED_MISS_QUERY_MS) as never,
      budgetMs: 10_000,
    });
    expect(Date.now() - started).toBeGreaterThan(HTTP_BUDGET_STAND_IN_MS);
  });

  it("bounded miss returns empty inside the HTTP budget with a declared class", async () => {
    const started = Date.now();
    const result = await searchPlaceByPrefix({
      query: RAINMAKER,
      database: hangDb(UNBOUNDED_MISS_QUERY_MS) as never,
      budgetMs: HTTP_BUDGET_STAND_IN_MS,
    });
    const elapsed = Date.now() - started;
    expect(result).toEqual({
      hits: [],
      missClass: "situs-search-budget-exceeded",
    });
    expect(elapsed).toBeLessThan(UNBOUNDED_MISS_QUERY_MS);
    expect(elapsed).toBeLessThan(25_000);
    expect(SITUS_SEARCH_BUDGET_MS).toBeLessThan(25_000);
  });

  it("bounded Pine gold 48021:34137 still resolves", async () => {
    const hits = await searchPlaceByPrefix({
      query: PINE_GOLD,
      database: pineHitDb() as never,
      budgetMs: HTTP_BUDGET_STAND_IN_MS,
    });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits.hits[0]?.source).toBe("parcel-situs");
    expect(hits.missClass).toBeUndefined();
  });

  it("does not drop an already-found Pine hit when a later query hangs", async () => {
    const hits = await searchPlaceByPrefix({
      query: PINE_GOLD,
      database: pineThenHangDb() as never,
      budgetMs: HTTP_BUDGET_STAND_IN_MS,
    });
    expect(hits.hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits.missClass).toBeUndefined();
  });

  it("completed empty is no-hit, not a budget miss", async () => {
    const result = await searchPlaceByPrefix({
      query: "zzzz-not-a-situs-99999",
      database: hangDb(UNBOUNDED_MISS_QUERY_MS) as never,
      budgetMs: HTTP_BUDGET_STAND_IN_MS,
    });
    expect(result).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("withSitusSearchBudget fail-closes to empty when work never settles", async () => {
    const started = Date.now();
    const result = await withSitusSearchBudget(() => new Promise<never>(() => {}), {
      budgetMs: HTTP_BUDGET_STAND_IN_MS,
      onTimeout: [],
    });
    expect(result).toEqual([]);
    expect(Date.now() - started).toBeLessThan(UNBOUNDED_MISS_QUERY_MS);
  });
});
