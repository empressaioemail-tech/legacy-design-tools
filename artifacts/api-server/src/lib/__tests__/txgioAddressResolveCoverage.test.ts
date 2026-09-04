/**
 * P-107 / OPS-16 A-072. `find_parcel` collapsed two honest opposites into
 * the same `no-hit`: an address genuinely outside Smart Site's coverage
 * (e.g. Phoenix, AZ) and an address inside coverage with no matching
 * parcel (e.g. a real Bastrop address). Measured live: the Phoenix query
 * returned `{"hits":[],"missClass":"no-hit"}`, indistinguishable from a
 * typo or a nonexistent address.
 *
 * These tests prove `searchPlaceByPrefix` now fires `out_of_coverage`
 * BEFORE touching the store for an out-of-state query (the DB mock below
 * throws if invoked, proving the short-circuit — no wasted round trip),
 * and that an in-coverage query with nothing on file is completely
 * unaffected (no regression): it still reaches the DB and still returns
 * `no-hit` exactly as before this card. Mock db only — no DATABASE_URL.
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

const { searchPlaceByPrefix } = await import("../txgioAddressResolve");

/** A DB that fails the test if ANY query reaches it. */
function unreachableDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            throw new Error(
              "searchPlaceByPrefix must not query the store for an out-of-coverage address",
            );
          },
        }),
      }),
    }),
  };
}

/** A DB that always returns empty rows (genuine in-coverage no-match). */
function emptyDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
  };
}

describe("searchPlaceByPrefix out-of-coverage vs in-coverage no-match (P-107 / OPS-16 A-072)", () => {
  it("an out-of-coverage address (Phoenix, AZ) returns out_of_coverage without touching the store", async () => {
    const result = await searchPlaceByPrefix({
      query: "1600 E Camelback Rd, Phoenix, AZ",
      database: unreachableDb() as never,
    });
    expect(result).toEqual({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
    // The exact defect measured: this must never collapse to the bare
    // no-hit an out-of-coverage query used to get.
    expect(result.missClass).not.toBe("no-hit");
  });

  it("an out-of-coverage address with a ZIP still resolves the state, not the ZIP", async () => {
    const result = await searchPlaceByPrefix({
      query: "1600 E Camelback Rd, Phoenix, AZ 85016",
      database: unreachableDb() as never,
    });
    expect(result).toEqual({
      hits: [],
      missClass: "out_of_coverage",
      outOfCoverageState: "AZ",
    });
  });

  it("a genuine in-coverage no-match (Texas, nothing on file) still returns plain no-hit — no regression", async () => {
    const result = await searchPlaceByPrefix({
      query: "147 Kahana Ln, Bastrop, TX",
      database: emptyDb() as never,
    });
    expect(result).toEqual({ hits: [], missClass: "no-hit" });
  });

  it("an in-coverage query naming TX explicitly is not treated as out of coverage", async () => {
    const result = await searchPlaceByPrefix({
      query: "908 Pine St, Bastrop, TX 78602",
      database: emptyDb() as never,
    });
    expect(result.missClass).toBe("no-hit");
    expect(result).not.toHaveProperty("outOfCoverageState");
  });

  it("a query with no parsed state at all still runs the ordinary search (no false positive)", async () => {
    const result = await searchPlaceByPrefix({
      query: "147 Kahana Ln, Bastrop",
      database: emptyDb() as never,
    });
    expect(result).toEqual({ hits: [], missClass: "no-hit" });
  });
});
