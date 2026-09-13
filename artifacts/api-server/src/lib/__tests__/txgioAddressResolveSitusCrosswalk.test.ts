/**
 * P-175 (2026-09-12) / P-177 (2026-09-13).
 *
 * A parcel-situs hit is minted from TxGIO's raw `prop_id`, for every county,
 * gate-blocked or not. P-175 briefly routed a gate-blocked county's hit
 * through a `cad_property` crosswalk instead (on the theory that the
 * TxGIO-keyed node's own account attributes were unreachable any other
 * way); the P-175 overseer review (2026-09-13) found the served customer
 * card never changed, because the crosswalk fix P-175 actually needed lived
 * in the tier-1 BAKE (`nodeFacetBakeTier1ConformantCli.ts`, see
 * `joinNormalizeCrosswalk.test.ts`'s `accountCrosswalkForNode` suite), not
 * in the situs RESOLVER. P-177 reverted the resolver half: the tests below
 * prove a parcel-situs hit resolves to the plain TxGIO node again, and that
 * this file no longer queries `cad_property` at all for that path.
 *
 * The address-point containment bind (the OTHER half of P-175/#668/#669) was
 * never crosswalked and is unaffected by P-177; its tests are unchanged.
 */

import { describe, it, expect, vi } from "vitest";

const TXGIO_PARCEL = {
  countyFips: "county_fips",
  propId: "prop_id",
  geoId: "geo_id",
  situsAddress: "situs_address",
  situsCity: "situs_city",
  situsState: "situs_state",
  situsZip: "situs_zip",
  geom: "geom",
};
const TXGIO_ADDRESS = {
  countyFips: "county_fips",
  fullAddr: "full_addr",
  postComm: "post_comm",
  state: "state",
  postCode: "post_code",
  latitude: "latitude",
  longitude: "longitude",
};

vi.mock("@workspace/db", () => ({
  db: {},
  txgioParcel: TXGIO_PARCEL,
  txgioAddress: TXGIO_ADDRESS,
}));

vi.mock("../brokerageTxParcels", () => ({
  allStoreCounties: () => [],
}));

const {
  searchSitusByStreetKeys,
  searchPlaceByPrefix,
} = await import("../txgioAddressResolve");

/**
 * A fake drizzle handle whose `.select().from(table).where(...).limit(n)`
 * returns canned rows keyed by WHICH table object `.from()` was called
 * with (identity, matching how the real module always passes the actual
 * imported table const).
 */
function fakeDb(opts: { txgioParcelRows?: unknown[] }) {
  const txgioParcelRows = opts.txgioParcelRows ?? [];
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === TXGIO_PARCEL) return txgioParcelRows;
            return [];
          },
        }),
      }),
    }),
  };
}

describe("gate-blocked situs hits resolve to the plain TxGIO node -- no crosswalk (P-177)", () => {
  it("Hays 48209: a situs hit keyed by TxGIO prop_id 97658 resolves to 48209:97658, never a CAD account id", async () => {
    const db = fakeDb({
      txgioParcelRows: [
        {
          countyFips: "48209",
          propId: "97658",
          geoId: "11-2011-0001-01100-3",
          situsAddress: "629 STURGEON DR",
          situsCity: null,
          situsState: null,
          situsZip: null,
        },
      ],
    });

    const hits = await searchSitusByStreetKeys({
      keys: ["629STURGEONDR"],
      database: db as never,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.parcelNodeId).toBe("48209:97658");
  });

  it("a non-blocked county (Bastrop 48021) resolves to the plain TxGIO node the same way", async () => {
    const db = fakeDb({
      txgioParcelRows: [
        {
          countyFips: "48021",
          propId: "34137",
          geoId: "some-geo-id",
          situsAddress: "908 PINE ST",
          situsCity: null,
          situsState: null,
          situsZip: null,
        },
      ],
    });

    const hits = await searchSitusByStreetKeys({
      keys: ["908PINEST"],
      database: db as never,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.parcelNodeId).toBe("48021:34137");
  });

  it("never queries cad_property: a database with no cad_property mock at all still resolves (proves no crosswalk lookup exists on this path)", async () => {
    // No `cadProperty` export in the @workspace/db mock above at all (unlike
    // the pre-P-177 version of this file). If searchSitusByStreetKeys still
    // referenced the crosswalk, importing txgioAddressResolve would throw at
    // module load (cadProperty would be undefined) rather than failing here
    // -- so this suite passing at all is itself part of the proof.
    const db = fakeDb({
      txgioParcelRows: [
        {
          countyFips: "48209",
          propId: "97652",
          geoId: "11-2011-0001-00500-3",
          situsAddress: "617 STURGEON DR",
          situsCity: null,
          situsState: null,
          situsZip: null,
        },
      ],
    });
    const hits = await searchSitusByStreetKeys({
      keys: ["617STURGEONDR"],
      database: db as never,
    });
    expect(hits[0]!.parcelNodeId).toBe("48209:97652");
  });
});

describe("address-point containment bind (P-175, unaffected by P-177)", () => {
  it("a located-but-unbound address point resolves through containment to the RAW TxGIO id -- deliberately not crosswalked", async () => {
    const db = fakeDb({
      // First .from(txgioParcel) call is the (empty) situs lookup; the
      // second is the containment query. Both share the same canned rows
      // fixture keyed by table identity, so return the containment hit --
      // the situs path finds nothing regardless (no matching keys/prefix).
      txgioParcelRows: [{ propId: "97651" }],
    });

    // searchAddressPointsByPrefix is exercised through searchPlaceByPrefix
    // via the real address-point query too, so give it a matching row.
    const rows = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === TXGIO_ADDRESS) {
                return [
                  {
                    countyFips: "48209",
                    fullAddr: "615 STURGEON DR",
                    postComm: "SAN MARCOS",
                    state: "TX",
                    postCode: "78666",
                    latitude: 29.87113,
                    longitude: -97.92674,
                  },
                ];
              }
              return db.select().from(table).where().limit();
            },
          }),
        }),
      }),
    };

    const result = await searchPlaceByPrefix({
      query: "615 Sturgeon Dr, San Marcos, TX",
      database: rows as never,
    });

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.source).toBe("address-point-containment");
    expect(hit.parcelNodeId).toBe("48209:97651");
  });

  it("no containing parcel: the address point stays unbound (today's behaviour, located-unbound downstream)", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === TXGIO_ADDRESS) {
                return [
                  {
                    countyFips: "48209",
                    fullAddr: "617 STURGEON DR",
                    postComm: "SAN MARCOS",
                    state: "TX",
                    postCode: "78666",
                    latitude: 29.87124,
                    longitude: -97.92662,
                  },
                ];
              }
              // txgio_parcel situs lookup AND containment lookup both miss.
              return [];
            },
          }),
        }),
      }),
    };

    const result = await searchPlaceByPrefix({
      query: "617 Sturgeon Dr, San Marcos, TX",
      database: db as never,
    });

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.source).toBe("address-point");
    expect(hit.parcelNodeId).toBeNull();
  });

  it("more than one containing parcel refuses rather than guessing", async () => {
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => {
              if (table === TXGIO_ADDRESS) {
                return [
                  {
                    countyFips: "48209",
                    fullAddr: "619 STURGEON DR",
                    postComm: "SAN MARCOS",
                    state: "TX",
                    postCode: "78666",
                    latitude: 29.87135,
                    longitude: -97.92649,
                  },
                ];
              }
              if (table === TXGIO_PARCEL) {
                return [
                  { propId: "97653" },
                  { propId: "97999" },
                ];
              }
              return [];
            },
          }),
        }),
      }),
    };

    const result = await searchPlaceByPrefix({
      query: "619 Sturgeon Dr, San Marcos, TX",
      database: db as never,
    });

    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.source).toBe("address-point");
    expect(hit.parcelNodeId).toBeNull();
  });
});
