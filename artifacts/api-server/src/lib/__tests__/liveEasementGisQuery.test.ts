import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  P85_LIVE_EASEMENT_GIS_LAYERS,
  queryLiveEasementGisForParcel,
} from "../liveEasementGisQuery";

const parcelPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-97.74, 30.26],
      [-97.739, 30.26],
      [-97.739, 30.261],
      [-97.74, 30.261],
      [-97.74, 30.26],
    ],
  ],
};

describe("queryLiveEasementGisForParcel (P-85 item 2)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips city-scoped layers when county FIPS does not match", async () => {
    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48453:TEST",
      countyFips: "48453",
      parcelGeometryGeojson: parcelPolygon,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const skipped = audit.layers.filter((l) => l.skippedReason === "county_fips_mismatch");
    expect(skipped.length).toBe(P85_LIVE_EASEMENT_GIS_LAYERS.length);
    expect(audit.hits).toEqual([]);
  });

  it("skips layers outside city limits when isInsideCityScope returns false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ features: [] }),
    });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:TEST",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const williamsonLayers = audit.layers.filter((l) =>
      ["round-rock-easements", "cedar-park-easements"].includes(l.sourceLayerId),
    );
    expect(williamsonLayers).toHaveLength(2);
    expect(
      williamsonLayers.every((l) => l.skippedReason === "outside_city_limits"),
    ).toBe(true);
  });

  it("records ArcGIS hits with recording ref and type from the first intersecting feature", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        features: [
          {
            id: 42,
            properties: {
              Recordation_Num: "2020-12345",
              Type: "Utility",
            },
            geometry: { type: "LineString", coordinates: [[-97.74, 30.26]] },
          },
        ],
      }),
    });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:ROUND-ROCK",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => true,
    });

    expect(fetchMock).toHaveBeenCalled();
    expect(audit.hits.length).toBeGreaterThan(0);
    const roundRockHit = audit.hits.find(
      (h) => h.sourceLayerId === "round-rock-easements",
    );
    expect(roundRockHit).toMatchObject({
      recordingRef: "2020-12345",
      easementType: "Utility",
      featureIds: [42],
    });
    expect(audit.layers.some((l) => l.featureCount === 1)).toBe(true);
  });

  it("records http failures without fabricating hits", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const audit = await queryLiveEasementGisForParcel({
      parcelKey: "48491:TEST",
      countyFips: "48491",
      parcelGeometryGeojson: parcelPolygon,
      isInsideCityScope: () => true,
    });

    expect(audit.hits).toEqual([]);
    expect(audit.layers.some((l) => l.skippedReason === "http_503")).toBe(true);
  });
});
