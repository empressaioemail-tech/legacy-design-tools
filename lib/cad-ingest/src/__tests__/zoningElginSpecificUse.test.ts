/**
 * Elgin "S-P" (Specific Use) is a published value on Elgin_Zoning layer 0.
 *
 * Measured 2026-11-05: 48021 props 12830, 14457 and 60891 sit inside an S-P
 * polygon (live centroid query), and the factory ledger serves zoningDistrict
 * "S-P" for all three, but their txgio_parcel stamp was NULL. The cause: the
 * elgin-tx codeDomainMap did not list "S-P", and an unmapped value decodes to
 * NULL, so every S-P polygon was dropped from the stamp's index and its
 * parcels read as having no zoning on record.
 *
 * FALSIFIER: on main the S-P feature reduces to a null code and the parcel
 * inside it stamps null. Controls: "A" still decodes to "R-4", and a value
 * the layer does not publish still decodes to null.
 */
import { describe, expect, it } from "vitest";
import type { GeoJsonGeometry } from "../txgio/geo";
import { buildZoningIndex, stampParcelZoning } from "../txgio/zoning-stamp";
import { reduceZoningFeature } from "../txgio/zoning-service";
import { resolveZoningLayer } from "../txgio/zoning-layers";

const elgin = resolveZoningLayer("elgin-tx");

function square(x: number, y: number, d: number): GeoJsonGeometry {
  return {
    type: "Polygon",
    coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]]],
  } as GeoJsonGeometry;
}

function feature(zoneCode: string) {
  return {
    type: "Feature" as const,
    properties: { Zone_Code: zoneCode, Zoning: "label", CITY_LIMIT: "ELGIN" },
    geometry: square(-97.37, 30.34, 0.01),
  };
}

describe("elgin-tx stamp: a published S-P value is stamped, never NULL", () => {
  it("the elgin-tx layer config resolves", () => {
    expect(elgin).toBeDefined();
    expect(elgin!.countyFips).toBe("48021");
  });

  it("FALSIFIER: an S-P feature reduces to the code S-P", () => {
    expect(reduceZoningFeature(feature("S-P"), elgin!).code).toBe("S-P");
  });

  it("FALSIFIER: a parcel inside an S-P polygon stamps S-P", () => {
    const index = buildZoningIndex([reduceZoningFeature(feature("S-P"), elgin!)]);
    const parcel = square(-97.366, 30.344, 0.001);
    expect(stampParcelZoning(index, parcel)?.code).toBe("S-P");
  });

  it("control: the legacy A code still decodes to R-4", () => {
    expect(reduceZoningFeature(feature("A"), elgin!).code).toBe("R-4");
  });

  it("control: a value the layer does not publish still decodes to null", () => {
    expect(reduceZoningFeature(feature("XYZ"), elgin!).code).toBeNull();
  });
});
