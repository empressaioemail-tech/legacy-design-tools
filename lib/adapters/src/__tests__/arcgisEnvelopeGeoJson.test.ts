import { describe, expect, it, vi } from "vitest";
import { arcgisEnvelopeQueryGeoJson } from "../arcgis";

function geoJsonPage(features: unknown[], exceeded = false) {
  return {
    type: "FeatureCollection",
    features,
    ...(exceeded ? { exceededTransferLimit: true } : {}),
  };
}

describe("arcgisEnvelopeQueryGeoJson", () => {
  it("merges paginated envelope features into one FeatureCollection", async () => {
    const page1 = Array.from({ length: 500 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { id: i },
    }));
    const page2 = Array.from({ length: 42 }, (_, i) => ({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [] },
      properties: { id: 500 + i },
    }));

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const offset = Number(new URL(url).searchParams.get("resultOffset"));
      const body =
        offset === 0
          ? geoJsonPage(page1, true)
          : geoJsonPage(page2, false);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const fc = await arcgisEnvelopeQueryGeoJson({
      serviceUrl: "https://example.test/MapServer/0",
      bbox: {
        westLng: -97.32,
        southLat: 30.1,
        eastLng: -97.3,
        northLat: 30.12,
      },
      fetchImpl,
    });

    expect(fc.features).toHaveLength(542);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(firstUrl.searchParams.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(firstUrl.searchParams.get("resultRecordCount")).toBe("500");
    const geometry = JSON.parse(firstUrl.searchParams.get("geometry")!);
    expect(geometry).toMatchObject({
      xmin: -97.32,
      ymin: 30.1,
      xmax: -97.3,
      ymax: 30.12,
    });
  });
});
