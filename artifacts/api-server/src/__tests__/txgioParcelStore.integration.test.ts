/**
 * TxGIO parcel store readers against a REAL local Postgres — proves
 * the two store reads end to end over real Hays geometry: seed
 * `txgio_parcel` rows (bucketed with the same geo helpers the ingest
 * CLI uses), then exercise the drizzle-backed point lookup
 * (`makeTxgioParcelPointLookup`) and the bbox/pin GeoJSON reader
 * (`queryTxgioParcelsGeoJson`).
 *
 * Same withTestSchema harness as the cad-ingest / cadBriefAdapters
 * integration suites. Skipped when no DATABASE_URL / TEST_DATABASE_URL
 * is available locally; CI always provides one.
 */

import { describe, expect, it } from "vitest";
import { withTestSchema } from "@workspace/db/testing";
import { txgioParcel, cadProperty } from "@workspace/db/schema";
import { AdapterRunError } from "@workspace/adapters/types";
import {
  bboxOfGeometry,
  cellKeysForBbox,
  type GeoJsonGeometry,
} from "@workspace/cad-ingest/txgio-geo";
import {
  __internal,
  makeTxgioParcelPointLookup,
  queryTxgioParcelsGeoJson,
  txgioSourceUrl,
} from "../lib/txgioParcelStore";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

/**
 * Real TxGIO stratmap25 Hays feature — Prop_ID 12310 (707 Uhland Rd,
 * San Marcos), extracted verbatim from the program shapefile. Mirrors
 * lib/cad-ingest/src/__tests__/__fixtures__/txgioHaysParcel.ts.
 */
const HAYS_12310_GEOMETRY: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.91233033799995, 29.89560583900004],
      [-97.91294211699994, 29.89508246300005],
      [-97.91295020199999, 29.895076204000077],
      [-97.91297140099994, 29.895094855000025],
      [-97.91313552599996, 29.89523915700005],
      [-97.91252467199996, 29.895773322000025],
      [-97.91233033799995, 29.89560583900004],
    ],
  ],
};
const INSIDE_12310 = { latitude: 29.8953539541429, longitude: -97.91274065628568 };

/** Synthetic neighbor spanning two grid cells (crosses lng -97.92). */
const SPANNING_GEOMETRY: GeoJsonGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [-97.9215, 29.8952],
      [-97.9185, 29.8952],
      [-97.9185, 29.8958],
      [-97.9215, 29.8958],
      [-97.9215, 29.8952],
    ],
  ],
};

function rowsFor(
  countyFips: string,
  featureIndex: number,
  geometry: GeoJsonGeometry,
  attrs: Partial<typeof txgioParcel.$inferInsert>,
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
    sourceFile: "stratmap25-landparcels_48209_lp.zip",
    sourceVintage: "stratmap25-landparcels_48209_hays_202503",
    ...attrs,
  }));
}

const SEED = [
  ...rowsFor("48209", 1, HAYS_12310_GEOMETRY, {
    propId: "12310",
    geoId: "10-0017-2347-00000-3",
    ownerName: "DELEON FELIX",
    situsAddress: "707 UHLAND RD, SAN MARCOS, TX 78666",
    situsCity: "SAN MARCOS",
    situsState: "TX",
    situsZip: "78666",
  }),
  // Same cell, overlapping the lookup point, but WITHOUT a prop id —
  // the point lookup must skip it (it cannot join the CAD roll).
  ...rowsFor("48209", 2, HAYS_12310_GEOMETRY, { propId: null }),
  ...rowsFor("48209", 3, SPANNING_GEOMETRY, { propId: "99001" }),
];

describe.skipIf(!hasDb)("txgio_parcel store readers over real geometry", () => {
  it("point lookup ray-casts to the containing parcel and skips id-less rows", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(SEED);
      const lookup = makeTxgioParcelPointLookup(db);

      const hit = await lookup("48209", INSIDE_12310.latitude, INSIDE_12310.longitude);
      expect(hit).toEqual({
        propId: "12310",
        sourceUrl: txgioSourceUrl("48209"),
      });

      // Outside every seeded polygon (same cell) — honest null.
      expect(await lookup("48209", 29.8951, -97.9135)).toBeNull();
      // Wrong county — honest null.
      expect(await lookup("48091", INSIDE_12310.latitude, INSIDE_12310.longitude)).toBeNull();
    });
  });

  it("bbox read serves the county-provider feature shape and dedupes cell-spanning features", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(SEED);

      const res = await queryTxgioParcelsGeoJson({
        countyFips: "48209",
        countyName: "Hays",
        bbox: { westLng: -97.925, southLat: 29.894, eastLng: -97.911, northLat: 29.897 },
        database: db,
      });
      expect(res.queryMode).toBe("bbox");
      // Feature 3 spans two cells (two rows) but must appear once.
      expect(res.featureCount).toBe(3);
      const features = res.geojson.features as Array<{
        geometry: GeoJsonGeometry;
        properties: Record<string, unknown>;
      }>;
      const apns = features.map((f) => f.properties.apn).filter(Boolean).sort();
      expect(apns).toEqual(["12310", "99001"]);

      const f12310 = features.find((f) => f.properties.apn === "12310")!;
      expect(f12310.geometry.type).toBe("Polygon");
      expect(f12310.properties).toMatchObject({
        provider: "txgio",
        countyFips: "48209",
        countyName: "Hays",
        sourceUrl: txgioSourceUrl("48209"),
        sourceVintage: "stratmap25-landparcels_48209_hays_202503",
        notSurveyGrade: true,
        situsAddress: "707 UHLAND RD, SAN MARCOS, TX 78666",
        owner: "DELEON FELIX",
      });
      expect(typeof f12310.properties.retrievedAt).toBe("string");
      // No fabricated CLIP on this path.
      expect(f12310.properties.clip).toBeUndefined();
    });
  });

  it("pin read returns exactly the containing parcels", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(SEED);
      const res = await queryTxgioParcelsGeoJson({
        countyFips: "48209",
        countyName: "Hays",
        latitude: INSIDE_12310.latitude,
        longitude: INSIDE_12310.longitude,
        database: db,
      });
      expect(res.queryMode).toBe("pin");
      // 12310 and its id-less twin both contain the point; the spanning
      // rectangle does not.
      expect(res.featureCount).toBe(2);
      const apns = (res.geojson.features as Array<{ properties: Record<string, unknown> }>)
        .map((f) => f.properties.apn)
        .filter(Boolean);
      expect(apns).toEqual(["12310"]);
    });
  });

  it("throws the named no-coverage error where nothing is ingested", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(SEED);
      await expect(
        queryTxgioParcelsGeoJson({
          countyFips: "48091",
          countyName: "Comal",
          bbox: { westLng: -98.2, southLat: 29.7, eastLng: -98.1, northLat: 29.75 },
          database: db,
        }),
      ).rejects.toThrowError(AdapterRunError);
      await expect(
        queryTxgioParcelsGeoJson({
          countyFips: "48091",
          countyName: "Comal",
          bbox: { westLng: -98.2, southLat: 29.7, eastLng: -98.1, northLat: 29.75 },
          database: db,
        }),
      ).rejects.toThrow(/Comal County parcels \(TxGIO\/StratMap\) has no ingested parcel/);
    });
  });

  it("falls back to the bbox-column scan for viewports beyond the cell ceiling", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(SEED);
      // ~1 degree square — far over TXGIO_MAX_BBOX_CELLS, so the reader
      // takes the DISTINCT ON bbox-column path. Same three features.
      const res = await queryTxgioParcelsGeoJson({
        countyFips: "48209",
        countyName: "Hays",
        bbox: { westLng: -98.4, southLat: 29.4, eastLng: -97.4, northLat: 30.4 },
        database: db,
      });
      expect(res.featureCount).toBe(3);
    });
  });
});

/**
 * CAD land-use join — proves the choropleth-coloring enrichment that
 * lets Hays/Comal parcels color like the live county-GIS layers. The
 * join is keyed (county_fips, normalizeCadPropId(prop_id)); the real
 * San Marcos parcel Prop_ID 12310 (707 Uhland Rd) is the anchor, and
 * its CAD row carries a real `property_use_code`. Comal seeds no CAD
 * roll, so it must stay neutral without crashing.
 */
const HAYS_LANDUSE_SEED = [
  ...rowsFor("48209", 1, HAYS_12310_GEOMETRY, {
    propId: "12310",
    geoId: "10-0017-2347-00000-3",
    ownerName: "DELEON FELIX",
    situsAddress: "707 UHLAND RD, SAN MARCOS, TX 78666",
  }),
  // A neighbor whose CAD row has a NULL use code (Hays Orion reality:
  // the property export ships no state/use code) — must stay neutral.
  ...rowsFor("48209", 3, SPANNING_GEOMETRY, { propId: "99001" }),
];

/** Two Hays CAD rows: 12310 has a real code, 99001's code is null. */
const HAYS_CAD_ROWS = [
  {
    countyFips: "48209",
    propId: "12310",
    taxYear: 2025,
    propertyUseCode: "PRIOR (must not win)",
    sourceFile: "hays_2025.txt",
    sourceVintage: "2025-orion-hays",
  },
  {
    countyFips: "48209",
    propId: "12310",
    taxYear: 2026,
    propertyUseCode: "A1",
    sourceFile: "hays_2026.txt",
    sourceVintage: "2026-orion-hays",
  },
  {
    countyFips: "48209",
    propId: "99001",
    taxYear: 2026,
    propertyUseCode: null,
    sourceFile: "hays_2026.txt",
    sourceVintage: "2026-orion-hays",
  },
];

describe.skipIf(!hasDb)("txgio_parcel CAD land-use enrichment", () => {
  it("merges landUseCode from the latest CAD row onto the joined parcel", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(txgioParcel).values(HAYS_LANDUSE_SEED);
      await db.insert(cadProperty).values(HAYS_CAD_ROWS);

      const res = await queryTxgioParcelsGeoJson({
        countyFips: "48209",
        countyName: "Hays",
        bbox: { westLng: -97.925, southLat: 29.894, eastLng: -97.911, northLat: 29.897 },
        database: db,
      });
      const features = res.geojson.features as Array<{
        properties: Record<string, unknown>;
      }>;

      const f12310 = features.find((f) => f.properties.apn === "12310")!;
      expect(f12310.properties).toMatchObject({
        landUseCode: "A1", // 2026 wins over the 2025 prior-year row
        landUseSource: "cad-roll",
        landUseVintage: "2026-orion-hays",
      });

      // 99001's only CAD row has a null code — stays honestly neutral.
      const f99001 = features.find((f) => f.properties.apn === "99001")!;
      expect(f99001.properties.landUseCode).toBeUndefined();
      expect(f99001.properties.landUseSource).toBeUndefined();
    });
  });

  it("leaves parcels neutral in a county with no CAD roll (Comal), no crash", async () => {
    await withTestSchema(async ({ db }) => {
      // Seed the SAME geometry under Comal's FIPS; seed NO cad_property.
      await db.insert(txgioParcel).values([
        ...rowsFor("48091", 1, HAYS_12310_GEOMETRY, { propId: "12310" }),
      ]);

      const res = await queryTxgioParcelsGeoJson({
        countyFips: "48091",
        countyName: "Comal",
        bbox: { westLng: -97.925, southLat: 29.894, eastLng: -97.911, northLat: 29.897 },
        database: db,
      });
      const feature = (res.geojson.features as Array<{
        properties: Record<string, unknown>;
      }>)[0];
      expect(feature.properties.apn).toBe("12310");
      expect(feature.properties.landUseCode).toBeUndefined();
      expect(feature.properties.landUseSource).toBeUndefined();
    });
  });

  it("batch-fetches CAD land-use for a tile in one map keyed by normalized prop id", async () => {
    await withTestSchema(async ({ db }) => {
      await db.insert(cadProperty).values([
        {
          countyFips: "48209",
          propId: "12310",
          taxYear: 2026,
          propertyUseCode: "A1",
          sourceFile: "hays_2026.txt",
          sourceVintage: "2026-orion-hays",
        },
        // Leading-zero id in the tile normalizes to "42" to match the
        // CAD-stored key; proves the join normalizes both sides.
        {
          countyFips: "48209",
          propId: "42",
          taxYear: 2026,
          propertyUseCode: "E",
          sourceFile: "hays_2026.txt",
          sourceVintage: "2026-orion-hays",
        },
      ]);

      // Two tile rows: one plain numeric, one zero-padded upstream id.
      const tileRows = [
        { propId: "12310" } as never,
        { propId: "00042" } as never,
      ];
      const map = await __internal.fetchCadLandUseForTile(db, "48209", tileRows);
      expect(map.get("12310")?.landUseCode).toBe("A1");
      expect(map.get("42")?.landUseCode).toBe("E");
      expect(map.size).toBe(2);
    });
  });
});
