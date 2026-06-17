import { describe, expect, it, vi } from "vitest";

import { ingestOpportunityZonesFromHud } from "../ozTractIngest";

describe("ingestOpportunityZonesFromHud", () => {
  it("paginates HUD ArcGIS GeoJSON into versioned fixture", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { GEOID10: "48453002400" },
            geometry: { type: "Polygon", coordinates: [] },
          },
        ],
      }),
    });

    const result = await ingestOpportunityZonesFromHud({
      version: "oz-test",
      outputPath: "P:/legacy-design-tools/artifacts/api-server/data/opportunity-zones/oz-test.geojson",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.featureCount).toBe(1);
    expect(result.version).toBe("oz-test");
    expect(fetchImpl).toHaveBeenCalled();
  });
});
