/**
 * P-359 — the ETJ derivation pass, run against a real PostGIS.
 *
 * The pass is ONE SQL statement, and every claim it makes is a claim about
 * PostGIS: `ST_IsValid` / `ST_IsValidReason`, `ST_MakeValid`'s repair of a
 * self-touching or self-intersecting ring, `ST_Contains` of a city's
 * representative point, `ST_Difference` of the two, and planar area in
 * EPSG:3081. None of that can be established by a unit test with a hand-written
 * index, so this suite runs the real statement against the real extension.
 *
 * Every fixture below is a shape measured while the pass was prototyped, and
 * each one pins a different branch of the verdict:
 *
 *   A  a ring that CONTAINS its own city          -> derived (the P-332 defect)
 *   B  a strip beside its city                    -> verbatim
 *   C  a self-intersecting (bowtie) ring          -> excluded (area is 0)
 *   D  a self-touching pinch, area unmoved        -> repaired
 *   E  a ring whose city is absent from the state -> verbatim, and it says so
 *   F  a ring identical to its city's limits      -> withheld (subtraction empty)
 *   G  an invalid ring that also contains its city-> derived + repaired
 *   H  a ring of a publisher this run did not name-> still underived
 *
 * Skipped when no DATABASE_URL / TEST_DATABASE_URL is available locally; CI
 * always provides one.
 */

import { describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { withTestSchema, type TestDb } from "@workspace/db/testing";
import { txCityBoundary, txEtjBoundary } from "@workspace/db/schema";
import { deriveEtjServedGeometry } from "../boundary/etjDerive";

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

const CITY_LAYER = "https://example.test/txgio/city-boundaries/0";

/** A square, as a GeoJSON Polygon string. */
function square(
  west: number,
  south: number,
  east: number,
  north: number,
): string {
  return JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  });
}

function bbox(west: number, south: number, east: number, north: number) {
  return { westLng: west, southLat: south, eastLng: east, northLat: north };
}

/** Georgetown-shaped: a 0.04 x 0.04 city square at (-97.72..-97.68, 30.61..30.65). */
const CITY = { west: -97.72, south: 30.61, east: -97.68, north: 30.65 };
/** The city's own limits, as published: a small square with a bay cut out of it,
 * so the subtraction has a shape the reader can be tested against. */
const CITY_BAY = JSON.stringify({
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [CITY.west, CITY.south],
        [CITY.east, CITY.south],
        [CITY.east, CITY.north],
        [CITY.west, CITY.north],
        [CITY.west, CITY.south],
      ],
    ],
  ],
});

/** A ring that CONTAINS the whole city: 0.10 x 0.12 around it. */
const RING_CONTAINS_CITY = square(-97.75, 30.57, -97.65, 30.69);
/** A strip beside the city: 0.02 wide, overlapping nothing, containing nothing. */
const RING_STRIP = square(-97.60, 30.57, -97.58, 30.69);
/** A self-intersecting bowtie: `ST_MakeValid` re-reads it as two full lobes, so
 * the repair moves the area by three orders of magnitude. Measured: 3,540.34 m²
 * as drawn (the crossed lobes nearly cancel) against 8,477,223.79 m² repaired —
 * which is why the declared tolerance excludes it rather than serving it. */
const RING_BOWTIE = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [-97.50, 30.50],
      [-97.46, 30.54],
      [-97.50, 30.54],
      [-97.46, 30.50],
      [-97.50, 30.50],
    ],
  ],
});
/** A shell with a hole far larger than it, lying outside it: the shoelace area is
 * NEGATIVE (measured: -128,590,313.85 m²), and a relative tolerance against a
 * non-positive denominator is not a test — the branch that excludes rather than
 * serving a repair it cannot bound. */
const RING_NEGATIVE_AREA = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [-97.30, 30.30],
      [-97.28, 30.30],
      [-97.28, 30.32],
      [-97.30, 30.32],
      [-97.30, 30.30],
    ],
    [
      [-97.35, 30.25],
      [-97.20, 30.25],
      [-97.20, 30.40],
      [-97.35, 30.40],
      [-97.35, 30.25],
    ],
  ],
});
/** A self-touching pinch: validity false, area unmoved by the repair. */
const RING_PINCH = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [-97.44, 30.44],
      [-97.40, 30.44],
      [-97.40, 30.48],
      [-97.42, 30.48],
      [-97.42, 30.46],
      [-97.42, 30.48],
      [-97.44, 30.48],
      [-97.44, 30.44],
    ],
  ],
});
/** Invalid AND self-containing: a big square carrying a spike, whose repair is
 * the square itself. Both branches apply, in that order. */
const RING_SPIKE_OVER_CITY = JSON.stringify({
  type: "Polygon",
  coordinates: [
    [
      [-97.75, 30.57],
      [-97.65, 30.57],
      [-97.65, 30.69],
      [-97.7, 30.69],
      // the spike: out along the same line and back, so the ring self-touches
      [-97.7, 30.65],
      [-97.7, 30.69],
      [-97.75, 30.69],
      [-97.75, 30.57],
    ],
  ],
});

type RingSeed = {
  etjId: string;
  cityKey: string;
  cityName: string;
  ringLabel: string;
  geometry: string;
  bbox: ReturnType<typeof bbox>;
};

const RINGS: RingSeed[] = [
  {
    etjId: "georgetown-tx:1",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 1",
    geometry: RING_CONTAINS_CITY,
    bbox: bbox(-97.75, 30.57, -97.65, 30.69),
  },
  {
    etjId: "georgetown-tx:2",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 2",
    geometry: RING_STRIP,
    bbox: bbox(-97.6, 30.57, -97.58, 30.69),
  },
  {
    etjId: "georgetown-tx:3",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 3",
    geometry: RING_BOWTIE,
    bbox: bbox(-97.5, 30.5, -97.46, 30.54),
  },
  {
    etjId: "georgetown-tx:4",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 4",
    geometry: RING_PINCH,
    bbox: bbox(-97.44, 30.44, -97.4, 30.48),
  },
  {
    etjId: "georgetown-tx:5",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 5",
    geometry: RING_NEGATIVE_AREA,
    bbox: bbox(-97.35, 30.25, -97.2, 30.4),
  },
  {
    etjId: "nowhere-city-tx:1",
    cityKey: "nowhere-city-tx",
    cityName: "Nowhere City",
    ringLabel: "NOWHERE ETJ 1",
    geometry: RING_STRIP,
    bbox: bbox(-97.6, 30.57, -97.58, 30.69),
  },
  {
    etjId: "georgetown-tx:6",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 6",
    // Identical to the city's own limits: the subtraction leaves nothing.
    geometry: CITY_BAY,
    bbox: bbox(CITY.west, CITY.south, CITY.east, CITY.north),
  },
  {
    etjId: "georgetown-tx:7",
    cityKey: "georgetown-tx",
    cityName: "Georgetown",
    ringLabel: "GEORGETOWN ETJ 7",
    geometry: RING_SPIKE_OVER_CITY,
    bbox: bbox(-97.75, 30.57, -97.65, 30.69),
  },
  {
    etjId: "unrun-city-tx:1",
    cityKey: "unrun-city-tx",
    cityName: "Unrun City",
    ringLabel: "UNRUN ETJ 1",
    geometry: RING_STRIP,
    bbox: bbox(-97.6, 30.57, -97.58, 30.69),
  },
];

/** The publisher set this run derives. `unrun-city-tx` is deliberately absent. */
const RUN_KEYS = [
  "georgetown-tx",
  "nowhere-city-tx",
] as const;

async function seed(db: TestDb): Promise<void> {
  await db.insert(txCityBoundary).values({
    geoId: "4829000",
    cityName: "Georgetown",
    geometry: JSON.parse(CITY_BAY) as unknown,
    ...bbox(CITY.west, CITY.south, CITY.east, CITY.north),
    source: "TxGIO/CPA",
    sourceVintage: "2026-08-01",
    sourceCitation: CITY_LAYER,
  });
  for (const ring of RINGS) {
    await db.insert(txEtjBoundary).values({
      etjId: ring.etjId,
      cityKey: ring.cityKey,
      cityName: ring.cityName,
      ringLabel: ring.ringLabel,
      geometry: JSON.parse(ring.geometry) as unknown,
      ...ring.bbox,
      source: `City of ${ring.cityName}`,
      sourceVintage: "2026-08-01",
      sourceCitation: "https://example.test/etj/0",
    });
  }
}

async function statuses(
  db: TestDb,
): Promise<Record<string, string | null>> {
  const rows = (await db
    .select({
      etjId: txEtjBoundary.etjId,
      servedStatus: txEtjBoundary.servedStatus,
      servedGeometry: txEtjBoundary.servedGeometry,
    })
    .from(txEtjBoundary)) as Array<{
    etjId: string;
    servedStatus: string | null;
    servedGeometry: unknown;
  }>;
  return Object.fromEntries(
    rows.map((r) => [
      r.etjId,
      `${r.servedStatus}${r.servedGeometry === null ? "" : "+geom"}`,
    ]),
  );
}

describe.skipIf(!hasDb)("etj derivation pass (P-359)", () => {
  it("derives, repairs, excludes and withholds by the measured shape of each ring", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      const summary = await deriveEtjServedGeometry(db, [...RUN_KEYS]);

      expect(summary.ringsDerived).toBe(RINGS.length - 1); // `unrun-city-tx` was not named
      expect(summary.byStatus).toEqual({
        verbatim: 2,
        derived: 2,
        repaired: 1,
        excluded: 2,
        withheld: 1,
      });
      expect(await statuses(db)).toEqual({
        "georgetown-tx:1": "derived+geom",
        "georgetown-tx:2": "verbatim",
        "georgetown-tx:3": "excluded",
        "georgetown-tx:4": "repaired+geom",
        "georgetown-tx:5": "excluded",
        "georgetown-tx:6": "withheld",
        "georgetown-tx:7": "derived+geom",
        "nowhere-city-tx:1": "verbatim",
        // The publisher this run did not name keeps the fail-closed default.
        "unrun-city-tx:1": "underived",
      });
    });
  });

  it("the derived geometry is the ring minus its own city, measured not asserted", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["georgetown-tx"]);

      const [row] = (await db
        .select({
          servedStatus: txEtjBoundary.servedStatus,
          derivation: txEtjBoundary.derivation,
          areaPublished: txEtjBoundary.areaPublished,
          areaServed: txEtjBoundary.areaServed,
          // The city's representative point, tested against the SERVED geometry:
          // this is the P-332 falsifier, run on the geometry the reader will use.
          cityInServed: sql<boolean>`ST_Contains(
            ST_MakeValid(ST_GeomFromGeoJSON(${txEtjBoundary.servedGeometry}::text)),
            ST_PointOnSurface(ST_MakeValid(ST_GeomFromGeoJSON(
              (SELECT geometry FROM tx_city_boundary WHERE city_name = 'Georgetown')::text)))
          )`,
        })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "georgetown-tx:1"))) as Array<{
        servedStatus: string;
        derivation: {
          kind: string;
          isValidPublished: boolean;
          isValidServed: boolean | null;
          subtracted: { cityGeoId: string; cityName: string; boundaryVintage: string } | null;
          areaPublished: number;
          areaServed: number;
          areaRemoved: number;
          repairAreaDeltaFraction: number | null;
          toleranceFraction: number;
          note: string;
        } | null;
        areaPublished: number | null;
        areaServed: number | null;
        cityInServed: boolean;
      }>;

      expect(row.servedStatus).toBe("derived");
      // The whole point: the city's representative point is NO LONGER inside what
      // the reader tests, and it still was inside what the publisher drew.
      expect(row.cityInServed).toBe(false);
      const derivation = row.derivation!;
      expect(derivation.kind).toBe("self_containing");
      expect(derivation.isValidPublished).toBe(true);
      expect(derivation.isValidServed).toBe(true);
      expect(derivation.subtracted).toEqual({
        table: "tx_city_boundary",
        matchedBy: "city_name_normalized",
        cityGeoId: "4829000",
        cityName: "Georgetown",
        boundaryVintage: "2026-08-01",
      });
      // The subtraction is a real removal, and both areas are recorded with it.
      expect(row.areaServed!).toBeLessThan(row.areaPublished!);
      expect(derivation.areaRemoved).toBeGreaterThan(0);
      expect(derivation.areaServed).toBeCloseTo(row.areaServed!, 6);
      expect(derivation.note).toContain("the ring minus that city's limits");
      // No repair happened, so no repair delta is claimed.
      expect(derivation.repairAreaDeltaFraction).toBeUndefined();
      expect(derivation.toleranceFraction).toBe(0.001);
    });
  });

  it("an excluded ring records WHY, and nothing is served for it", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["georgetown-tx"]);
      const rows = (await db
        .select({
          etjId: txEtjBoundary.etjId,
          servedStatus: txEtjBoundary.servedStatus,
          servedGeometry: txEtjBoundary.servedGeometry,
          areaPublished: txEtjBoundary.areaPublished,
          areaServed: txEtjBoundary.areaServed,
          derivation: txEtjBoundary.derivation,
        })
        .from(txEtjBoundary)
        .where(inArray(txEtjBoundary.etjId, [
          "georgetown-tx:3",
          "georgetown-tx:5",
        ]))) as Array<{
        etjId: string;
        servedStatus: string;
        servedGeometry: unknown;
        areaPublished: number | null;
        areaServed: number | null;
        derivation: {
          kind: string;
          isValidReason: string;
          repairAreaDeltaFraction: number | null;
          note: string;
        } | null;
      }>;

      // The bowtie: a repair Postgres can perform, moving the area far past the
      // declared tolerance, so it is excluded rather than served.
      const bowtie = rows.find((r) => r.etjId === "georgetown-tx:3")!;
      expect(bowtie.servedStatus).toBe("excluded");
      expect(bowtie.servedGeometry).toBeNull();
      expect(bowtie.areaServed).toBeNull();
      // Postgres' own words about the polygon, not a paraphrase.
      expect(bowtie.derivation!.isValidReason).toContain("Self-intersection");
      expect(bowtie.derivation!.repairAreaDeltaFraction!).toBeGreaterThan(0.001);
      expect(bowtie.derivation!.note).toContain("beyond the declared relative tolerance");

      // The inverted shell: area is not positive, so no relative tolerance can
      // bound the repair, and the record says that rather than blaming a delta.
      const negative = rows.find((r) => r.etjId === "georgetown-tx:5")!;
      expect(negative.servedStatus).toBe("excluded");
      expect(negative.servedGeometry).toBeNull();
      expect(negative.areaPublished!).toBeLessThan(0);
      expect(negative.derivation!.note).toContain("not positive");
    });
  });

  it("a self-touching ring is repaired, and the repair is recorded with its delta", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["georgetown-tx"]);
      const [row] = (await db
        .select({
          servedStatus: txEtjBoundary.servedStatus,
          derivation: txEtjBoundary.derivation,
          // `ST_IsValid` on what the reader will test, run by Postgres here.
          servedValid: sql<boolean>`ST_IsValid(
            ST_GeomFromGeoJSON(${txEtjBoundary.servedGeometry}::text))`,
        })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "georgetown-tx:4"))) as Array<{
        servedStatus: string;
        servedValid: boolean;
        derivation: {
          kind: string;
          isValidPublished: boolean;
          isValidServed: boolean;
          repaired: boolean;
          repairAreaDeltaFraction: number | null;
          note: string;
        } | null;
      }>;
      expect(row.servedStatus).toBe("repaired");
      expect(row.servedValid).toBe(true);
      const derivation = row.derivation!;
      expect(derivation.kind).toBe("invalid_repair");
      expect(derivation.isValidPublished).toBe(false);
      expect(derivation.isValidServed).toBe(true);
      expect(derivation.repaired).toBe(true);
      // The pinch repairs to the same area, which is why it is servable at all.
      expect(derivation.repairAreaDeltaFraction).toBeLessThan(1e-6);
      expect(derivation.note).toContain("ST_MakeValid");
    });
  });

  it("a ring whose own city is not in the state layer is served verbatim, and says so", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["nowhere-city-tx"]);
      const [row] = (await db
        .select({
          servedStatus: txEtjBoundary.servedStatus,
          servedGeometry: txEtjBoundary.servedGeometry,
          areaPublished: txEtjBoundary.areaPublished,
          areaServed: txEtjBoundary.areaServed,
          derivation: txEtjBoundary.derivation,
        })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "nowhere-city-tx:1"))) as Array<{
        servedStatus: string;
        servedGeometry: unknown;
        areaPublished: number | null;
        areaServed: number | null;
        derivation: { kind: string; note: string; subtracted: unknown } | null;
      }>;
      expect(row.servedStatus).toBe("verbatim");
      expect(row.servedGeometry).toBeNull();
      expect(row.derivation!.note).toContain("not in tx_city_boundary");
      // Nothing was subtracted, and the record does not pretend otherwise.
      expect(row.derivation!.subtracted).toBeUndefined();
      expect(row.areaServed).toBe(row.areaPublished);
    });
  });

  it("a ring identical to its city's limits is withheld: the subtraction left nothing", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["georgetown-tx"]);
      const [row] = (await db
        .select({
          servedStatus: txEtjBoundary.servedStatus,
          servedGeometry: txEtjBoundary.servedGeometry,
          derivation: txEtjBoundary.derivation,
        })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "georgetown-tx:6"))) as Array<{
        servedStatus: string;
        servedGeometry: unknown;
        derivation: { kind: string; note: string; subtracted: unknown } | null;
      }>;
      expect(row.servedStatus).toBe("withheld");
      expect(row.servedGeometry).toBeNull();
      expect(row.derivation!.kind).toBe("self_containing");
      // It still records WHAT it tried to subtract: the refusal is attributable.
      expect(row.derivation!.subtracted).toBeTruthy();
      expect(row.derivation!.note).toContain("left no usable polygon");
    });
  });

  it("an invalid ring that also contains its city is both repaired and derived", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, ["georgetown-tx"]);
      const [row] = (await db
        .select({
          servedStatus: txEtjBoundary.servedStatus,
          derivation: txEtjBoundary.derivation,
          cityInServed: sql<boolean>`ST_Contains(
            ST_MakeValid(ST_GeomFromGeoJSON(${txEtjBoundary.servedGeometry}::text)),
            ST_PointOnSurface(ST_MakeValid(ST_GeomFromGeoJSON(
              (SELECT geometry FROM tx_city_boundary WHERE city_name = 'Georgetown')::text)))
          )`,
        })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "georgetown-tx:7"))) as Array<{
        servedStatus: string;
        cityInServed: boolean;
        derivation: {
          kind: string;
          isValidPublished: boolean;
          repaired: boolean;
          subtracted: unknown;
          note: string;
        } | null;
      }>;
      expect(row.servedStatus).toBe("derived");
      expect(row.cityInServed).toBe(false);
      expect(row.derivation!.kind).toBe("invalid_repair");
      expect(row.derivation!.isValidPublished).toBe(false);
      expect(row.derivation!.repaired).toBe(true);
      expect(row.derivation!.subtracted).toBeTruthy();
      // The note is what the panel shows, and this row's drawing was edited
      // twice. A note that named only the repair would leave the subtraction
      // unspoken, so both must appear.
      expect(row.derivation!.note).toContain("ST_MakeValid");
      expect(row.derivation!.note).toContain("minus Georgetown's limits");
    });
  });

  it("is idempotent: a second run writes the same statuses and the same areas", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, [...RUN_KEYS]);
      // Per row, not as a SUM: float8 addition is not associative, so a summed
      // comparison can differ in the last bits purely from row order, and the
      // equality would then be measuring the planner rather than the pass.
      const snapshot = () =>
        db
          .select({
            etjId: txEtjBoundary.etjId,
            servedStatus: txEtjBoundary.servedStatus,
            areaPublished: txEtjBoundary.areaPublished,
            areaServed: txEtjBoundary.areaServed,
            derivation: txEtjBoundary.derivation,
          })
          .from(txEtjBoundary)
          .orderBy(txEtjBoundary.etjId);
      const first = await snapshot();

      const second = await deriveEtjServedGeometry(db, [...RUN_KEYS]);
      expect(second.ringsDerived).toBe(RINGS.length - 1);
      const after = await snapshot();

      // The record's own `at` timestamp is the only field that may move.
      expect(after.map((r) => ({ ...r, derivation: undefined }))).toEqual(
        first.map((r) => ({ ...r, derivation: undefined })),
      );
      for (const [i, row] of after.entries()) {
        const before = first[i]!.derivation as { at: string } | null;
        const now = row.derivation as { at: string } | null;
        if (before === null || now === null) {
          expect(now).toEqual(before);
          continue;
        }
        expect({ ...now, at: before.at }).toEqual(before);
      }
    });
  });

  it("the publisher's own geometry is never overwritten by what it derives", async () => {
    await withTestSchema(async ({ db }) => {
      await seed(db);
      await deriveEtjServedGeometry(db, [...RUN_KEYS]);
      const [row] = (await db
        .select({ geometry: txEtjBoundary.geometry })
        .from(txEtjBoundary)
        .where(eq(txEtjBoundary.etjId, "georgetown-tx:1"))) as Array<{
        geometry: unknown;
      }>;
      expect(row.geometry).toEqual(JSON.parse(RING_CONTAINS_CITY));
    });
  });
});
