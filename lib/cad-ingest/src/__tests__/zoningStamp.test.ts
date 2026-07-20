/**
 * Zoning-stamp unit tests (F11): the point-in-polygon stamp that attaches
 * the real zoning district to TxGIO parcels.
 *
 * The load-bearing case: a parcel whose centroid falls in a known "RS"
 * (Residential Single-Family) zoning polygon is stamped "RS" — the raw
 * Georgetown ZONE code, which the buildable-envelope `districtCode()`
 * normalizes to "RS" and matches to the "RS Residential Single-Family"
 * setback row instead of degrading to the MF-2 conservative fallback.
 *
 * Geometry is small synthetic polygons in WGS84-shaped coordinates so the
 * PIP math is exercised deterministically. The LIVE alignment proof (real
 * Georgetown GIS: 120 Nolan Dr / R405006 and R580706 both PIP to ZONE "RS")
 * is captured in the PR body, not re-fetched here (offline-deterministic).
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { GeoJsonGeometry } from "../txgio/geo";
import {
  buildZoningIndex,
  representativePoint,
  stampParcelZoning,
  zoningCodeAtPoint,
} from "../txgio/zoning-stamp";
import {
  chunkPairs,
  stampCountyZoning,
  ZONING_STAMP_BATCH_SIZE,
  type ZoningStampDb,
} from "../txgio/zoning-stamp-db";
import { reduceZoningFeature } from "../txgio/zoning-service";
import { resolveZoningLayer } from "../txgio/zoning-layers";

/** A unit square [lo,hi]^2 as a GeoJSON Polygon carrying a district code. */
function squareFeature(
  code: string,
  west: number,
  south: number,
  size: number,
): { code: string; description: string; geometry: GeoJsonGeometry } {
  const e = west + size;
  const n = south + size;
  return {
    code,
    description: `${code} district`,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [e, south],
          [e, n],
          [west, n],
          [west, south],
        ],
      ],
    },
  };
}

/** A small square parcel centered at (cx, cy). */
function parcelSquare(cx: number, cy: number, half = 0.0005): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [
      [
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
        [cx - half, cy - half],
      ],
    ],
  };
}

describe("buildZoningIndex", () => {
  it("keeps well-formed features and drops code-less / geometry-less ones", () => {
    const index = buildZoningIndex([
      squareFeature("RS", -97.72, 30.71, 0.01),
      { code: "  ", description: null, geometry: squareFeature("X", 0, 0, 1).geometry },
      { code: "MF-2", description: null, geometry: null },
      squareFeature("IN", -97.7, 30.7, 0.01),
    ]);
    expect(index.map((p) => p.code)).toEqual(["RS", "IN"]);
    // Each indexed polygon carries a bbox for the pre-filter.
    expect(index[0]!.bbox.westLng).toBeCloseTo(-97.72, 6);
    expect(index[0]!.bbox.southLat).toBeCloseTo(30.71, 6);
    expect(index[0]!.bbox.eastLng).toBeCloseTo(-97.71, 6);
    expect(index[0]!.bbox.northLat).toBeCloseTo(30.72, 6);
  });
});

describe("representativePoint", () => {
  it("returns the area-centroid of a square (its center)", () => {
    const pt = representativePoint(parcelSquare(-97.715, 30.72, 0.001));
    expect(pt).not.toBeNull();
    expect(pt!.longitude).toBeCloseTo(-97.715, 6);
    expect(pt!.latitude).toBeCloseTo(30.72, 6);
  });

  it("returns null for a non-polygon geometry", () => {
    expect(
      representativePoint({ type: "Point", coordinates: [-97.7, 30.7] }),
    ).toBeNull();
  });
});

describe("zoningCodeAtPoint", () => {
  const index = buildZoningIndex([
    squareFeature("RS", -97.72, 30.71, 0.02),
    squareFeature("IN", -97.68, 30.71, 0.02),
  ]);

  it("finds the containing polygon's code", () => {
    expect(zoningCodeAtPoint(index, -97.71, 30.72)?.code).toBe("RS");
    expect(zoningCodeAtPoint(index, -97.67, 30.72)?.code).toBe("IN");
  });

  it("returns null when the point is in no polygon", () => {
    expect(zoningCodeAtPoint(index, -97.60, 30.60)).toBeNull();
  });
});

describe("stampParcelZoning (the load-bearing fix)", () => {
  // A Georgetown-shaped index: an RS single-family block and an MF-2 block.
  const index = buildZoningIndex([
    squareFeature("RS", -97.72, 30.715, 0.01),
    squareFeature("MF-2", -97.70, 30.715, 0.01),
  ]);

  it("stamps a single-family parcel 'RS' (not the MF-2 conservative fallback)", () => {
    // Parcel centroid inside the RS block — the 120 Nolan Dr case.
    const parcel = parcelSquare(-97.715, 30.72);
    const hit = stampParcelZoning(index, parcel);
    expect(hit).not.toBeNull();
    // Raw ZONE code stamped verbatim -> districtCode("RS") -> "RS ..." row.
    expect(hit!.code).toBe("RS");
  });

  it("stamps a parcel in the MF-2 block 'MF-2'", () => {
    const hit = stampParcelZoning(index, parcelSquare(-97.695, 30.72));
    expect(hit!.code).toBe("MF-2");
  });

  it("leaves a parcel outside every zoning polygon unstamped (null)", () => {
    // Outside the city extent -> honest conservative-fallback path.
    expect(stampParcelZoning(index, parcelSquare(-97.50, 30.50))).toBeNull();
  });
});

describe("reduceZoningFeature (ZONE/FULLZONE field mapping)", () => {
  it("pulls the configured code + description fields off a GeoJSON feature", () => {
    const feature = {
      type: "Feature",
      properties: { ZONE: "RS", FULLZONE: "Residential Single-Family" },
      geometry: parcelSquare(-97.715, 30.72),
    };
    const reduced = reduceZoningFeature(feature, {
      codeField: "ZONE",
      descriptionField: "FULLZONE",
    });
    expect(reduced.code).toBe("RS");
    expect(reduced.description).toBe("Residential Single-Family");
    expect(reduced.geometry).not.toBeNull();
  });

  it("yields a null code for a blank ZONE (never a fabricated district)", () => {
    const reduced = reduceZoningFeature(
      { type: "Feature", properties: { ZONE: "   " }, geometry: null },
      { codeField: "ZONE", descriptionField: "FULLZONE" },
    );
    expect(reduced.code).toBeNull();
  });
});

describe("reduceZoningFeature (codeExtractRegex — Hutto parenthesized code)", () => {
  // Hutto carries the district code parenthesized inside a longer string:
  // "Single Family (SF-1)". The regex pulls the token inside the parens so
  // the stamped code is the raw "SF-1" the setback table's leading token
  // matches — NOT the whole string, which would normalize to "SINGLEFAMILYSF1"
  // and match nothing.
  const HUTTO_REGEX = "\\(([^)]+)\\)";

  it("extracts the parenthesized token as the code", () => {
    const reduced = reduceZoningFeature(
      {
        type: "Feature",
        properties: { ZONING: "Single Family (SF-1)" },
        geometry: parcelSquare(-97.55, 30.54),
      },
      { codeField: "ZONING", descriptionField: "ZONING", codeExtractRegex: HUTTO_REGEX },
    );
    // Raw token, unmodified — the leading-token normalization does the rest.
    expect(reduced.code).toBe("SF-1");
    // description keeps the full human string (provenance).
    expect(reduced.description).toBe("Single Family (SF-1)");
  });

  it("extracts from other parenthesized values (B-2, OT-3)", () => {
    const commercial = reduceZoningFeature(
      { type: "Feature", properties: { ZONING: "General Commercial (B-2)" }, geometry: null },
      { codeField: "ZONING", codeExtractRegex: HUTTO_REGEX },
    );
    expect(commercial.code).toBe("B-2");
    const overlay = reduceZoningFeature(
      { type: "Feature", properties: { ZONING: "Residential (OT-3)" }, geometry: null },
      { codeField: "ZONING", codeExtractRegex: HUTTO_REGEX },
    );
    expect(overlay.code).toBe("OT-3");
  });

  it("yields NULL when the value has no parens (honest, never guessed)", () => {
    const reduced = reduceZoningFeature(
      { type: "Feature", properties: { ZONING: "Single Family" }, geometry: null },
      { codeField: "ZONING", codeExtractRegex: HUTTO_REGEX },
    );
    expect(reduced.code).toBeNull();
  });

  it("WITHOUT a regex returns the raw value unchanged (Georgetown path unaffected)", () => {
    const reduced = reduceZoningFeature(
      { type: "Feature", properties: { ZONE: "Single Family (SF-1)" }, geometry: null },
      { codeField: "ZONE" },
    );
    // No codeExtractRegex -> raw field value, exactly as today.
    expect(reduced.code).toBe("Single Family (SF-1)");
  });
});

describe("resolveZoningLayer (the 5 newly registered cities)", () => {
  it.each([
    ["round-rock-tx", "Round Rock", "48491", "BASE_ZONIN"],
    ["leander-tx", "Leander", "48491", "Use_"],
    ["new-braunfels-tx", "New Braunfels", "48091", "District"],
    ["dripping-springs-tx", "Dripping Springs", "48209", "Zoning_Abbreviation"],
    ["hutto-tx", "Hutto", "48491", "ZONING"],
  ])("resolves %s to %s (county %s, codeField %s)", (key, name, fips, codeField) => {
    const cfg = resolveZoningLayer(key);
    expect(cfg).toBeDefined();
    expect(cfg!.cityName).toBe(name);
    expect(cfg!.countyFips).toBe(fips);
    expect(cfg!.codeField).toBe(codeField);
  });

  it("wires codeExtractRegex ONLY on Hutto (Leander base code Use_, not Comp_Use)", () => {
    expect(resolveZoningLayer("hutto-tx")!.codeExtractRegex).toBe("\\(([^)]+)\\)");
    // The other four (and Georgetown) have no regex — raw code path.
    expect(resolveZoningLayer("round-rock-tx")!.codeExtractRegex).toBeUndefined();
    expect(resolveZoningLayer("leander-tx")!.codeExtractRegex).toBeUndefined();
    expect(resolveZoningLayer("new-braunfels-tx")!.codeExtractRegex).toBeUndefined();
    expect(resolveZoningLayer("dripping-springs-tx")!.codeExtractRegex).toBeUndefined();
    expect(resolveZoningLayer("georgetown-tx")!.codeExtractRegex).toBeUndefined();
    // Leander deliberately reads the base Use_ code, not the composite Comp_Use.
    expect(resolveZoningLayer("leander-tx")!.codeField).toBe("Use_");
  });
});

// ---------------------------------------------------------------------------
// stampCountyZoning batched write (the perf change)
//
// The write path was N sequential awaited per-parcel UPDATEs; it is now one
// set-based `VALUES`-join UPDATE per batch. These tests exercise the injected
// db against a fake that models the REAL per-cell duplication of txgio_parcel
// (one row per grid cell a feature's bbox touches) and executes the batched
// UPDATE by compiling the drizzle SQL and interpreting its bound params. That
// proves: correct code per feature_index, rowsUpdated summing per-cell dupes,
// dryRun writing nothing, and the chunk split at the batch cap.
// ---------------------------------------------------------------------------

const dialect = new PgDialect();

/** One physical `txgio_parcel` row in the fake table. */
interface FakeParcelRow {
  countyFips: string;
  featureIndex: number;
  /** grid-cell key — makes per-feature rows distinct (the dupe dimension). */
  tileKey: string;
  geometry: GeoJsonGeometry;
  zoningDistrict: string | null;
}

/**
 * A fake `ZoningStampDb` over an in-memory `txgio_parcel`. `selectDistinctOn`
 * returns one row per feature_index (geometry identical across a feature's
 * cells). `execute` compiles the batched-UPDATE SQL, pulls the (feature_index,
 * code) pairs + the county param back out of the compiled params, and applies
 * them to EVERY matching physical row — the real Postgres join behavior — so
 * the returned `rowCount` sums per-cell dupes exactly as prod would.
 */
interface FakeDb {
  db: ZoningStampDb;
  rows: FakeParcelRow[];
  readonly executeCalls: number;
}

function makeFakeDb(rows: FakeParcelRow[]): FakeDb {
  const table = rows.map((r) => ({ ...r }));
  let calls = 0;

  const db = {
    selectDistinctOn(_on: unknown, _cols: unknown) {
      // Chainable stub: .from().where().orderBy() -> distinct-by-feature rows.
      const chain = {
        from() {
          return chain;
        },
        where() {
          return chain;
        },
        orderBy() {
          const seen = new Set<number>();
          const out: { featureIndex: number; geometry: GeoJsonGeometry }[] = [];
          for (const r of table) {
            if (seen.has(r.featureIndex)) continue;
            seen.add(r.featureIndex);
            out.push({ featureIndex: r.featureIndex, geometry: r.geometry });
          }
          out.sort((a, b) => a.featureIndex - b.featureIndex);
          return Promise.resolve(out);
        },
      };
      return chain;
    },
    execute(query: SQL) {
      calls += 1;
      const { params } = dialect.sqlToQuery(query);
      // Template param order: the VALUES pairs (featureIndex, code) come
      // first, then the single trailing county_fips param. Peel the county
      // off the tail, then read pairs off the head.
      const county = params[params.length - 1] as string;
      const pairParams = params.slice(0, params.length - 1);
      const codeByFeature = new Map<number, string>();
      for (let i = 0; i < pairParams.length; i += 2) {
        codeByFeature.set(
          Number(pairParams[i]),
          String(pairParams[i + 1]),
        );
      }
      let rowCount = 0;
      for (const r of table) {
        if (r.countyFips !== county) continue;
        const code = codeByFeature.get(r.featureIndex);
        if (code === undefined) continue;
        r.zoningDistrict = code; // update in place (overwrite -> idempotent)
        rowCount += 1; // every physical (per-cell) row counts
      }
      return Promise.resolve({ rowCount });
    },
  } as unknown as ZoningStampDb;

  return {
    db,
    rows: table,
    get executeCalls() {
      return calls;
    },
  };
}

describe("chunkPairs", () => {
  it("splits into fixed-size chunks with a short final chunk", () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const chunks = chunkPairs(items, 10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 3]);
    expect(chunks.flat()).toEqual(items);
  });

  it("returns a single chunk when under the cap and none when empty", () => {
    expect(chunkPairs([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
    expect(chunkPairs([], 5)).toEqual([]);
  });

  it("rejects a non-positive size", () => {
    expect(() => chunkPairs([1], 0)).toThrow();
  });

  it("keeps the batch cap under pg's bound-param ceiling", () => {
    // 2 params/pair + 1 shared county param must stay < 65535.
    expect(ZONING_STAMP_BATCH_SIZE * 2 + 1).toBeLessThan(65535);
  });
});

describe("stampCountyZoning (batched write)", () => {
  // Georgetown-shaped index: RS block + MF-2 block (same as the PIP tests).
  const index = buildZoningIndex([
    squareFeature("RS", -97.72, 30.715, 0.01),
    squareFeature("MF-2", -97.70, 30.715, 0.01),
  ]);
  const COUNTY = "48091";

  // A parcel centroid inside the RS block, and one inside MF-2, and one
  // outside every polygon (stays NULL). feature_index 10 is duplicated
  // across THREE grid cells to prove rowsUpdated sums per-cell dupes.
  function seedRows(): FakeParcelRow[] {
    const rsGeom = parcelSquare(-97.715, 30.72); // -> RS
    const mfGeom = parcelSquare(-97.695, 30.72); // -> MF-2
    const outGeom = parcelSquare(-97.5, 30.5); // -> null (no polygon)
    return [
      // feature 10 (RS) across 3 cells
      { countyFips: COUNTY, featureIndex: 10, tileKey: "c1", geometry: rsGeom, zoningDistrict: null },
      { countyFips: COUNTY, featureIndex: 10, tileKey: "c2", geometry: rsGeom, zoningDistrict: null },
      { countyFips: COUNTY, featureIndex: 10, tileKey: "c3", geometry: rsGeom, zoningDistrict: null },
      // feature 11 (MF-2) single cell
      { countyFips: COUNTY, featureIndex: 11, tileKey: "c1", geometry: mfGeom, zoningDistrict: null },
      // feature 12 (outside) single cell -> stays NULL
      { countyFips: COUNTY, featureIndex: 12, tileKey: "c9", geometry: outGeom, zoningDistrict: null },
    ];
  }

  it("stamps the right code per feature_index and rowsUpdated sums per-cell dupes", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      index,
    });

    expect(summary.parcelsRead).toBe(3); // 3 distinct features
    expect(summary.parcelsMatched).toBe(2); // RS + MF-2
    expect(summary.parcelsUnmatched).toBe(1); // the outside one
    expect(summary.codeHistogram).toEqual({ RS: 1, "MF-2": 1 });

    // rowsUpdated counts ROWS: feature 10 = 3 cells, feature 11 = 1 cell = 4.
    // (>= parcelsMatched of 2 — invariant #1.)
    expect(summary.rowsUpdated).toBe(4);
    expect(summary.rowsUpdated).toBeGreaterThanOrEqual(summary.parcelsMatched);

    // Every physical row of the matched features carries the right code...
    const f10 = fake.rows.filter((r) => r.featureIndex === 10);
    expect(f10.map((r) => r.zoningDistrict)).toEqual(["RS", "RS", "RS"]);
    expect(fake.rows.find((r) => r.featureIndex === 11)!.zoningDistrict).toBe("MF-2");
    // ...and the unmatched feature stays NULL (never guessed — invariant #4).
    expect(fake.rows.find((r) => r.featureIndex === 12)!.zoningDistrict).toBeNull();
  });

  it("dryRun writes nothing (no execute, all rows stay NULL)", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      index,
      dryRun: true,
    });

    // PIP + histogram still computed...
    expect(summary.parcelsMatched).toBe(2);
    expect(summary.codeHistogram).toEqual({ RS: 1, "MF-2": 1 });
    // ...but nothing written.
    expect(summary.rowsUpdated).toBe(0);
    expect(fake.executeCalls).toBe(0);
    expect(fake.rows.every((r) => r.zoningDistrict === null)).toBe(true);
  });

  it("re-run overwrites in place (idempotent + additive)", async () => {
    const fake = makeFakeDb(seedRows());
    await stampCountyZoning({ db: fake.db, countyFips: COUNTY, index });
    const first = fake.rows.map((r) => r.zoningDistrict);
    const summary2 = await stampCountyZoning({ db: fake.db, countyFips: COUNTY, index });
    expect(fake.rows.map((r) => r.zoningDistrict)).toEqual(first);
    expect(summary2.rowsUpdated).toBe(4); // same rows re-stamped, same count
  });

  it("limit bounds parcelsRead (and only reads within the bound)", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      index,
      limit: 1,
    });
    expect(summary.parcelsRead).toBe(1); // only the first distinct feature
    // First distinct feature (index 10) is RS across 3 cells.
    expect(summary.parcelsMatched).toBe(1);
    expect(summary.rowsUpdated).toBe(3);
  });

  it("batches the write, splitting at the cap (multiple execute calls)", async () => {
    // Seed > 1 batch worth of RS-matching features, one cell each, all inside
    // the RS block on a fine grid so each is a distinct feature_index.
    const n = ZONING_STAMP_BATCH_SIZE + 7;
    const rows: FakeParcelRow[] = [];
    for (let i = 0; i < n; i++) {
      // Nudge the centroid within the RS block [-97.72,-97.71]x[30.715,30.725]
      const cx = -97.719 + (i % 100) * 0.00001;
      const cy = 30.716 + Math.floor(i / 100) * 0.00001;
      rows.push({
        countyFips: COUNTY,
        featureIndex: i,
        tileKey: "c1",
        geometry: parcelSquare(cx, cy, 0.00001),
        zoningDistrict: null,
      });
    }
    const fake = makeFakeDb(rows);
    const summary = await stampCountyZoning({ db: fake.db, countyFips: COUNTY, index });

    expect(summary.parcelsMatched).toBe(n);
    expect(summary.rowsUpdated).toBe(n); // one cell each
    // Split into ceil(n / cap) batches -> that many execute round-trips.
    expect(fake.executeCalls).toBe(Math.ceil(n / ZONING_STAMP_BATCH_SIZE));
    expect(fake.executeCalls).toBe(2);
    // And every seeded feature got stamped RS.
    expect(fake.rows.every((r) => r.zoningDistrict === "RS")).toBe(true);
  });
});
