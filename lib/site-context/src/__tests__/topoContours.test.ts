import { describe, expect, it } from "vitest";
import {
  extractContoursGeoJsonOverlays,
  hasContoursGeoJson,
} from "../client/topoContours";

const FIXTURE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { elevation: 5200 },
      geometry: {
        type: "LineString",
        coordinates: [
          [-105.27, 40.015],
          [-105.269, 40.016],
          [-105.268, 40.017],
        ],
      },
    },
    {
      type: "Feature",
      properties: { elevation: 5210 },
      geometry: {
        type: "MultiLineString",
        coordinates: [
          [
            [-105.271, 40.014],
            [-105.27, 40.0145],
          ],
          [
            [-105.272, 40.013],
            [-105.2715, 40.0135],
          ],
        ],
      },
    },
  ],
} as const;

describe("extractContoursGeoJsonOverlays", () => {
  it("maps LineString and MultiLineString features to lat/lng polylines", () => {
    const overlays = extractContoursGeoJsonOverlays(FIXTURE);
    expect(overlays).toHaveLength(3);
    expect(overlays.every((o) => o.kind === "polyline")).toBe(true);
    expect(overlays[0]!.tier).toBe("topography");
    expect(overlays[0]!.layerKind).toBe("elevation-contour");
    const first = overlays[0];
    expect(first?.kind).toBe("polyline");
    if (first?.kind !== "polyline") throw new Error("expected polyline");
    expect(first.positions[0]![0]).toEqual([40.015, -105.27]);
    expect(first.positions[0]!.at(-1)).toEqual([40.017, -105.268]);
  });

  it("returns empty for invalid input", () => {
    expect(extractContoursGeoJsonOverlays(null)).toEqual([]);
    expect(extractContoursGeoJsonOverlays({ type: "Point" })).toEqual([]);
    expect(extractContoursGeoJsonOverlays({ type: "FeatureCollection" })).toEqual(
      [],
    );
  });
});

describe("hasContoursGeoJson", () => {
  it("detects non-empty contours on propertySet", () => {
    expect(
      hasContoursGeoJson({ contoursGeoJson: FIXTURE }),
    ).toBe(true);
  });

  it("returns false when contours missing or empty", () => {
    expect(hasContoursGeoJson({})).toBe(false);
    expect(
      hasContoursGeoJson({ contoursGeoJson: { type: "FeatureCollection", features: [] } }),
    ).toBe(false);
  });
});
