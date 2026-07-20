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

import { describe, expect, it } from "vitest";
import type { GeoJsonGeometry } from "../txgio/geo";
import {
  buildZoningIndex,
  representativePoint,
  stampParcelZoning,
  zoningCodeAtPoint,
} from "../txgio/zoning-stamp";
import { reduceZoningFeature } from "../txgio/zoning-service";

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
