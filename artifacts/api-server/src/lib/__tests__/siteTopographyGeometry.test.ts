import { describe, it, expect } from "vitest";
import {
  extractParcelGeometryFromPayload,
  geometryToBboxWgs84,
  webMercatorToWgs84,
} from "../siteTopographyGeometry";

/** Moab UGRC parcel corner in Web Mercator meters (from canary failure). */
const MOAB_WM_X = -12193513.438655587;
const MOAB_WM_Y = 4671068.84;

describe("site-topography parcel geometry reprojection", () => {
  it("webMercatorToWgs84 — Moab Web Mercator meters land in WGS84 range", () => {
    const [lng, lat] = webMercatorToWgs84(MOAB_WM_X, MOAB_WM_Y);
    expect(lng).toBeGreaterThan(-110);
    expect(lng).toBeLessThan(-109);
    expect(lat).toBeGreaterThan(38);
    expect(lat).toBeLessThan(39);
  });

  it("extractParcelGeometryFromPayload — Web Mercator rings reproject to WGS84 GeoJSON", () => {
    const geometry = extractParcelGeometryFromPayload({
      kind: "parcel",
      parcel: {
        attributes: { PARCEL_ID: "UT-TEST" },
        geometry: {
          rings: [
            [
              [MOAB_WM_X, MOAB_WM_Y],
              [MOAB_WM_X + 40, MOAB_WM_Y],
              [MOAB_WM_X + 40, MOAB_WM_Y + 30],
              [MOAB_WM_X, MOAB_WM_Y + 30],
              [MOAB_WM_X, MOAB_WM_Y],
            ],
          ],
          spatialReference: { wkid: 3857 },
        },
      },
    });
    expect(geometry).not.toBeNull();
    expect(geometry!.type).toBe("Polygon");
    const bbox = geometryToBboxWgs84(geometry!);
    expect(bbox).not.toBeNull();
    expect(Math.abs(bbox!.westLng)).toBeLessThanOrEqual(180);
    expect(Math.abs(bbox!.eastLng)).toBeLessThanOrEqual(180);
    expect(Math.abs(bbox!.southLat)).toBeLessThanOrEqual(90);
    expect(Math.abs(bbox!.northLat)).toBeLessThanOrEqual(90);
  });

  it("extractParcelGeometryFromPayload — WGS84 rings pass through unchanged", () => {
    const rings = [
      [
        [-109.5499, 38.5732],
        [-109.5497, 38.5732],
        [-109.5497, 38.5734],
        [-109.5499, 38.5734],
        [-109.5499, 38.5732],
      ],
    ];
    const geometry = extractParcelGeometryFromPayload({
      kind: "parcel",
      parcel: {
        geometry: {
          rings,
          spatialReference: { wkid: 4326 },
        },
      },
    });
    expect(geometry).toEqual({
      type: "Polygon",
      coordinates: rings,
    });
    const bbox = geometryToBboxWgs84(geometry!);
    expect(bbox).toMatchObject({
      westLng: -109.5499,
      eastLng: -109.5497,
      southLat: 38.5732,
      northLat: 38.5734,
    });
  });

  it("extractParcelGeometryFromPayload — Regrid GeoJSON Feature path unchanged", () => {
    const regridGeometry = {
      type: "Polygon" as const,
      coordinates: [
        [
          [-109.5499, 38.5732],
          [-109.5497, 38.5732],
          [-109.5497, 38.5734],
          [-109.5499, 38.5734],
          [-109.5499, 38.5732],
        ],
      ],
    };
    const geometry = extractParcelGeometryFromPayload({
      kind: "parcel",
      parcel: {
        type: "Feature",
        geometry: regridGeometry,
      },
    });
    expect(geometry).toEqual(regridGeometry);
  });

  it("geometryToBboxWgs84 — returns null for un-reprojected Web Mercator coordinates", () => {
    const bbox = geometryToBboxWgs84({
      type: "Polygon",
      coordinates: [
        [
          [MOAB_WM_X, MOAB_WM_Y],
          [MOAB_WM_X + 40, MOAB_WM_Y],
          [MOAB_WM_X + 40, MOAB_WM_Y + 30],
          [MOAB_WM_X, MOAB_WM_Y + 30],
          [MOAB_WM_X, MOAB_WM_Y],
        ],
      ],
    });
    expect(bbox).toBeNull();
  });
});
