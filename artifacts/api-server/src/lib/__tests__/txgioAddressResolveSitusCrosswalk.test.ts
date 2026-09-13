/**
 * P-175 (2026-09-12). Two failures in the parcel-situs / address-point
 * ladder, both regressions against today's behaviour before this card:
 *
 * 1. A parcel-situs hit for a GATE-BLOCKED county (Hays 48209, Williamson
 *    48491) is minted from TxGIO's raw `prop_id`, which is a DIFFERENT
 *    published identifier than `cad_property.prop_id` for those two
 *    counties and can collide with an unrelated CAD account -- the
 *    Sturgeon/Mesa Verde chimera (`48209:97658` carrying lot 11's
 *    geometry under an unrelated Austin account's label). The fix
 *    resolves through the same crosswalk the tier-1 bake uses
 *    (`property_number` -> `txgio_parcel.geo_id`) before minting the node.
 *
 * 2. An address point with no parcel-situs hit (a just-platted vacant lot
 *    the appraisal district has not written a house number for yet)
 *    resolves with `parcelNodeId: null` and reads `located-unbound`
 *    downstream, even when its rooftop point falls inside exactly one
 *    TxGIO parcel already in the store. The fix binds it by containment.
 *
 * Both tests are written to FAIL on the pre-card code (raw `parcelNodeId`,
 * no containment query) and pass after it.
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
const CAD_PROPERTY = {
  countyFips: "county_fips",
  propId: "prop_id",
  taxYear: "tax_year",
  quickRefId: "quick_ref_id",
  propertyNumber: "property_number",
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
  cadProperty: CAD_PROPERTY,
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
 * imported table const). `cadPropertyRows` defaults to a throwing stub so
 * a test that expects NO crosswalk query (a non-blocked county) fails
 * loudly if one happens anyway.
 */
function fakeDb(opts: {
  txgioParcelRows?: unknown[];
  cadPropertyRows?: unknown[] | "unreachable";
}) {
  const txgioParcelRows = opts.txgioParcelRows ?? [];
  const cadPropertyRows = opts.cadPropertyRows ?? "unreachable";
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === TXGIO_PARCEL) return txgioParcelRows;
            if (table === CAD_PROPERTY) {
              if (cadPropertyRows === "unreachable") {
                throw new Error(
                  "must not query cad_property for a non-blocked county",
                );
              }
              return cadPropertyRows;
            }
            return [];
          },
        }),
      }),
    }),
  };
}

describe("gate-blocked situs hits resolve through the crosswalk (P-175)", () => {
  it("Hays 48209: a situs hit keyed by TxGIO prop_id 97658 resolves to CAD account 84639, not 97658", async () => {
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
      cadPropertyRows: [
        {
          countyFips: "48209",
          propId: "84639",
          propertyNumber: "11-2011-0001-01100-3",
          taxYear: 2026,
        },
      ],
    });

    const hits = await searchSitusByStreetKeys({
      keys: ["629STURGEONDR"],
      database: db as never,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.parcelNodeId).toBe("48209:84639");
    expect(hits[0]!.parcelNodeId).not.toBe("48209:97658");
  });

  it("Hays 48209: an ambiguous property_number (claimed by 2 accounts) refuses the crosswalk and falls back to the raw TxGIO id", async () => {
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
      cadPropertyRows: [
        {
          countyFips: "48209",
          propId: "84639",
          propertyNumber: "11-2011-0001-01100-3",
          taxYear: 2026,
        },
        {
          countyFips: "48209",
          propId: "99999",
          propertyNumber: "11-2011-0001-01100-3",
          taxYear: 2026,
        },
      ],
    });

    const hits = await searchSitusByStreetKeys({
      keys: ["629STURGEONDR"],
      database: db as never,
    });

    expect(hits).toHaveLength(1);
    // Refused as ambiguous: falls back to raw TxGIO-keyed node (not worse
    // than today), never guesses between the two claimants.
    expect(hits[0]!.parcelNodeId).toBe("48209:97658");
  });

  it("a non-blocked county (Bastrop 48021) never queries cad_property and keeps the raw TxGIO id", async () => {
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
      cadPropertyRows: "unreachable",
    });

    const hits = await searchSitusByStreetKeys({
      keys: ["908PINEST"],
      database: db as never,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.parcelNodeId).toBe("48021:34137");
  });
});

describe("address-point containment bind (P-175)", () => {
  it("a located-but-unbound address point resolves through containment to the RAW TxGIO id -- deliberately not crosswalked", async () => {
    const db = fakeDb({
      // First .from(txgioParcel) call is the (empty) situs lookup; the
      // second is the containment query. Both share the same canned rows
      // fixture keyed by table identity, so return the containment hit --
      // the situs path finds nothing regardless (no matching keys/prefix).
      // cad_property is deliberately "unreachable": an address-point
      // containment bind must never query the crosswalk (no competing
      // account to collide with here, unlike a parcel-situs hit).
      txgioParcelRows: [{ propId: "97651" }],
      cadPropertyRows: "unreachable",
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
                  { propId: "97653", geoId: "a" },
                  { propId: "97999", geoId: "b" },
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
