import { describe, it, expect } from "vitest";
import { runHydrologyNative } from "@workspace/site-context/server";
import {
  resolveAccumulationThreshold,
  DEFAULT_ACCUMULATION_THRESHOLD,
  MIN_ACCUMULATION_THRESHOLD,
} from "../lib/siteDrainageThreshold";

describe("resolveAccumulationThreshold", () => {
  it("caps at DEFAULT on large catchment grids", () => {
    expect(resolveAccumulationThreshold(200, 200)).toBe(
      DEFAULT_ACCUMULATION_THRESHOLD,
    );
    expect(resolveAccumulationThreshold(100, 100)).toBe(
      DEFAULT_ACCUMULATION_THRESHOLD,
    );
  });

  it("scales down for parcel-scale clips (10×10 → 5)", () => {
    expect(resolveAccumulationThreshold(10, 10)).toBe(5);
  });

  it("respects explicit operator override", () => {
    expect(resolveAccumulationThreshold(10, 10, 25)).toBe(25);
  });

  it("never drops below MIN on degenerate dimensions", () => {
    expect(resolveAccumulationThreshold(1, 1)).toBe(MIN_ACCUMULATION_THRESHOLD);
  });
});

describe("resolveAccumulationThreshold + hydrologyNative parity", () => {
  it("10×10 ingest fixture DEM yields flow lines at derived threshold", () => {
    const width = 10;
    const height = 10;
    const elevation = new Float32Array(
      Array.from({ length: 100 }, (_, i) => 100 + (i % 10) * 0.3),
    );
    const threshold = resolveAccumulationThreshold(width, height);
    expect(threshold).toBeLessThan(10);

    const result = runHydrologyNative({
      width,
      height,
      elevation,
      catchmentBbox: {
        westLng: -97.6795,
        southLat: 30.5088,
        eastLng: -97.6783,
        northLat: 30.5096,
      },
      pourLng: -97.679,
      pourLat: 30.509,
      rainfallDepthMm: 101.6,
      accumulationThreshold: threshold,
    });
    expect(result.flowLinesGeoJson.features.length).toBeGreaterThan(0);
  });
});
