import { describe, expect, it } from "vitest";
import {
  BASTROP_PARCELS_BBOX,
  loadGisLayerFixture,
  resolveGisFixturePath,
} from "../brokerageGisLayerFixtures";

describe("brokerageGisLayerFixtures", () => {
  it("resolves bundled fixture paths under data/gis-fixtures", () => {
    expect(resolveGisFixturePath("parcels")).toMatch(
      /gis-fixtures[\\/]bastrop-tx-parcels-bbox\.gis-layer\.json$/,
    );
  });

  it("loads committed Bastrop parcels fixture when present", () => {
    const fixture = loadGisLayerFixture("parcels");
    if (!fixture) {
      expect(resolveGisFixturePath("parcels")).toContain("bastrop-tx-parcels-bbox");
      return;
    }
    expect(fixture.manifest.fixtureKey).toBe("bastrop-tx-parcels-bbox");
    expect(fixture.manifest.bbox).toEqual(BASTROP_PARCELS_BBOX);
    expect(fixture.result.layer).toBe("parcels");
    expect(fixture.result.featureCount).toBeGreaterThan(1);
    expect(fixture.result.geojson.features.length).toBeGreaterThan(1);
    const props = (fixture.result.geojson.features[0] as {
      properties?: Record<string, unknown>;
    }).properties;
    expect(props).toBeTruthy();
  });
});
