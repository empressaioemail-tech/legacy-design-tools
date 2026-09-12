/**
 * B1 guard: when find_parcel / situs-search receives a full address with
 * city/state/ZIP, prefix ILIKE must not return a homonym street in another
 * county. Mock db only — no DATABASE_URL.
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
  // Live registry tags Bastrop as ArcGIS, not txgio-store. Search must
  // not fail-closed when this list is empty or omits 48021.
  allStoreCounties: () => [],
}));

const { searchPlaceByPrefix } = await import("../txgioAddressResolve");

describe("searchPlaceByPrefix locality filter (B1)", () => {
  function mockDb(parcelRows: unknown[], addressRows: unknown[] = []) {
    let call = 0;
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              call += 1;
              // 1: street-key situs; 2+: prefix situs / address-point.
              return call === 1 ? parcelRows : addressRows;
            },
          }),
        }),
      }),
    };
  }

  it("returns Bastrop 908 Pine when city/ZIP constrain the query", async () => {
    const hits = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop TX 78602",
      database: mockDb([
        {
          countyFips: "48491",
          propId: "999999",
          situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
        },
        {
          countyFips: "48021",
          propId: "34137",
          situsAddress: "908 PINE ST, BASTROP, TX 78602",
        },
      ]) as never,
    });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits.hits[0]?.situsAddress).toContain("BASTROP");
    expect(hits.missClass).toBeUndefined();
  });

  it("returns gold 48021:34137 on the exact-key path when CAD omits ST", async () => {
    const hits = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop TX 78602",
      database: mockDb([
        {
          countyFips: "48491",
          propId: "999999",
          situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
        },
        {
          countyFips: "48021",
          propId: "34137",
          situsAddress: "908 PINE , BASTROP, TX 78602",
        },
      ]) as never,
    });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits.hits[0]?.situsAddress).toBe("908 PINE , BASTROP, TX 78602");
  });

  it("returns Bastrop 908 Pine when CAD situs omits street-type suffix", async () => {
    let call = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              call += 1;
              if (call === 1) return [];
              return [
                {
                  countyFips: "48491",
                  propId: "999999",
                  situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
                },
                {
                  countyFips: "48021",
                  propId: "34137",
                  situsAddress: "908 PINE , BASTROP, TX 78602",
                },
              ];
            },
          }),
        }),
      }),
    };
    const hits = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop TX 78602",
      database: db as never,
    });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits.hits[0]?.situsAddress).toContain("BASTROP");
  });

  it("fail-closes (no unfiltered fallback) when locality matches nothing", async () => {
    const hits = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop TX 78602",
      database: mockDb([
        {
          countyFips: "48491",
          propId: "999999",
          situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
        },
      ]) as never,
    });
    expect(hits).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("keeps unconstrained prefix behavior when no locality is present", async () => {
    const hits = await searchPlaceByPrefix({
      query: "908 Pine",
      database: mockDb([
        {
          countyFips: "48491",
          propId: "999999",
          situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
        },
      ]) as never,
    });
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0]?.parcelNodeId).toBe("48491:999999");
  });

  // P-172 (F16 / _decisions/2026-09-12_find_box_reads_the_situs_index.md):
  // Travis leaves situs_city null on most of its roll (measured 2026-09-12)
  // and a CAD backfill never folds the city into situs_address either. A
  // locality-qualified query must still resolve the one parcel a street key
  // can mean when the STORE has no city on record to contradict it — unlike
  // the Georgetown/Bastrop homonym case above, where the store DOES carry a
  // (different) city and that is real evidence of the wrong parcel.
  describe("P-172: unique hit resolves when the store has no city to contradict", () => {
    it("bare street with no city AND blank situs_city resolves (48453:113408 shape)", async () => {
      const hits = await searchPlaceByPrefix({
        query: "414 SPILLER LN",
        database: mockDb([
          {
            countyFips: "48453",
            propId: "113408",
            situsAddress: "414 SPILLER LN",
            situsCity: null,
          },
        ]) as never,
      });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]?.parcelNodeId).toBe("48453:113408");
      expect(hits.missClass).toBeUndefined();
    });

    it("city-qualified query resolves the SAME row even though situs_city is null (composed situs_address carries no city)", async () => {
      const hits = await searchPlaceByPrefix({
        query: "414 Spiller Ln, West Lake Hills, TX",
        database: mockDb([
          {
            countyFips: "48453",
            propId: "113408",
            situsAddress: "414 SPILLER LN",
            situsCity: null,
          },
        ]) as never,
      });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]?.parcelNodeId).toBe("48453:113408");
    });

    it("resolves when situs_city IS populated and matches (the fixed-forward shape)", async () => {
      const hits = await searchPlaceByPrefix({
        query: "414 Spiller Ln, West Lake Hills, TX",
        database: mockDb([
          {
            countyFips: "48453",
            propId: "113408",
            situsAddress: "414 SPILLER LN",
            situsCity: "WEST LAKE HILLS",
          },
        ]) as never,
      });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]?.parcelNodeId).toBe("48453:113408");
    });

    it("a row with a fully-composed situs_address (city folded in) still resolves with locality", async () => {
      const hits = await searchPlaceByPrefix({
        query: "5833 Taylor Draper Cv, Austin, TX",
        database: mockDb([
          {
            countyFips: "48453",
            propId: "367134",
            situsAddress: "5833 TAYLOR DRAPER CV, AUSTIN, TX 78759",
            situsCity: null,
          },
        ]) as never,
      });
      expect(hits.hits).toHaveLength(1);
      expect(hits.hits[0]?.parcelNodeId).toBe("48453:367134");
    });

    it("still fails closed when the store DOES know a (different) city — homonym safety is not weakened", async () => {
      const hits = await searchPlaceByPrefix({
        query: "908 Pine St, Bastrop TX 78602",
        database: mockDb([
          {
            countyFips: "48491",
            propId: "999999",
            situsAddress: "908 PINE ST, GEORGETOWN, TX 78626",
            situsCity: "GEORGETOWN",
          },
        ]) as never,
      });
      expect(hits).toEqual({ hits: [], missClass: "no-hit" });
    });

    it("two rows sharing a street key, neither with a known city, come back as both candidates (ambiguous, not a silent pick)", async () => {
      const hits = await searchPlaceByPrefix({
        query: "908 Pine",
        database: mockDb([
          {
            countyFips: "48453",
            propId: "111111",
            situsAddress: "908 PINE",
            situsCity: null,
          },
          {
            countyFips: "48021",
            propId: "222222",
            situsAddress: "908 PINE",
            situsCity: null,
          },
        ]) as never,
      });
      expect(hits.hits.map((h) => h.parcelNodeId).sort()).toEqual(
        ["48021:222222", "48453:111111"].sort(),
      );
    });

    it("the parcel-id lookup form is untouched by any of this", async () => {
      const { lookupSitusByParcelNodeId } = await import(
        "../txgioAddressResolve"
      );
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [
                {
                  propId: "113408",
                  situsAddress: "414 SPILLER LN",
                },
              ],
            }),
          }),
        }),
      };
      const hit = await lookupSitusByParcelNodeId({
        parcelNodeId: "48453:113408",
        database: db as never,
      });
      expect(hit).toEqual({
        parcelNodeId: "48453:113408",
        situsAddress: "414 SPILLER LN",
        countyFips: "48453",
      });
    });
  });
});
