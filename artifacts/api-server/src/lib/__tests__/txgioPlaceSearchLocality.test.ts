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
    expect(hits).toHaveLength(1);
    expect(hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits[0]?.situsAddress).toContain("BASTROP");
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
    expect(hits).toHaveLength(1);
    expect(hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits[0]?.situsAddress).toBe("908 PINE , BASTROP, TX 78602");
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
    expect(hits).toHaveLength(1);
    expect(hits[0]?.parcelNodeId).toBe("48021:34137");
    expect(hits[0]?.situsAddress).toContain("BASTROP");
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
    expect(hits).toEqual([]);
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
    expect(hits).toHaveLength(1);
    expect(hits[0]?.parcelNodeId).toBe("48491:999999");
  });
});
