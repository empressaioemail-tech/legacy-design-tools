/**
 * F4d authoritative address->parcel resolution over a REAL local
 * Postgres. Proves the two DB resolution paths and the direct
 * fetch-by-prop-id used by the buildable-envelope route:
 *
 *   - `resolveParcelBySitus`      : normalized address -> ONE parcel node
 *                                   via `txgio_parcel.situs_address`.
 *   - `resolveRooftopByAddress`   : normalized address -> authoritative
 *                                   rooftop coord via `txgio_address`.
 *   - `queryTxgioParcelByPropId`  : parcel geometry by prop id.
 *
 * Same withTestSchema harness as the txgio_parcel store integration
 * suite. Skipped when no DATABASE_URL / TEST_DATABASE_URL locally; CI
 * always provides one.
 *
 * The anchor is the real bug case: `6026 Marsh Ln, Buda, TX 78610`,
 * which lives in the store as prop_id 193340 (situs
 * "6026 MARSH LN, BUDA, TX 78610", node 48209:193340) with the exact
 * rooftop point (30.04667, -97.81298) in the address file.
 */

import { describe, it, expect } from "vitest";
import { withTestSchema } from "@workspace/db/testing";
import { txgioParcel, txgioAddress } from "@workspace/db/schema";
import {
  bboxOfGeometry,
  cellKeysForBbox,
  cellKeyForPoint,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";
import {
  resolveParcelBySitus,
  resolveRooftopByAddress,
} from "../lib/txgioAddressResolve";
import { queryTxgioParcelByPropId } from "../lib/txgioParcelStore";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

/** A small polygon around the 6026 Marsh Ln rooftop (Buda). */
const MARSH_GEOMETRY: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.8132, 30.0465],
      [-97.8127, 30.0465],
      [-97.8127, 30.0469],
      [-97.8132, 30.0469],
      [-97.8132, 30.0465],
    ],
  ],
};
const MARSH_ROOFTOP = { latitude: 30.046670733631732, longitude: -97.81298044670837 };

/** A second parcel that shares a situs string with a third — ambiguous. */
const DUP_A: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.82, 30.05],
      [-97.819, 30.05],
      [-97.819, 30.051],
      [-97.82, 30.051],
      [-97.82, 30.05],
    ],
  ],
};

function parcelRows(
  featureIndex: number,
  geometry: GeoJsonGeometry,
  attrs: Partial<typeof txgioParcel.$inferInsert>,
): (typeof txgioParcel.$inferInsert)[] {
  const bbox = bboxOfGeometry(geometry)!;
  const cells = cellKeysForBbox(bbox)!;
  return cells.map((tileKey) => ({
    countyFips: "48209",
    tileKey,
    featureIndex,
    geometry: geometry as unknown as Record<string, unknown>,
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
    sourceFile: "stratmap25-landparcels_48209_lp.zip",
    sourceVintage: "stratmap25-landparcels_48209_hays_202503",
    ...attrs,
  }));
}

const PARCEL_SEED = [
  // The anchor — one parcel, several per-cell duplicate rows.
  ...parcelRows(1, MARSH_GEOMETRY, {
    propId: "193340",
    situsAddress: "6026 MARSH LN, BUDA, TX 78610",
    situsCity: "BUDA",
    situsState: "TX",
    situsZip: "78610",
  }),
  // Empty-situs parcel — must never match anything.
  ...parcelRows(2, DUP_A, {
    propId: "999001",
    situsAddress: ", ,",
  }),
  // Two DIFFERENT parcels sharing one situs string — ambiguous, must
  // decline (never guess).
  ...parcelRows(3, DUP_A, {
    propId: "700001",
    situsAddress: "10 SHARED ST, KYLE, TX 78640",
  }),
  ...parcelRows(4, DUP_A, {
    propId: "700002",
    situsAddress: "10 SHARED ST, KYLE, TX 78640",
  }),
  // A SPELLED-OUT street type ("PLACE", not "PL") — ~13k Hays+Comal
  // situs rows store the type spelled out (real: "144 THOMAS PLACE ,
  // KYLE, TX 78640"). The SQL-side normalization must canonicalize it to
  // "144 THOMAS PL" so a typed "144 Thomas Place" OR "144 Thomas Pl"
  // matches (FIX 1 — symmetric normalization).
  ...parcelRows(5, DUP_A, {
    propId: "108394",
    situsAddress: "144 THOMAS PLACE , KYLE, TX 78640",
  }),
];

const ADDRESS_SEED: (typeof txgioAddress.$inferInsert)[] = [
  {
    countyFips: "48209",
    fullAddr: "6026 MARSH LN",
    unit: "",
    addNumber: "6026",
    stName: "Marsh",
    postComm: "Buda",
    postCode: "78610",
    state: "TX",
    longitude: MARSH_ROOFTOP.longitude,
    latitude: MARSH_ROOFTOP.latitude,
    tileKey: cellKeyForPoint(MARSH_ROOFTOP.longitude, MARSH_ROOFTOP.latitude),
    sourceFile: "stratmap_address_points",
    sourceVintage: "stratmap_address_points_48_most_recent",
  },
];

describe.skipIf(!hasDb)("F4d resolveParcelBySitus (situs -> parcel node)", () => {
  it("resolves the bug address directly to its parcel node id", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const hit = await resolveParcelBySitus({
        countyFips: "48209",
        address: "6026 Marsh Ln, Buda, TX 78610",
        database: db,
      });
      expect(hit).toEqual({
        parcelNodeId: "48209:193340",
        rawPropId: "193340",
        matchSource: "situs",
      });
    });
  });

  it("matches regardless of typed street-type spelling / case", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const hit = await resolveParcelBySitus({
        countyFips: "48209",
        address: "6026 marsh lane",
        database: db,
      });
      expect(hit?.parcelNodeId).toBe("48209:193340");
    });
  });

  it("matches a SPELLED-OUT stored situs type against both spelled and abbreviated queries (FIX 1)", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      // Stored as "144 THOMAS PLACE"; a query spelling it out must match.
      const spelled = await resolveParcelBySitus({
        countyFips: "48209",
        address: "144 Thomas Place, Kyle, TX 78640",
        database: db,
      });
      expect(spelled?.parcelNodeId).toBe("48209:108394");
      // And the abbreviated query must match the SAME parcel — symmetric
      // normalization folds both sides to "144 THOMAS PL".
      const abbrev = await resolveParcelBySitus({
        countyFips: "48209",
        address: "144 Thomas Pl, Kyle, TX 78640",
        database: db,
      });
      expect(abbrev?.parcelNodeId).toBe("48209:108394");
    });
  });

  it("declines an AMBIGUOUS situs (two parcels, one string) — never guesses", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const hit = await resolveParcelBySitus({
        countyFips: "48209",
        address: "10 Shared St, Kyle, TX 78640",
        database: db,
      });
      expect(hit).toBeNull();
    });
  });

  it("returns null for a genuinely nonexistent address", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const hit = await resolveParcelBySitus({
        countyFips: "48209",
        address: "99999 Nonexistent Rd, Buda, TX 78610",
        database: db,
      });
      expect(hit).toBeNull();
    });
  });
});

describe.skipIf(!hasDb)("F4d resolveRooftopByAddress (address -> rooftop coord)", () => {
  it("returns the authoritative rooftop point for the bug address", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioAddress).values(ADDRESS_SEED);
      const hit = await resolveRooftopByAddress({
        countyFips: "48209",
        address: "6026 Marsh Ln, Buda, TX 78610",
        database: db,
      });
      expect(hit).not.toBeNull();
      expect(hit!.matchSource).toBe("txgio-address");
      expect(hit!.latitude).toBeCloseTo(MARSH_ROOFTOP.latitude, 6);
      expect(hit!.longitude).toBeCloseTo(MARSH_ROOFTOP.longitude, 6);
    });
  });

  it("returns null when the address is not in the rooftop file", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioAddress).values(ADDRESS_SEED);
      // 512 Main St Buda is genuinely absent from the address file (the
      // real-DB reality) — must fall through, not fabricate a point.
      const hit = await resolveRooftopByAddress({
        countyFips: "48209",
        address: "512 Main St, Buda, TX 78610",
        database: db,
      });
      expect(hit).toBeNull();
    });
  });
});

describe.skipIf(!hasDb)("F4d queryTxgioParcelByPropId (geometry by prop id)", () => {
  it("fetches the parcel polygon + node id for a prop id, deduping cells", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const res = await queryTxgioParcelByPropId({
        countyFips: "48209",
        countyName: "Hays",
        propId: "193340",
        database: db,
      });
      expect(res).not.toBeNull();
      // Per-cell duplicate rows collapse to ONE feature.
      expect(res!.featureCount).toBe(1);
      const feat = res!.geojson.features[0] as {
        geometry: GeoJsonGeometry;
        properties: Record<string, unknown>;
      };
      expect(feat.geometry.type).toBe("Polygon");
      expect(feat.properties.parcel_node_id).toBe("48209:193340");
      expect(feat.properties.situsAddress).toBe("6026 MARSH LN, BUDA, TX 78610");
    });
  });

  it("returns null for an absent prop id", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(PARCEL_SEED);
      const res = await queryTxgioParcelByPropId({
        countyFips: "48209",
        countyName: "Hays",
        propId: "000000",
        database: db,
      });
      expect(res).toBeNull();
    });
  });
});
