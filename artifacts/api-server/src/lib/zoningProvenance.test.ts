/**
 * Unit tests for zoning GIS provenance helpers (COMPLETE-BASTROP A1).
 */

import { describe, expect, it } from "vitest";

import {
  layerNameFromZoningUrl,
  resolveZoningLayerForDistrict,
  zoningProvenanceFromLayer,
} from "./zoningProvenance";

const BASTROP_AGOL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoning_Place_Type/FeatureServer/0";

describe("zoningProvenance (A1)", () => {
  it("extracts Zoning_Place_Type from AGOL FeatureServer URL", () => {
    expect(layerNameFromZoningUrl(BASTROP_AGOL)).toBe("Zoning_Place_Type");
  });

  it("resolves bastrop-city-tx from stamped cityKey", () => {
    const layer = resolveZoningLayerForDistrict({
      resolvedCityKey: "bastrop-city-tx",
      countyFips: "48021",
    });
    expect(layer?.cityKey).toBe("bastrop-city-tx");
    expect(layer?.codeField).toBe("PlaceTypeClass");
    expect(layer?.layerUrl).toBe(BASTROP_AGOL);
  });

  it("sole wired layer fills Bastrop when cityKey missing", () => {
    const layer = resolveZoningLayerForDistrict({
      resolvedCityKey: null,
      countyFips: "48021",
    });
    expect(layer?.cityKey).toBe("bastrop-city-tx");
  });

  it("does not invent a layer for multi-city county without cityKey", () => {
    const layer = resolveZoningLayerForDistrict({
      resolvedCityKey: null,
      countyFips: "48453", // Travis — austin + others
    });
    expect(layer).toBeNull();
  });

  it("builds provenance payload from layer", () => {
    const layer = resolveZoningLayerForDistrict({
      resolvedCityKey: "bastrop-city-tx",
      countyFips: "48021",
    })!;
    const stampedAt = "2026-07-27T12:00:00.000Z";
    expect(zoningProvenanceFromLayer(layer, stampedAt)).toEqual({
      sourceUrl: BASTROP_AGOL,
      codeField: "PlaceTypeClass",
      cityKey: "bastrop-city-tx",
      layerName: "Zoning_Place_Type",
      stampedAt,
    });
  });
});
