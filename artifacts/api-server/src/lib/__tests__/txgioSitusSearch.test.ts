/**
 * Unit tests for searchSitusByPrefix — mock db only (no DATABASE_URL).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: {
    countyFips: "county_fips",
    propId: "prop_id",
    situsAddress: "situs_address",
  },
  txgioAddress: {},
}));

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [{ fips: "48209", name: "Hays", source: "txgio-store" }],
}));

const { searchSitusByPrefix } = await import("../txgioAddressResolve");

describe("searchSitusByPrefix", () => {
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

  it("returns [] when the prefix is not address-shaped", async () => {
    const hits = await searchSitusByPrefix({
      query: "main street",
      database: mockDb([]) as never,
    });
    expect(hits).toEqual([]);
  });

  it("dedupes tile-cell duplicates and caps at limit", async () => {
    const hits = await searchSitusByPrefix({
      query: "6026 Marsh",
      limit: 2,
      database: mockDb([
        {
          countyFips: "48209",
          propId: "193340",
          situsAddress: "6026 MARSH LN, BUDA, TX 78610",
        },
        {
          countyFips: "48209",
          propId: "193340",
          situsAddress: "6026 MARSH LN, BUDA, TX 78610",
        },
        {
          countyFips: "48209",
          propId: "999",
          situsAddress: "6028 MARSH LN, BUDA, TX 78610",
        },
      ]) as never,
    });
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.parcelNodeId).sort()).toEqual([
      "48209:193340",
      "48209:999",
    ]);
    expect(hits[0]?.situsAddress).toContain("MARSH");
  });
});
