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
import {
  esriRingsToGeoJson,
  reduceZoningFeature,
} from "../txgio/zoning-service";
import { resolveZoningLayer } from "../txgio/zoning-layers";
import { normalizePropId, parsePropIdsFile } from "../txgio/zoning-cli";

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

  it("accepts ArcGIS f=json features (attributes + rings)", () => {
    const reduced = reduceZoningFeature(
      {
        attributes: { CODE: "R-1" },
        geometry: {
          rings: [
            [
              [-97.7, 31.1],
              [-97.69, 31.1],
              [-97.69, 31.11],
              [-97.7, 31.11],
              [-97.7, 31.1],
            ],
          ],
        },
      },
      { codeField: "CODE" },
    );
    expect(reduced.code).toBe("R-1");
    expect(reduced.geometry?.type).toBe("Polygon");
    expect(esriRingsToGeoJson({ rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })?.type).toBe(
      "Polygon",
    );
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

describe("reduceZoningFeature (codeDomainMap — Bastrop ZoneTypeClass)", () => {
  // Zoned_Parcels/83 ZoneTypeClass is esriFieldTypeSmallInteger. LIVE REST
  // returns ZoneTypeClass:3 for prop_id 105054 (1010 Jefferson); domain name
  // is SF-1. Without the map the stamp would write "3" (or null if numbers
  // were rejected) and the BDC router looking for "SF-1" would miss.
  const BASTROP_DOMAIN = {
    "1": "P/OS",
    "2": "RR",
    "3": "SF-1",
    "4": "SF-2",
    "5": "SF-3",
    "6": "MU",
    "7": "GC",
    "8": "PI",
    "9": "IND",
    "10": "PDD",
  } as const;

  it("decodes LIVE prop_id 105054 ZoneTypeClass=3 to string SF-1", () => {
    const reduced = reduceZoningFeature(
      {
        attributes: {
          ZoneTypeClass: 3,
          ZoneDesc:
            "A district for detached single-family dwelling on larger lots",
          prop_id: 105054,
        },
        geometry: null,
      },
      {
        codeField: "ZoneTypeClass",
        descriptionField: "ZoneDesc",
        codeDomainMap: { ...BASTROP_DOMAIN },
      },
    );
    expect(reduced.code).toBe("SF-1");
    expect(reduced.code).not.toBe("3");
  });

  it("leaves unmapped domain ints null (never stamps bare 99)", () => {
    const reduced = reduceZoningFeature(
      { attributes: { ZoneTypeClass: 99 }, geometry: null },
      { codeField: "ZoneTypeClass", codeDomainMap: { ...BASTROP_DOMAIN } },
    );
    expect(reduced.code).toBeNull();
  });

  it("without a domain map, integer fields coerce to string (no silent drop)", () => {
    // Guard: numbers must not become null via string-only str().
    const reduced = reduceZoningFeature(
      { attributes: { ZoneTypeClass: 3 }, geometry: null },
      { codeField: "ZoneTypeClass" },
    );
    expect(reduced.code).toBe("3");
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

  it("uses the official San Marcos, Texas zoning service and its published fields", () => {
    const cfg = resolveZoningLayer("san-marcos-tx");
    expect(cfg).toMatchObject({
      countyFips: "48209",
      layerUrl:
        "https://smgis.sanmarcostx.gov/arcgis/rest/services/MPN/MyPermitNowFeatures/MapServer/6",
      codeField: "ZONECODE",
      descriptionField: "ZONINGDISTRICT",
    });
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

  it("wires bastrop-city-tx to Zoned_Parcels/83 ZoneTypeClass + BDC domain map (WDLL 6)", () => {
    const cfg = resolveZoningLayer("bastrop-city-tx")!;
    expect(cfg.layerUrl).toBe(
      "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83",
    );
    expect(cfg.codeField).toBe("ZoneTypeClass");
    expect(cfg.descriptionField).toBe("ZoneDesc");
    expect(cfg.layerUrl).not.toContain("Zoning_Place_Type");
    expect(cfg.codeField).not.toBe("PlaceTypeClass");
    expect(cfg.codeDomainMap?.["3"]).toBe("SF-1");
    expect(cfg.codeExtractRegex).toBeUndefined();
    // LIVE-shaped attributes → stamped district string, not integer 3.
    const reduced = reduceZoningFeature(
      { attributes: { ZoneTypeClass: 3, prop_id: 105054 }, geometry: null },
      cfg,
    );
    expect(reduced.code).toBe("SF-1");
  });

  it("wires elgin-tx to Elgin_Zoning/0 Zone_Code + CITY_LIMIT filter (2026-08-03 onboarding, Bastrop-county side only)", () => {
    const cfg = resolveZoningLayer("elgin-tx")!;
    expect(cfg.countyFips).toBe("48021");
    expect(cfg.layerUrl).toBe(
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/0",
    );
    expect(cfg.codeField).toBe("Zone_Code");
    expect(cfg.layerWhere).toBe("CITY_LIMIT = 'ELGIN'");
    expect(cfg.codeExtractRegex).toBeUndefined();
    // Named follow-on: the same FeatureServer's layer 1 (Travis-side sliver,
    // fips 48453) is NOT this layer's URL.
    expect(cfg.layerUrl).not.toContain("FeatureServer/1");
  });

  it("elgin-tx codeDomainMap: identity for 7 districts, A -> R-4 for the sole GIS/ordinance-naming divergence", () => {
    const cfg = resolveZoningLayer("elgin-tx")!;
    expect(cfg.codeDomainMap?.A).toBe("R-4");
    for (const code of ["R-1", "R-2", "R-3", "C-1", "C-2", "C-3", "I"]) {
      expect(cfg.codeDomainMap?.[code]).toBe(code);
    }
    // LIVE-shaped attributes → stamped district string.
    expect(
      reduceZoningFeature(
        { attributes: { Zone_Code: "A", PROP_ID: 1 }, geometry: null },
        cfg,
      ).code,
    ).toBe("R-4");
    expect(
      reduceZoningFeature(
        { attributes: { Zone_Code: "R-1", PROP_ID: 2 }, geometry: null },
        cfg,
      ).code,
    ).toBe("R-1");
    // An unmapped raw code (not in the domain map) falls through to NULL —
    // never a guessed district.
    expect(
      reduceZoningFeature(
        { attributes: { Zone_Code: "ETJ", PROP_ID: 3 }, geometry: null },
        cfg,
      ).code,
    ).toBeNull();
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
  zoningJurisdiction: string | null;
  /** CAD prop id, text column — undefined/omitted in older fixtures. */
  propId?: string | null;
}

/**
 * A fake `ZoningStampDb` over an in-memory `txgio_parcel`. `selectDistinctOn`
 * returns one row per feature_index (geometry identical across a feature's
 * cells), applying the REAL compiled `where` clause (county_fips [+ prop_id
 * = ANY(...) in scoped mode]) the same way `execute` interprets the batched
 * UPDATE — by compiling the drizzle SQL and reading bound params back out —
 * so a scoped-mode test proves the actual `AND prop_id = ANY(...)` SQL
 * shape is applied, not just that the function returns the right JS shape.
 * `execute` compiles the batched-UPDATE SQL, pulls the (feature_index,
 * code) pairs + the county param back out of the compiled params, and applies
 * them to EVERY matching physical row — the real Postgres join behavior — so
 * the returned `rowCount` sums per-cell dupes exactly as prod would.
 */
interface FakeDb {
  db: ZoningStampDb;
  rows: FakeParcelRow[];
  readonly executeCalls: number;
  /** Compiled SQL text of the most recent `.where(...)` clause (for assertions). */
  readonly lastWhereSql: string | undefined;
}

function makeFakeDb(rows: FakeParcelRow[]): FakeDb {
  const table = rows.map((r) => ({ ...r }));
  let calls = 0;
  let lastWhereSql: string | undefined;

  const db = {
    selectDistinctOn(_on: unknown, _cols: unknown) {
      // Chainable stub: .from().where().orderBy() -> distinct-by-feature rows.
      const chain = {
        from() {
          return chain;
        },
        where(whereClause: SQL) {
          const { sql: sqlText, params } = dialect.sqlToQuery(whereClause);
          lastWhereSql = sqlText;
          // Bound params in emission order: county_fips first, then (in
          // scoped mode) drizzle's `inArray` expands to one placeholder
          // PER value ("... in ($2, $3, $4)"), not a single array param —
          // so every param after index 0 is one prop id.
          const county = params[0] as string;
          const propIdList =
            params.length > 1 ? (params.slice(1) as string[]) : undefined;
          const filtered = table.filter((r) => {
            if (r.countyFips !== county) return false;
            if (propIdList !== undefined) {
              return r.propId != null && propIdList.includes(r.propId);
            }
            return true;
          });
          return {
            orderBy() {
              const seen = new Set<number>();
              const out: {
                featureIndex: number;
                geometry: GeoJsonGeometry;
                propId: string | null;
              }[] = [];
              for (const r of filtered) {
                if (seen.has(r.featureIndex)) continue;
                seen.add(r.featureIndex);
                out.push({
                  featureIndex: r.featureIndex,
                  geometry: r.geometry,
                  propId: r.propId ?? null,
                });
              }
              out.sort((a, b) => a.featureIndex - b.featureIndex);
              return Promise.resolve(out);
            },
          };
        },
      };
      return chain;
    },
    execute(query: SQL) {
      calls += 1;
      const { params } = dialect.sqlToQuery(query);
      // Template param order: VALUES triples (featureIndex, code, jurisdiction)
      // then the trailing county_fips param.
      const county = params[params.length - 1] as string;
      const tripleParams = params.slice(0, params.length - 1);
      const stampByFeature = new Map<
        number,
        { code: string; jurisdiction: string }
      >();
      for (let i = 0; i < tripleParams.length; i += 3) {
        stampByFeature.set(Number(tripleParams[i]), {
          code: String(tripleParams[i + 1]),
          jurisdiction: String(tripleParams[i + 2]),
        });
      }
      let rowCount = 0;
      for (const r of table) {
        if (r.countyFips !== county) continue;
        const stamp = stampByFeature.get(r.featureIndex);
        if (stamp === undefined) continue;
        r.zoningDistrict = stamp.code;
        r.zoningJurisdiction = stamp.jurisdiction;
        rowCount += 1;
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
    get lastWhereSql() {
      return lastWhereSql;
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
    // 3 params/triple + 1 shared county param must stay < 65535.
    expect(ZONING_STAMP_BATCH_SIZE * 3 + 1).toBeLessThan(65535);
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
      {
        countyFips: COUNTY,
        featureIndex: 10,
        tileKey: "c1",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      {
        countyFips: COUNTY,
        featureIndex: 10,
        tileKey: "c2",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      {
        countyFips: COUNTY,
        featureIndex: 10,
        tileKey: "c3",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // feature 11 (MF-2) single cell
      {
        countyFips: COUNTY,
        featureIndex: 11,
        tileKey: "c1",
        geometry: mfGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // feature 12 (outside) single cell -> stays NULL
      {
        countyFips: COUNTY,
        featureIndex: 12,
        tileKey: "c9",
        geometry: outGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
    ];
  }

  const CITY = "new-braunfels-tx";

  it("stamps the right code per feature_index and rowsUpdated sums per-cell dupes", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
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
    expect(f10.map((r) => r.zoningJurisdiction)).toEqual([CITY, CITY, CITY]);
    expect(fake.rows.find((r) => r.featureIndex === 11)!.zoningDistrict).toBe("MF-2");
    expect(fake.rows.find((r) => r.featureIndex === 11)!.zoningJurisdiction).toBe(CITY);
    // ...and the unmatched feature stays NULL (never guessed — invariant #4).
    expect(fake.rows.find((r) => r.featureIndex === 12)!.zoningDistrict).toBeNull();
    expect(fake.rows.find((r) => r.featureIndex === 12)!.zoningJurisdiction).toBeNull();
  });

  it("dryRun writes nothing (no execute, all rows stay NULL)", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
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
    await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
    });
    const first = fake.rows.map((r) => r.zoningDistrict);
    const summary2 = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
    });
    expect(fake.rows.map((r) => r.zoningDistrict)).toEqual(first);
    expect(summary2.rowsUpdated).toBe(4); // same rows re-stamped, same count
  });

  it("limit bounds parcelsRead (and only reads within the bound)", async () => {
    const fake = makeFakeDb(seedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
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
        zoningJurisdiction: null,
      });
    }
    const fake = makeFakeDb(rows);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
    });

    expect(summary.parcelsMatched).toBe(n);
    expect(summary.rowsUpdated).toBe(n); // one cell each
    // Split into ceil(n / cap) batches -> that many execute round-trips.
    expect(fake.executeCalls).toBe(Math.ceil(n / ZONING_STAMP_BATCH_SIZE));
    expect(fake.executeCalls).toBe(2);
    // And every seeded feature got stamped RS.
    expect(fake.rows.every((r) => r.zoningDistrict === "RS")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --prop-ids-file scoped mode (Bastrop 41 stamp-gap fix)
//
// `parsePropIdsFile`/`normalizePropId` (CLI file parsing) and
// `stampCountyZoning`'s `propIds` param (DB scoping) each get direct
// coverage. The whole-county path's own regression coverage above already
// proves byte-identical behavior when `propIds` is omitted — every one of
// those tests still passes unchanged with this file's edits.
// ---------------------------------------------------------------------------

describe("parsePropIdsFile", () => {
  it("parses one raw prop id per line, dedupes, ignores blank lines and comments", () => {
    const ids = parsePropIdsFile(
      "31131\n32634\n\n# a comment\n35793\n31131\n",
    );
    expect([...ids].sort()).toEqual(["31131", "32634", "35793"]);
  });

  it("accepts a full parcelNodeId and strips the county-fips prefix", () => {
    const ids = parsePropIdsFile("48021:31131\n48021:32634\n");
    expect([...ids].sort()).toEqual(["31131", "32634"]);
  });

  it("normalizes leading zeros the same as normalizeCadPropId", () => {
    const ids = parsePropIdsFile("0031131\n48021:0032634\n");
    expect([...ids].sort()).toEqual(["31131", "32634"]);
  });

  it("fails loud on an empty file (no usable lines)", () => {
    expect(() => parsePropIdsFile("")).toThrow(/empty/i);
    expect(() => parsePropIdsFile("\n\n  \n")).toThrow(/empty/i);
    expect(() => parsePropIdsFile("# only a comment\n")).toThrow(/empty/i);
  });

  it("fails loud on an unparseable (non-numeric) line", () => {
    expect(() => parsePropIdsFile("31131\nnot-a-prop-id\n")).toThrow(
      /not a positive integer/i,
    );
  });

  it("fails loud on a line that is only a colon (empty id after strip)", () => {
    expect(() => parsePropIdsFile("48021:\n")).toThrow();
  });
});

describe("normalizePropId", () => {
  it("strips leading zeros from an all-digit id", () => {
    expect(normalizePropId("0031131")).toBe("31131");
    expect(normalizePropId("31131")).toBe("31131");
  });

  it("leaves a non-numeric id untouched", () => {
    expect(normalizePropId("R-580706")).toBe("R-580706");
  });

  it("trims whitespace", () => {
    expect(normalizePropId("  31131  ")).toBe("31131");
  });
});

describe("stampCountyZoning (propIds scoped mode)", () => {
  // Same Georgetown-shaped index as the batched-write tests: RS block +
  // MF-2 block, plus a "no coverage" gap.
  const index = buildZoningIndex([
    squareFeature("RS", -97.72, 30.715, 0.01),
    squareFeature("MF-2", -97.70, 30.715, 0.01),
  ]);
  const COUNTY = "48021";
  const CITY = "bastrop-city-tx";

  function seedScopedRows(): FakeParcelRow[] {
    const rsGeom = parcelSquare(-97.715, 30.72); // -> RS
    const mfGeom = parcelSquare(-97.695, 30.72); // -> MF-2
    const outGeom = parcelSquare(-97.5, 30.5); // -> null (no polygon)
    return [
      // Target parcel 1 (RS), two grid cells (per-cell dupe).
      {
        countyFips: COUNTY,
        featureIndex: 100,
        tileKey: "c1",
        propId: "31131",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      {
        countyFips: COUNTY,
        featureIndex: 100,
        tileKey: "c2",
        propId: "31131",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // Target parcel 2 (MF-2), single cell.
      {
        countyFips: COUNTY,
        featureIndex: 101,
        tileKey: "c1",
        propId: "34529",
        geometry: mfGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // Target parcel 3, resolves in the store but centroid hits no polygon.
      {
        countyFips: COUNTY,
        featureIndex: 102,
        tileKey: "c1",
        propId: "51847",
        geometry: outGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // NON-target parcel in the SAME county, inside the RS block — must
      // NOT be read or stamped by a scoped run (the whole point of #8's
      // fix: a bastrop-city-tx run today touches every county_fips=48021
      // row; scoped mode must not).
      {
        countyFips: COUNTY,
        featureIndex: 999,
        tileKey: "c1",
        propId: "99999999",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
    ];
  }

  it("restricts the read to exactly the requested prop ids (SQL carries prop_id IN (...))", async () => {
    const fake = makeFakeDb(seedScopedRows());
    const propIds = new Set(["31131", "34529", "51847"]);
    await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
      propIds,
    });
    expect(fake.lastWhereSql).toContain("county_fips");
    expect(fake.lastWhereSql).toMatch(/prop_id.*in/i);
  });

  it("stamps only the 3 requested parcels, leaving the non-target row in the same county untouched", async () => {
    const fake = makeFakeDb(seedScopedRows());
    const propIds = new Set(["31131", "34529", "51847"]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
      propIds,
    });

    expect(summary.parcelsRead).toBe(3); // NOT 4 -- the non-target row is excluded
    expect(summary.parcelsMatched).toBe(2); // RS + MF-2
    expect(summary.parcelsUnmatched).toBe(1); // the no-coverage one

    // Named scoped-mode counts, every one explicit.
    expect(summary.listSize).toBe(3);
    expect(summary.matched).toBe(3); // all 3 requested ids resolved to a row
    expect(summary.notFoundInParcelStore).toEqual([]);
    expect(summary.noZoningPolygonHit).toEqual(["51847"]);

    // The non-target parcel (feature 999, same county, inside the RS
    // polygon) must remain completely unstamped.
    const untouched = fake.rows.find((r) => r.featureIndex === 999)!;
    expect(untouched.zoningDistrict).toBeNull();
    expect(untouched.zoningJurisdiction).toBeNull();

    // The 2 matched target parcels ARE stamped.
    expect(
      fake.rows.filter((r) => r.featureIndex === 100).every((r) => r.zoningDistrict === "RS"),
    ).toBe(true);
    expect(fake.rows.find((r) => r.featureIndex === 101)!.zoningDistrict).toBe("MF-2");
    // The no-coverage target stays NULL (never guessed).
    expect(fake.rows.find((r) => r.featureIndex === 102)!.zoningDistrict).toBeNull();
  });

  it("reports notFoundInParcelStore for requested ids absent from the store", async () => {
    const fake = makeFakeDb(seedScopedRows());
    const propIds = new Set(["31131", "does-not-exist-99999"]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
      propIds,
    });
    expect(summary.listSize).toBe(2);
    expect(summary.matched).toBe(1);
    expect(summary.notFoundInParcelStore).toEqual(["does-not-exist-99999"]);
  });

  it("dry-run scoped mode: PIP computed, per-parcel table populated, zero writes", async () => {
    const fake = makeFakeDb(seedScopedRows());
    const propIds = new Set(["31131", "34529", "51847"]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
      propIds,
      dryRun: true,
    });
    expect(summary.rowsUpdated).toBe(0);
    expect(fake.executeCalls).toBe(0);
    expect(fake.rows.every((r) => r.zoningDistrict === null)).toBe(true);

    // The would-stamp per-parcel table is still populated (dry-run predicts
    // apply for exactly the 3 requested parcels).
    expect(summary.perParcel).toHaveLength(3);
    const byPropId = new Map(summary.perParcel!.map((r) => [r.propId, r.district]));
    expect(byPropId.get("31131")).toBe("RS");
    expect(byPropId.get("34529")).toBe("MF-2");
    expect(byPropId.get("51847")).toBeNull();
  });

  it("UNSCOPED mode (no propIds) omits every scoped-mode field (whole-county path unaffected)", async () => {
    const fake = makeFakeDb(seedScopedRows());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index,
    });
    // The unscoped run reads ALL 5 rows in the county (including the
    // "non-target" one -- proving whole-county behavior is untouched).
    expect(summary.parcelsRead).toBe(4); // 4 distinct feature_index values
    expect(summary.listSize).toBeUndefined();
    expect(summary.matched).toBeUndefined();
    expect(summary.notFoundInParcelStore).toBeUndefined();
    expect(summary.noZoningPolygonHit).toBeUndefined();
    expect(summary.perParcel).toBeUndefined();
  });
});
