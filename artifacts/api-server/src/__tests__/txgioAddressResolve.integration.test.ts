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
  resolveParcelBySitusDisambiguated,
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

// --- F4e disambiguation fixtures ---
// Two DISTINCT, non-overlapping polygons that will SHARE one situs string:
// a point inside AMBIG_LEFT disambiguates to the left parcel and lies
// OUTSIDE AMBIG_RIGHT (item 1: point-in-polygon among situs candidates).
const AMBIG_LEFT: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.900, 30.100],
      [-97.899, 30.100],
      [-97.899, 30.101],
      [-97.900, 30.101],
      [-97.900, 30.100],
    ],
  ],
};
const AMBIG_RIGHT: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.800, 30.100],
      [-97.799, 30.100],
      [-97.799, 30.101],
      [-97.800, 30.101],
      [-97.800, 30.100],
    ],
  ],
};
/** Inside AMBIG_LEFT, outside AMBIG_RIGHT. */
const POINT_IN_LEFT = { latitude: 30.1005, longitude: -97.8995 };
/** Inside neither AMBIG_LEFT nor AMBIG_RIGHT (a centroid that fell away). */
const POINT_IN_NEITHER = { latitude: 30.2, longitude: -97.5 };

// A Comal (48091) parcel with a UNIQUE situs, for the multi-county query
// test. Its polygon sits in Comal's routing area.
const COMAL_GEOMETRY: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-98.200, 29.800],
      [-98.199, 29.800],
      [-98.199, 29.801],
      [-98.200, 29.801],
      [-98.200, 29.800],
    ],
  ],
};

function parcelRows(
  featureIndex: number,
  geometry: GeoJsonGeometry,
  attrs: Partial<typeof txgioParcel.$inferInsert>,
  countyFips = "48209",
): (typeof txgioParcel.$inferInsert)[] {
  const bbox = bboxOfGeometry(geometry)!;
  const cells = cellKeysForBbox(bbox)!;
  return cells.map((tileKey) => ({
    countyFips,
    tileKey,
    featureIndex,
    geometry: geometry as unknown as Record<string, unknown>,
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
    sourceFile: `stratmap25-landparcels_${countyFips}_lp.zip`,
    sourceVintage: `stratmap25-landparcels_${countyFips}_202503`,
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
  // F4e item 1: two DISTINCT parcels sharing a situs, DIFFERENT polygons.
  // A point inside AMBIG_LEFT disambiguates to prop 500001; a point in
  // neither declines.
  ...parcelRows(10, AMBIG_LEFT, {
    propId: "500001",
    situsAddress: "42 AMBIG WAY, KYLE, TX 78640",
  }),
  ...parcelRows(11, AMBIG_RIGHT, {
    propId: "500002",
    situsAddress: "42 AMBIG WAY, KYLE, TX 78640",
  }),
  // F4e item 2: a Comal (48091) parcel with a situs UNIQUE across both
  // counties — proves a unique hit in ANY candidate county wins.
  ...parcelRows(
    20,
    COMAL_GEOMETRY,
    {
      propId: "600001",
      situsAddress: "77 COMAL ONLY RD, NEW BRAUNFELS, TX 78130",
    },
    "48091",
  ),
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

describe.skipIf(!hasDb)(
  "F4e resolveParcelBySitusDisambiguated (multi-county + point disambiguation)",
  () => {
    it("resolves a UNIQUE situs with NO point (situs-before-geocode; a geocode miss must not lose it)", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }, { fips: "48091" }],
          address: "6026 Marsh Ln, Buda, TX 78610",
          point: null, // geocode MISSED — a unique situs still resolves
          database: db,
        });
        expect(out.hit?.parcelNodeId).toBe("48209:193340");
        expect(out.resolvedBy).toBe("unique-situs");
      });
    });

    it("finds a UNIQUE situs in ANOTHER candidate county (item 2 — multi-county query)", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        // Search both counties; the situs only exists in Comal (48091). A
        // unique hit in ANY candidate county is authoritative.
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }, { fips: "48091" }],
          address: "77 Comal Only Rd, New Braunfels, TX 78130",
          point: null,
          database: db,
        });
        expect(out.hit?.parcelNodeId).toBe("48091:600001");
        expect(out.resolvedBy).toBe("unique-situs");
      });
    });

    it("DISAMBIGUATES an ambiguous situs by the containing point (item 1)", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        // Two parcels share "42 AMBIG WAY"; the point lies inside the LEFT
        // parcel only -> that's the authoritative answer (right situs AND
        // right geometry).
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }, { fips: "48091" }],
          address: "42 Ambig Way, Kyle, TX 78640",
          point: POINT_IN_LEFT,
          database: db,
        });
        expect(out.hit?.parcelNodeId).toBe("48209:500001");
        expect(out.resolvedBy).toBe("point-disambiguated");
      });
    });

    it("DECLINES an ambiguous situs when NO candidate contains the point (never a wrong-situs neighbor)", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }],
          address: "42 Ambig Way, Kyle, TX 78640",
          point: POINT_IN_NEITHER,
          database: db,
        });
        expect(out.hit).toBeNull();
        expect(out.reason).toBe("ambiguous-no-containing-candidate");
        expect(out.ambiguousCandidateCount).toBe(2);
      });
    });

    it("DECLINES an ambiguous situs when there is NO point to disambiguate with", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }],
          address: "42 Ambig Way, Kyle, TX 78640",
          point: null,
          database: db,
        });
        expect(out.hit).toBeNull();
        expect(out.reason).toBe("ambiguous-no-point");
      });
    });

    it("returns no-situs-match (fall-through) for a genuinely absent address", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }, { fips: "48091" }],
          address: "99999 Nonexistent Rd, Buda, TX 78610",
          point: { latitude: 30.0, longitude: -97.9 },
          database: db,
        });
        expect(out.hit).toBeNull();
        expect(out.reason).toBe("no-situs-match");
      });
    });

    it("never returns the EMPTY-situs parcel (unmatchable by a house-numbered query)", async () => {
      await withTestSchema(async ({ db }) => {
        await db.insert(txgioParcel).values(PARCEL_SEED);
        // Prop 999001 has situs ", ," — a house-numbered query must never
        // resolve to it, and it must never be a disambiguation candidate.
        const out = await resolveParcelBySitusDisambiguated({
          counties: [{ fips: "48209" }],
          address: "6026 Marsh Ln, Buda, TX 78610",
          point: null,
          database: db,
        });
        expect(out.hit?.rawPropId).not.toBe("999001");
        expect(out.hit?.parcelNodeId).toBe("48209:193340");
      });
    });
  },
);
