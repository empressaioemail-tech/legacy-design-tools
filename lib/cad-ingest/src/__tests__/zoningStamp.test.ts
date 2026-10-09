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
import { pointInGeometry } from "../txgio/geo";
import {
  buildParcelIdIndex,
  buildZoningIndex,
  representativePoint,
  stampParcelZoning,
  zoningCodeAtPoint,
} from "../txgio/zoning-stamp";
import {
  chunkPairs,
  noAccountReason,
  stampCountyZoning,
  ZONING_STAMP_BATCH_SIZE,
  type ZoningStampDb,
} from "../txgio/zoning-stamp-db";
import {
  esriRingsToGeoJson,
  reduceZoningFeature,
} from "../txgio/zoning-service";
import { resolveZoningLayer, wiredZoningCityKeys } from "../txgio/zoning-layers";
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

  // Catastrophic-cancellation regression (2026-08-05, WDLL): the shoelace
  // centroid formula sums `(x+x')*cross` over the ring. At real WGS84
  // magnitude (lng ~-97, lat ~30) with a small (~tens-of-meters) irregular
  // parcel, `cross` is ~1e-7..1e-9 while `(x+x')` is ~-194 — multiplying a
  // ~200-magnitude term into a ~1e-8 accumulator loses most of the
  // significant digits before the final divide, so the "centroid" can land
  // tens of meters outside the parcel. A symmetric square (the test above)
  // can't expose this: its centroid falls out by construction regardless
  // of accumulation order. This is the LIVE Bastrop prop_id 31131 ring
  // (county_fips 48021, feature_index 15372, txgio_parcel geometry as of
  // 2026-08-05) that reproduced the bug against production data: the
  // pre-fix formula returned a point ~21m east / ~7m south of the true
  // centroid, outside both the parcel's own bbox and its own zoning
  // polygon (Zoned_Parcels/83 SF-1) — which is why the scoped 41-parcel
  // Bastrop stamp (PR #385) reproduced the exact same miss the unscoped
  // whole-county run always had; the bug lives in this shared function,
  // not in scoping.
  it("stays inside the parcel's own polygon for a real small irregular Bastrop ring (regression: was ~21m outside)", () => {
    const ring: [number, number][] = [
      [-97.28584166799999, 30.095365249000054],
      [-97.28592912299996, 30.095523184000058],
      [-97.28598028799996, 30.09561558200005],
      [-97.28556463099994, 30.095633673000066],
      [-97.28555975499995, 30.095552836000024],
      [-97.28554800299997, 30.095387860000073],
      [-97.28554799899996, 30.095387807000066],
      [-97.28554704599998, 30.09537576500003],
      [-97.28553842899998, 30.095273444000043],
      [-97.28562398599996, 30.09528965100003],
      [-97.28563519099998, 30.095310416000075],
      [-97.28565021099996, 30.095329270000036],
      [-97.28566862999998, 30.095345689000055],
      [-97.28568993299996, 30.09535921500003],
      [-97.28571352699998, 30.095369470000037],
      [-97.28573875499995, 30.095376170000065],
      [-97.28576491199999, 30.095379127000058],
      [-97.28579127199998, 30.09537825800004],
      [-97.28581709599996, 30.09537358800003],
      [-97.28584166799999, 30.095365249000054], // closed
    ];
    const geometry: GeoJsonGeometry = { type: "Polygon", coordinates: [ring] };
    const pt = representativePoint(geometry);
    expect(pt).not.toBeNull();
    // Pre-fix (buggy) value was {longitude: -97.28550363594896, latitude:
    // 30.095421178754524} — outside the ring's own bbox
    // ([-97.28598029, 30.09527344] to [-97.28553843, 30.09563367]).
    // Post-fix value (verified against the origin-shifted shoelace
    // computed independently) is within the ring's bbox and inside the
    // polygon.
    expect(pt!.longitude).toBeGreaterThanOrEqual(-97.28598028799996);
    expect(pt!.longitude).toBeLessThanOrEqual(-97.28553842899998);
    expect(pt!.latitude).toBeGreaterThanOrEqual(30.095273444000043);
    expect(pt!.latitude).toBeLessThanOrEqual(30.095633673000066);
    expect(pointInGeometry(pt!.longitude, pt!.latitude, geometry)).toBe(true);
  });

  it("gives the same centroid regardless of coordinate magnitude (translation-invariance proof)", () => {
    // A small irregular triangle, once at real WGS84 magnitude and once
    // translated near the origin. The TRUE centroid is translation-
    // invariant, so the two results must differ by exactly the applied
    // shift — any drift beyond float noise means the accumulation is
    // still magnitude-sensitive.
    const shape = (ox: number, oy: number): [number, number][] => [
      [ox + 0, oy + 0],
      [ox + 0.0002, oy + 0.00005],
      [ox + 0.00005, oy + 0.0003],
      [ox + 0, oy + 0],
    ];
    const real = representativePoint({
      type: "Polygon",
      coordinates: [shape(-97.28, 30.09)],
    })!;
    const nearOrigin = representativePoint({
      type: "Polygon",
      coordinates: [shape(0, 0)],
    })!;
    expect(real.longitude - -97.28).toBeCloseTo(nearOrigin.longitude, 9);
    expect(real.latitude - 30.09).toBeCloseTo(nearOrigin.latitude, 9);
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
    // Layer 1 (Travis-side sliver, fips 48453) is NOT this layer's URL —
    // it is the separate "elgin-tx-travis" registry entry below.
    expect(cfg.layerUrl).not.toContain("FeatureServer/1");
  });

  it("wires elgin-tx-travis to Elgin_Zoning/1 for county 48453, same cityKey as the Bastrop-side entry (CTX-ELGIN, P-124, 2026-09-08)", () => {
    const cfg = resolveZoningLayer("elgin-tx-travis")!;
    expect(cfg.countyFips).toBe("48453");
    expect(cfg.layerUrl).toBe(
      "https://services3.arcgis.com/wdTkTU0MdZbNBEZy/arcgis/rest/services/Elgin_Zoning/FeatureServer/1",
    );
    expect(cfg.codeField).toBe("Zone_Code");
    expect(cfg.layerWhere).toBe("CITY_LIMIT = 'ELGIN'");
    // Not a distinct jurisdiction: cityKey stays "elgin-tx" so
    // stampCountyZoning persists zoning_jurisdiction="elgin-tx" and
    // isElginCityJurisdiction (lib/adapters's setbacks index) still routes
    // Travis-side Elgin parcels to the ratified elgin-development-code
    // setback table, same as the Bastrop-side cohort.
    expect(cfg.cityKey).toBe("elgin-tx");
    expect(cfg.cityKey).not.toBe("elgin-tx-travis");
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
// Burnet (48053, OPS-24 Phase 1). Before this registration LDT's loader
// carried no Burnet city at all — 0 of 59,785 Burnet txgio_parcel rows were
// zoning-stamped (verified live on CORTEX_DATABASE_URL, 2026-10-08).
// REMOVAL PROOF for this whole describe block: delete either entry from
// ZONING_LAYERS (zoning-layers.ts) and `resolveZoningLayer` below returns
// `undefined`, failing every `cfg!.x` assertion immediately.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Bug 1 regression (2026-10-09, Burnet stage 3 §3): stampParcelZoning must
// never stamp a parcel from a NEIGHBOUR's polygon when its own centroid
// falls outside its own ring. REAL production geometry (48053:112953,
// Marble Falls sample #41, a 3.63-ac road parcel) — proven live (see PR
// body) that the bare shoelace centroid lands OUTSIDE this exact ring, at
// (-98.27717726145636, 30.55312105716379).
// ---------------------------------------------------------------------------
describe("stampParcelZoning (Bug 1 regression — centroid outside own ring)", () => {
  const prop112953Ring: [number, number][] = [
          [-98.27576145899997, 30.552891126000077],
          [-98.27575755499998, 30.552875657000072],
          [-98.27592559399994, 30.552860709000072],
          [-98.27592881799995, 30.55286908200003],
          [-98.27593351599995, 30.552876914000024],
          [-98.27593957399995, 30.55288401400003],
          [-98.27594684199994, 30.55289020400005],
          [-98.27595513899996, 30.552895334000027],
          [-98.27596426399998, 30.552899276000062],
          [-98.27597398799998, 30.552901932000054],
          [-98.27598407299996, 30.552903238000056],
          [-98.27599426999996, 30.552903160000028],
          [-98.27607408299997, 30.55289638200003],
          [-98.27616124799994, 30.552890276000028],
          [-98.27630202799998, 30.55287760500005],
          [-98.27636419699996, 30.552870201000076],
          [-98.27647424099996, 30.552854339000078],
          [-98.27658354999994, 30.552835040000048],
          [-98.27669197999995, 30.55281233100004],
          [-98.27774763899998, 30.552573651000046],
          [-98.27928097099999, 30.552235245000077],
          [-98.27935901699999, 30.552214768000056],
          [-98.27943480299996, 30.552188692000072],
          [-98.27950779199995, 30.552157203000036],
          [-98.27957746899995, 30.552120523000042],
          [-98.27964334199999, 30.552078910000034],
          [-98.27970494599998, 30.55203265800003],
          [-98.27976184799996, 30.55198209300005],
          [-98.27978993299996, 30.55195524800007],
          [-98.27985806599997, 30.551885071000072],
          [-98.27992096299994, 30.551811324000028],
          [-98.27997837499998, 30.551734298000042],
          [-98.28001905999997, 30.551672367000037],
          [-98.28005619799995, 30.551608789000056],
          [-98.28009131199997, 30.55154047800005],
          [-98.28012225099997, 30.55147067200005],
          [-98.28014893299996, 30.55139956200003],
          [-98.28019324799999, 30.551268312000047],
          [-98.28038474399995, 30.551290203000065],
          [-98.28033070299995, 30.551444359000072],
          [-98.28032109399999, 30.55147170300006],
          [-98.28031091899999, 30.551498895000066],
          [-98.28030562099997, 30.55151243000006],
          [-98.28029460599998, 30.55153937500006],
          [-98.28028888899996, 30.551552783000034],
          [-98.28024163299995, 30.55165183300005],
          [-98.28018679599995, 30.551747913000042],
          [-98.28012462599997, 30.55184058900005],
          [-98.28005540599997, 30.551929441000027],
          [-98.28004566099997, 30.55194097800006],
          [-98.27998471399997, 30.552008568000076],
          [-98.27993629999997, 30.552057346000026],
          [-98.27990884599996, 30.552083793000065],
          [-98.27989145299995, 30.552100369000073],
          [-98.27982248199999, 30.552159394000057],
          [-98.27974797799999, 30.55221314700003],
          [-98.27966847999994, 30.552261241000053],
          [-98.27958455699996, 30.552303332000065],
          [-98.27949681499996, 30.552339115000052],
          [-98.27940588299998, 30.55236833400005],
          [-98.27939355399997, 30.552371721000043],
          [-98.27936876399997, 30.552378133000047],
          [-98.27934381499995, 30.552384059000076],
          [-98.27847900999996, 30.552579579000053],
          [-98.27784406799998, 30.552723126000046],
          [-98.27678867999998, 30.552961735000054],
          [-98.27678460699997, 30.55296264900005],
          [-98.27664640699999, 30.552990978000025],
          [-98.27650691799994, 30.55301409100008],
          [-98.27636640199995, 30.553031944000054],
          [-98.27622512299996, 30.553044502000034],
          [-98.27621843599997, 30.55304497000003],
          [-98.27604015699995, 30.55305745800007],
          [-98.27602783199995, 30.553059133000033],
          [-98.27601596099998, 30.553062458000056],
          [-98.27600483999998, 30.55306735000005],
          [-98.27599473999999, 30.553073690000076],
          [-98.27598591099996, 30.553081320000047],
          [-98.27597857299997, 30.553090052000073],
          [-98.27597290499995, 30.55309967100004],
          [-98.27596904699999, 30.553109939000024],
          [-98.27596709599999, 30.55312060400007],
          [-98.27596060199994, 30.553172792000055],
          [-98.27595063299998, 30.553224568000076],
          [-98.27593269999994, 30.553290445000073],
          [-98.27590914399997, 30.55335498200003],
          [-98.27579943099994, 30.55362415700006],
          [-98.27574464899999, 30.55375813300003],
          [-98.27561124299996, 30.554085435000047],
          [-98.27560643599998, 30.554097227000057],
          [-98.27552857099994, 30.554288261000067],
          [-98.27550078899998, 30.554349321000075],
          [-98.27546839199994, 30.554408654000042],
          [-98.27543152399994, 30.554466000000048],
          [-98.27539034699998, 30.55452110400006],
          [-98.27534195699997, 30.55457718200006],
          [-98.27528916799997, 30.554630202000055],
          [-98.27523223399999, 30.554679907000036],
          [-98.27517143499995, 30.55472605600005],
          [-98.27510706499999, 30.55476842300004],
          [-98.27506139799999, 30.55480018600008],
          [-98.27502087599999, 30.554836806000026],
          [-98.27498618499999, 30.55487766600004],
          [-98.27495790999996, 30.554922075000036],
          [-98.27493652999999, 30.55496928200006],
          [-98.27492240399994, 30.555018491000055],
          [-98.27491577299998, 30.555068869000024],
          [-98.27491454099999, 30.555132832000027],
          [-98.27491833399995, 30.555196720000026],
          [-98.27492989099994, 30.55527500900007],
          [-98.27494898399999, 30.55535218400007],
          [-98.27497547999997, 30.555427703000078],
          [-98.27487626599998, 30.55545621400006],
          [-98.27484000299995, 30.55546663100006],
          [-98.27479202999996, 30.555480413000055],
          [-98.27478345199995, 30.555458246000057],
          [-98.27476103299995, 30.55539086300007],
          [-98.27474364499994, 30.55532237700004],
          [-98.27473898099998, 30.555299352000077],
          [-98.27472755499997, 30.555222074000028],
          [-98.27472251199998, 30.555144289000054],
          [-98.27472387699999, 30.555066389000046],
          [-98.27472392399994, 30.555065654000032],
          [-98.27472972499999, 30.555014241000038],
          [-98.27474107599994, 30.55496352600005],
          [-98.27475787599997, 30.554913956000064],
          [-98.27477997499994, 30.554865970000037],
          [-98.27479258599999, 30.55484332800006],
          [-98.27481621399994, 30.554806779000046],
          [-98.27482655499995, 30.554792613000075],
          [-98.27483738599994, 30.554778725000062],
          [-98.27487274999999, 30.554738867000026],
          [-98.27487904799995, 30.554732503000025],
          [-98.27491216999994, 30.554701969000064],
          [-98.27494787999996, 30.554673704000038],
          [-98.27495531599999, 30.554668338000056],
          [-98.27498597499994, 30.554647874000068],
          [-98.27499385899995, 30.554643011000053],
          [-98.27506316399996, 30.554596392000064],
          [-98.27512721999994, 30.554544453000062],
          [-98.27514334299997, 30.554529758000058],
          [-98.27518436199995, 30.55448883100007],
          [-98.27518914699999, 30.554483685000037],
          [-98.27520353099999, 30.55446769400004],
          [-98.27523745999997, 30.554426418000048],
          [-98.27526839699999, 30.554383419000033],
          [-98.27527990799996, 30.55436577200004],
          [-98.27531380399995, 30.554306824000037],
          [-98.27534215799994, 30.554245725000044],
          [-98.27538867299995, 30.554131605000066],
          [-98.27552091299998, 30.55380716600007],
          [-98.27560023899997, 30.553612543000042],
          [-98.27572774499998, 30.553299714000048],
          [-98.27575036099995, 30.55323591000007],
          [-98.27576027899994, 30.55319874500003],
          [-98.27576441199994, 30.553180009000073],
          [-98.27577228799998, 30.553132821000077],
          [-98.27577532999999, 30.553104332000032],
          [-98.27577709999997, 30.553075764000027],
          [-98.27577636499996, 30.55301033300003],
          [-98.27577614899997, 30.553001082000037],
          [-98.27577345799995, 30.55296157500004],
          [-98.27576792199994, 30.552922290000026],
          [-98.27576145899997, 30.552891126000077],
  ];
  const prop112953Geometry: GeoJsonGeometry = {
    type: "Polygon",
    coordinates: [prop112953Ring],
  };

  it("never stamps the neighbour's district when the bare centroid lands outside the parcel's own ring", () => {
    // A small neighbour "MR" polygon placed exactly where the UNCHECKED
    // centroid (-98.27717726145636, 30.55312105716379) falls — reproducing
    // the live Marble Falls MR polygon's position relative to this parcel
    // — and deliberately SMALL enough to exclude the true interior point
    // (-98.27638561467619, 30.55291276400004) the fix uses instead, so a
    // pass here proves the fix path, not an oversized box that would catch
    // both. On the PRE-FIX code (bare centroid, no inside-check) this
    // stamps "MR"; the fix must leave it unmatched instead of crossing
    // into the neighbour.
    const index = buildZoningIndex([
      squareFeature("MR", -98.2773, 30.553, 0.0004),
    ]);
    const hit = stampParcelZoning(index, prop112953Geometry);
    expect(hit).toBeNull();
  });

  it("the plain centroid really is outside this parcel's own ring (confirms the premise)", () => {
    const centroid = representativePoint(prop112953Geometry)!;
    expect(pointInGeometry(centroid.longitude, centroid.latitude, prop112953Geometry)).toBe(
      false,
    );
  });

  it("still finds the REAL district when one actually covers the parcel's true interior", () => {
    // A small "GC" polygon placed over the parcel's own true interior
    // area (near its widest stretch, around -98.2764/30.5529) must still
    // be found — the fix does not make every Bug-1-class parcel unmatched,
    // only stops it from crossing into an unrelated neighbour.
    const index = buildZoningIndex([
      squareFeature("GC", -98.277, 30.5525, 0.002),
    ]);
    const hit = stampParcelZoning(index, prop112953Geometry);
    expect(hit?.code).toBe("GC");
  });
});

describe("resolveZoningLayer (Burnet: Marble Falls + Horseshoe Bay)", () => {
  it.each([
    ["marble-falls-tx", "Marble Falls", "Zone_ID", "Zone_Name"],
    ["horseshoe-bay-tx", "Horseshoe Bay", "ZONING", "SUB_ZONING"],
  ])("resolves %s to %s (county 48053, codeField %s, descriptionField %s)", (key, name, codeField, descriptionField) => {
    const cfg = resolveZoningLayer(key);
    expect(cfg).toBeDefined();
    expect(cfg!.cityKey).toBe(key);
    expect(cfg!.cityName).toBe(name);
    expect(cfg!.countyFips).toBe("48053");
    expect(cfg!.codeField).toBe(codeField);
    expect(cfg!.descriptionField).toBe(descriptionField);
  });

  it("Marble Falls targets the public MapServer/16 zoning layer, no transform configured", () => {
    const cfg = resolveZoningLayer("marble-falls-tx")!;
    expect(cfg.layerUrl).toBe(
      "https://mfgis.marblefallstx.gov/arcgis/rest/services/Planning/PDS/MapServer/16",
    );
    // Zone_ID already publishes the register's own short code (NR/GC/DT/
    // ENZ.4/...) verbatim — the Georgetown-pattern simplest case.
    expect(cfg.codeExtractRegex).toBeUndefined();
    expect(cfg.codeDomainMap).toBeUndefined();
    expect(cfg.baseCodeParse).toBeUndefined();
    expect(cfg.nullDistrictCodes).toBeUndefined();
  });

  it("Horseshoe Bay targets the Public/Zoning FeatureServer/2 layer resolved off the city's own web map, no transform configured", () => {
    const cfg = resolveZoningLayer("horseshoe-bay-tx")!;
    expect(cfg.layerUrl).toBe(
      "https://horseshoebaygis.newedgeservices.com/arcgis/rest/services/Public/Zoning/FeatureServer/2",
    );
    // ZONING already publishes the register's own code (R-1/A-1/C-2/...)
    // verbatim.
    expect(cfg.codeExtractRegex).toBeUndefined();
    expect(cfg.codeDomainMap).toBeUndefined();
    expect(cfg.baseCodeParse).toBeUndefined();
    expect(cfg.nullDistrictCodes).toBeUndefined();
  });

  it("Marble Falls live-shaped attributes reduce to the raw Zone_ID (sample #56, 48053:112952)", () => {
    const cfg = resolveZoningLayer("marble-falls-tx")!;
    const reduced = reduceZoningFeature(
      {
        attributes: {
          Zone_ID: "ENZ.4",
          Zone_Name: "Existing Neighborhood Zone 4",
          Ordinance: "2018-O-10B",
          Year_Zoned: 2019,
        },
        geometry: null,
      },
      cfg,
    );
    expect(reduced.code).toBe("ENZ.4");
    expect(reduced.description).toBe("Existing Neighborhood Zone 4");
  });

  it("Horseshoe Bay live-shaped attributes reduce to the raw ZONING code (sample #38, 48053:23169, R-4/R-4-MF)", () => {
    const cfg = resolveZoningLayer("horseshoe-bay-tx")!;
    const reduced = reduceZoningFeature(
      {
        attributes: {
          PROP_ID: 23169,
          ZONING: "R-4",
          SUB_ZONING: "R-4-MF",
          LANDUSE: "MULTI-FAMILY RESIDENTIAL",
        },
        geometry: null,
      },
      cfg,
    );
    expect(reduced.code).toBe("R-4");
    expect(reduced.description).toBe("R-4-MF");
  });

  it("Horseshoe Bay KNOWN SPECIAL CASES: a blank ZONING field (CA / UNK in staging) reduces to NULL, never a guessed district", () => {
    const cfg = resolveZoningLayer("horseshoe-bay-tx")!;
    // 48053:69366 — COMMON AREA land use; the live layer's own ZONING field
    // is blank (the register's CA row documents it is not an adopted
    // district, but no registry-level filter is needed: the field is
    // already empty on the city's own layer).
    expect(
      reduceZoningFeature(
        {
          attributes: { PROP_ID: 69366, ZONING: null, SUB_ZONING: null, LANDUSE: "COMMON AREA" },
          geometry: null,
        },
        cfg,
      ).code,
    ).toBeNull();
    // 48053:106280 — "UNK" in the old staging snapshot; also blank live.
    expect(
      reduceZoningFeature(
        {
          attributes: { PROP_ID: 106280, ZONING: "", SUB_ZONING: "", LANDUSE: "VACANT LAND" },
          geometry: null,
        },
        cfg,
      ).code,
    ).toBeNull();
    // A whitespace-only value (measured live: 6 features on this layer)
    // trims the same way.
    expect(
      reduceZoningFeature(
        { attributes: { PROP_ID: 1, ZONING: "  ", SUB_ZONING: null }, geometry: null },
        cfg,
      ).code,
    ).toBeNull();
  });

  it("FIXTURE: a parcel with no zoning polygon under it yields the declared no-district outcome (null), never a guess", () => {
    // Models WDLL Appendix A #42 (48053:103196, Marble Falls riverbank — no
    // zoning polygon on the live layer at this parcel's representative
    // point, confirmed live 2026-10-08). A synthetic index carrying ONLY an
    // NR polygon far from this parcel proves the miss is a true "outside
    // every polygon" case, not an artifact of an empty index.
    const index = buildZoningIndex([
      squareFeature("NR", -98.30, 30.49, 0.01), // nowhere near the parcel below
    ]);
    const noPolygonParcel = parcelSquare(-98.2742, 30.5654, 0.0005); // 103196-shaped
    const hit = stampParcelZoning(index, noPolygonParcel);
    expect(hit).toBeNull();
  });

  it("FIXTURE: a parcel centered inside a registered Marble Falls polygon stamps that polygon's raw Zone_ID", () => {
    const index = buildZoningIndex([
      squareFeature("NR", -98.3025, 30.4932, 0.002),
    ]);
    const parcel = parcelSquare(-98.302056, 30.493671, 0.0003); // sample #7 shaped
    const hit = stampParcelZoning(index, parcel);
    expect(hit?.code).toBe("NR");
  });

  it("wiredZoningCityKeys(48053) composes the SET {marble-falls-tx, horseshoe-bay-tx} — never a sole-city assumption", () => {
    expect(wiredZoningCityKeys("48053")).toEqual(
      new Set(["marble-falls-tx", "horseshoe-bay-tx"]),
    );
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
  /** P-259b disclosure column on the stamped row. */
  zoningDistrictInterim?: boolean | null;
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
 * `execute` compiles the batched-UPDATE SQL, pulls the (feature_index, code,
 * jurisdiction, interim) tuples + the county param back out of the compiled
 * params, and applies them to EVERY matching physical row — the real Postgres
 * join behavior — so the returned `rowCount` sums per-cell dupes exactly as
 * prod would.
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
      // Template param order: VALUES quadruples
      // (featureIndex, code, jurisdiction, interim) then the trailing
      // county_fips param.
      const county = params[params.length - 1] as string;
      const tupleParams = params.slice(0, params.length - 1);
      const stampByFeature = new Map<
        number,
        { code: string; jurisdiction: string; interim: boolean }
      >();
      for (let i = 0; i < tupleParams.length; i += 4) {
        stampByFeature.set(Number(tupleParams[i]), {
          code: String(tupleParams[i + 1]),
          jurisdiction: String(tupleParams[i + 2]),
          interim: tupleParams[i + 3] === true,
        });
      }
      let rowCount = 0;
      for (const r of table) {
        if (r.countyFips !== county) continue;
        const stamp = stampByFeature.get(r.featureIndex);
        if (stamp === undefined) continue;
        r.zoningDistrict = stamp.code;
        r.zoningJurisdiction = stamp.jurisdiction;
        r.zoningDistrictInterim = stamp.interim;
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
    // 4 params/tuple (feature_index, code, jurisdiction, interim) + 1 shared
    // county param must stay < 65535.
    expect(ZONING_STAMP_BATCH_SIZE * 4 + 1).toBeLessThan(65535);
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
        propId: "10010",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      {
        countyFips: COUNTY,
        featureIndex: 10,
        tileKey: "c2",
        propId: "10010",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      {
        countyFips: COUNTY,
        featureIndex: 10,
        tileKey: "c3",
        propId: "10010",
        geometry: rsGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // feature 11 (MF-2) single cell
      {
        countyFips: COUNTY,
        featureIndex: 11,
        tileKey: "c1",
        propId: "10011",
        geometry: mfGeom,
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
      // feature 12 (outside) single cell -> stays NULL
      {
        countyFips: COUNTY,
        featureIndex: 12,
        tileKey: "c9",
        propId: "10012",
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
        propId: String(20000 + i),
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

// ---------------------------------------------------------------------------
// P-259b: the no-account skip and the interim disclosure
// ---------------------------------------------------------------------------

describe("noAccountReason (the account gate's classifier)", () => {
  it("classifies the three no-account shapes the ruling names", () => {
    expect(noAccountReason("0")).toBe("zero");
    expect(noAccountReason(" 0 ")).toBe("zero"); // trimmed: still the sentinel
    expect(noAccountReason("")).toBe("empty");
    expect(noAccountReason("   ")).toBe("empty");
    expect(noAccountReason(null)).toBe("null");
    expect(noAccountReason(undefined)).toBe("null");
  });

  it("treats every other value as a real account (never over-excludes)", () => {
    expect(noAccountReason("1")).toBeNull();
    expect(noAccountReason("31001")).toBeNull();
    expect(noAccountReason("01101")).toBeNull(); // leading zeros are an id, not emptiness
    expect(noAccountReason("0.0")).toBeNull();
    expect(noAccountReason("R-580706")).toBeNull();
  });
});

describe("stampCountyZoning (no CAD account → no row, P-259b)", () => {
  const index = buildZoningIndex([
    squareFeature("RS", -97.72, 30.715, 0.01),
    squareFeature("MF-2", -97.70, 30.715, 0.01),
  ]);
  const COUNTY = "48453";

  /** One feature, one cell, with a chosen prop_id shape and PIP outcome. */
  function row(
    featureIndex: number,
    propId: string | null | undefined,
    geometry: GeoJsonGeometry,
  ): FakeParcelRow {
    return {
      countyFips: COUNTY,
      featureIndex,
      tileKey: "c1",
      propId,
      geometry,
      zoningDistrict: null,
      zoningJurisdiction: null,
      zoningDistrictInterim: null,
    };
  }

  const rsGeom = parcelSquare(-97.715, 30.72);
  const mfGeom = parcelSquare(-97.695, 30.72);
  const outGeom = parcelSquare(-97.5, 30.5);

  function seedMixed(): FakeParcelRow[] {
    return [
      row(20, "0", rsGeom), // sentinel -> skipped
      row(21, "31001", mfGeom), // real account -> written
      row(22, "   ", rsGeom), // blank -> skipped
      row(23, null, rsGeom), // missing -> skipped
      row(24, "31002", outGeom), // real account, no polygon -> null
    ];
  }

  it("a prop_id '0' / blank / null feature writes nothing and is counted by reason; a real account still writes", async () => {
    const fake = makeFakeDb(seedMixed());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
    });

    // The skip, by reason, every reason named.
    expect(summary.parcelsSkippedNoAccount).toBe(3);
    expect(summary.skippedNoAccountByReason).toEqual({
      zero: 1,
      empty: 1,
      null: 1,
    });

    // The real account still writes — the skip does not leak.
    const written = fake.rows.find((r) => r.featureIndex === 21)!;
    expect(written.zoningDistrict).toBe("MF-2");
    expect(written.zoningJurisdiction).toBe("austin-tx");
    expect(written.zoningDistrictInterim).toBe(false);

    // The no-account features are untouched on EVERY zoning column, including
    // the disclosure column — not stamped, not even with a false.
    for (const fi of [20, 22, 23]) {
      const r = fake.rows.find((x) => x.featureIndex === fi)!;
      expect(r.zoningDistrict).toBeNull();
      expect(r.zoningJurisdiction).toBeNull();
      expect(r.zoningDistrictInterim).toBeNull();
    }
  });

  it("keeps the five-way invariant account for account (nothing silently dropped)", async () => {
    const fake = makeFakeDb(seedMixed());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
    });

    expect(summary.parcelsRead).toBe(5);
    expect(summary.parcelsSkippedNoAccount).toBe(3);
    expect(summary.accountBearingFeatures).toBe(2);
    expect(summary.accountsRead).toBe(2); // 31001 + 31002
    expect(summary.parcelsMatched).toBe(1); // MF-2
    expect(summary.parcelsUnmatched).toBe(1); // the outside one
    expect(summary.parcelsUnrecognised).toBe(0);
    expect(summary.parcelsPlannedDevelopment).toBe(0);

    // The invariant, computed from the printed numbers.
    expect(
      summary.parcelsMatched +
        summary.parcelsPlannedDevelopment +
        summary.parcelsUnrecognised +
        summary.parcelsUnmatched +
        summary.parcelsSkippedNoAccount,
    ).toBe(summary.parcelsRead);
    expect(summary.accountBearingFeatures).toBe(
      summary.parcelsRead - summary.parcelsSkippedNoAccount,
    );
  });

  it("counts DISTINCT accounts, not features (per-cell dupes share one account)", async () => {
    // One feature across three grid cells: three ROWS, one feature, one account.
    const fake = makeFakeDb([
      row(30, "31003", mfGeom),
      { ...row(30, "31003", mfGeom), tileKey: "c2" },
      { ...row(30, "31003", mfGeom), tileKey: "c3" },
    ]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
    });
    expect(summary.parcelsRead).toBe(1);
    expect(summary.accountBearingFeatures).toBe(1);
    expect(summary.accountsRead).toBe(1);
    expect(summary.rowsUpdated).toBe(3); // per-cell dupes
  });

  it("scoped mode reports a no-account request by name, not as a resolved or missing id", async () => {
    const fake = makeFakeDb([
      row(40, "0", rsGeom),
      row(41, "31004", mfGeom),
    ]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
      propIds: new Set(["0", "31004", "99999"]),
      dryRun: true,
    });

    expect(summary.skippedNoAccountPropIds).toEqual(["0"]);
    // `matched` keeps its original meaning: both ids resolved to a row (the
    // no-account one included), so it still equals `parcelsRead`. The skip is
    // the separate fact that one of them produced no district.
    expect(summary.matched).toBe(2);
    expect(summary.parcelsRead).toBe(2);
    expect(summary.notFoundInParcelStore).toEqual(["99999"]);
    // The per-parcel table names the skip rather than dropping the row.
    const skipped = summary.perParcel!.find((r) => r.propId === "0")!;
    expect(skipped.kind).toBe("skipped-no-account");
    expect(skipped.district).toBeNull();
    expect(skipped.interim).toBeUndefined(); // nothing stamped -> no disclosure
  });
});

describe("stampCountyZoning (interim disclosure through the write, P-259b)", () => {
  // The REAL Austin layer config and the REAL reduce/parse path — the index
  // these tests stamp against is built exactly as the CLI builds it.
  const AUSTIN = resolveZoningLayer("austin-tx")!;
  const COUNTY = "48453";

  function austinFeature(ztype: string, west: number, south: number) {
    return reduceZoningFeature(
      {
        type: "Feature",
        properties: { ZONING_ZTYPE: ztype, ZONING_BASE: ztype },
        geometry: squareFeature(ztype, west, south, 0.01).geometry,
      },
      AUSTIN,
    );
  }

  const index = buildZoningIndex([
    austinFeature("I-SF-2-NP", -97.75, 30.25), // interim -> base SF-2 + NP
    austinFeature("SF-3-HD-NP", -97.73, 30.25), // not interim -> SF-3
    austinFeature("I-PUD", -97.71, 30.25), // interim planned development
    austinFeature("TOD", -97.69, 30.25), // unrecognised, not interim
  ]);

  function seed(): FakeParcelRow[] {
    const at = (west: number): FakeParcelRow => ({
      countyFips: COUNTY,
      featureIndex: 0,
      tileKey: "c1",
      propId: "0",
      geometry: parcelSquare(west, 30.255),
      zoningDistrict: null,
      zoningJurisdiction: null,
      zoningDistrictInterim: null,
    });
    return [
      { ...at(-97.745), featureIndex: 50, propId: "50050" },
      { ...at(-97.725), featureIndex: 51, propId: "50051" },
      { ...at(-97.705), featureIndex: 52, propId: "50052" },
      { ...at(-97.685), featureIndex: 53, propId: "50053" },
    ];
  }

  it("stamps I-SF-2-NP as SF-2 with interim true, and writes the disclosure on every stamped row", async () => {
    const fake = makeFakeDb(seed());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
    });

    // The row: base district + the interim fact.
    const interimRow = fake.rows.find((r) => r.featureIndex === 50)!;
    expect(interimRow.zoningDistrict).toBe("SF-2");
    expect(interimRow.zoningDistrictInterim).toBe(true);

    // A non-interim district is an EXPLICIT false, never NULL (NULL would mean
    // "nothing stamped here").
    const stableRow = fake.rows.find((r) => r.featureIndex === 51)!;
    expect(stableRow.zoningDistrict).toBe("SF-3");
    expect(stableRow.zoningDistrictInterim).toBe(false);

    // I-PUD takes the planned-development route and is still interim.
    const pudRow = fake.rows.find((r) => r.featureIndex === 52)!;
    expect(pudRow.zoningDistrict).toBe("I-PUD");
    expect(pudRow.zoningDistrictInterim).toBe(true);

    // An unrecognised non-interim value is stamped verbatim with false.
    const todRow = fake.rows.find((r) => r.featureIndex === 53)!;
    expect(todRow.zoningDistrict).toBe("TOD");
    expect(todRow.zoningDistrictInterim).toBe(false);

    // Counted as SUBSETS of the buckets they landed in, never added to them.
    expect(summary.parcelsMatched).toBe(2); // SF-2 + SF-3
    expect(summary.parcelsPlannedDevelopment).toBe(1); // I-PUD
    expect(summary.parcelsUnrecognised).toBe(1); // TOD
    expect(summary.parcelsInterim).toBe(1);
    expect(summary.parcelsInterimPlannedDevelopment).toBe(1);
    expect(summary.interimBaseHistogram).toEqual({ "SF-2": 1 });
    expect(summary.interimValueHistogram).toEqual({
      "I-SF-2-NP": 1,
      "I-PUD": 1,
    });
    // Overlays from an interim value DO count (the qualifier was classified).
    expect(summary.overlayHistogram).toEqual({ NP: 2, HD: 1 });
  });

  it("dry-run still discloses the interim fact in the per-parcel table, with zero writes", async () => {
    const fake = makeFakeDb(seed());
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: "austin-tx",
      index,
      propIds: new Set(["50050", "50051"]),
      dryRun: true,
    });
    expect(fake.executeCalls).toBe(0);
    const byProp = new Map(summary.perParcel!.map((r) => [r.propId, r]));
    expect(byProp.get("50050")).toMatchObject({
      district: "SF-2",
      kind: "base",
      publishedCode: "I-SF-2-NP",
      interim: true,
    });
    expect(byProp.get("50051")).toMatchObject({
      district: "SF-3",
      kind: "base",
      interim: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Bug 2 (2026-10-09, Burnet stage 3 §3): parcel-id-first join for a layer
// whose features ARE the parcel fabric (Horseshoe Bay). The parcel's OWN
// feature decides — a real code stamps, a blank code is a declared
// "no district on the city's own layer" outcome — and the point lookup is
// used ONLY when the id is absent from the layer's own index.
// ---------------------------------------------------------------------------
describe("buildParcelIdIndex", () => {
  it("indexes a feature's own code by its normalized parcel id", () => {
    const idx = buildParcelIdIndex([
      { parcelId: "0069366", code: null, description: null },
      { parcelId: "23169", code: "R-4", description: "R-4-MF" },
    ]);
    expect(idx.get("69366")).toEqual({ code: null, description: null, parse: undefined });
    expect(idx.get("23169")).toEqual({ code: "R-4", description: "R-4-MF", parse: undefined });
  });

  it("keeps a blank-coded feature instead of DROPPING it (unlike buildZoningIndex)", () => {
    const idx = buildParcelIdIndex([{ parcelId: "1", code: "   ", description: null }]);
    expect(idx.has("1")).toBe(true);
    expect(idx.get("1")?.code).toBeNull();
    // buildZoningIndex, by contrast, drops this feature entirely (Bug 2's
    // root cause for the PIP-only path) — the two indexes exist precisely
    // because they disagree about what to do with a blank code.
    expect(buildZoningIndex([{ code: "   ", description: null, geometry: null }])).toHaveLength(
      0,
    );
  });

  it("skips features with no parcel id, and keeps the FIRST on a repeated id", () => {
    const idx = buildParcelIdIndex([
      { parcelId: null, code: "R-1" },
      { parcelId: "5", code: "A-1" },
      { parcelId: "5", code: "C-2" }, // repeat id -- first wins, never overwritten
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get("5")?.code).toBe("A-1");
  });
});

describe("stampCountyZoning (parcelIdIndex — Bug 2)", () => {
  const CITY = "horseshoe-bay-tx";
  const COUNTY = "48053";
  // A point-lookup index carrying only a "neighbour" polygon. Every
  // synthetic parcel's geometry below sits INSIDE this square, so any test
  // that still reports this neighbour's code proves the point lookup ran;
  // any test that must NOT report it proves the id join pre-empted it.
  const neighbourIndex = buildZoningIndex([squareFeature("C-2", -97.72, 30.715, 0.01)]);

  function seedHsbRows(propId: string, featureIndex: number): FakeParcelRow[] {
    return [
      {
        countyFips: COUNTY,
        featureIndex,
        tileKey: "c1",
        propId,
        geometry: parcelSquare(-97.715, 30.72), // inside the neighbour's C-2 square
        zoningDistrict: null,
        zoningJurisdiction: null,
      },
    ];
  }

  // "100" -> real code; "200" -> own feature found, code BLANK; "300" ->
  // deliberately absent from the index (id not on the layer at all).
  const parcelIdIndex = buildParcelIdIndex([
    { parcelId: "100", code: "R-1", description: "R-1-SF" },
    { parcelId: "200", code: null, description: null },
  ]);

  it("own feature with a real code stamps directly (matchMethod parcel-id), bypassing the point lookup", async () => {
    const fake = makeFakeDb(seedHsbRows("100", 200));
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      parcelIdIndex,
      propIds: new Set(["100"]),
      dryRun: true,
    });
    expect(summary.parcelsMatched).toBe(1);
    expect(summary.perParcel).toHaveLength(1);
    expect(summary.perParcel![0]).toMatchObject({
      propId: "100",
      district: "R-1", // the OWN feature's code, not the neighbour's "C-2"
      kind: "base",
      matchMethod: "parcel-id",
    });
  });

  it("own feature blank: declared no-district, NEVER the neighbour's code, counted in parcelsNoDistrictOnLayer", async () => {
    const fake = makeFakeDb(seedHsbRows("200", 201));
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      parcelIdIndex,
      propIds: new Set(["200"]),
      dryRun: true,
    });
    expect(summary.parcelsNoDistrictOnLayer).toBe(1);
    expect(summary.parcelsMatched).toBe(0); // never the neighbour's C-2
    expect(summary.parcelsUnmatched).toBe(0); // not the generic "no polygon" bucket either
    expect(summary.noDistrictOnLayerPropIds).toEqual(["200"]);
    expect(summary.perParcel).toHaveLength(1);
    expect(summary.perParcel![0]).toEqual({
      propId: "200",
      featureIndex: 201,
      district: null,
      kind: "no-district-on-layer",
      matchMethod: "parcel-id-blank",
    });
  });

  it("no own feature for this id: falls back to the point lookup, counted as matchMethod point", async () => {
    const fake = makeFakeDb(seedHsbRows("300", 202));
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      parcelIdIndex,
      propIds: new Set(["300"]),
      dryRun: true,
    });
    expect(summary.parcelsMatched).toBe(1);
    expect(summary.perParcel).toHaveLength(1);
    expect(summary.perParcel![0]).toMatchObject({
      propId: "300",
      district: "C-2", // genuinely falls back to the point lookup
      kind: "base",
      matchMethod: "point",
    });
  });

  it("no parcelIdIndex supplied at all: byte-identical to pre-Bug-2 behaviour (every row point-matched, matchMethod undefined)", async () => {
    const fake = makeFakeDb([
      ...seedHsbRows("100", 200),
      ...seedHsbRows("200", 201),
      ...seedHsbRows("300", 202),
    ]);
    const summary = await stampCountyZoning({
      db: fake.db,
      countyFips: COUNTY,
      cityKey: CITY,
      index: neighbourIndex,
      // parcelIdIndex intentionally omitted.
      propIds: new Set(["100", "200", "300"]),
      dryRun: true,
    });
    expect(summary.parcelsNoDistrictOnLayer).toBe(0);
    expect(summary.parcelsMatched).toBe(3);
    for (const row of summary.perParcel!) {
      expect(row.matchMethod).toBeUndefined();
      expect(row.district).toBe("C-2"); // every one hits the point lookup -> neighbour
    }
  });
});
