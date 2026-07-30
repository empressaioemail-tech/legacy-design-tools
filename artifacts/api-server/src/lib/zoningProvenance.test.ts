/**
 * Unit tests for zoning GIS provenance helpers (COMPLETE-BASTROP A1).
 * Bastrop layer repointed 2026-07-29 (WDLL item 6 / BDC STEP 2):
 * Zoning_Place_Type/0 PlaceTypeClass → Zoned_Parcels/83 ZoneTypeClass.
 */

import { describe, expect, it } from "vitest";

import {
  layerNameFromZoningUrl,
  resolveZoningLayerForDistrict,
  zoningProvenanceFromLayer,
} from "./zoningProvenance";

const BASTROP_AGOL =
  "https://services7.arcgis.com/qOeXJdBtGknaCJC4/arcgis/rest/services/Zoned_Parcels/FeatureServer/83";

describe("zoningProvenance (A1)", () => {
  it("extracts Zoned_Parcels from AGOL FeatureServer URL", () => {
    expect(layerNameFromZoningUrl(BASTROP_AGOL)).toBe("Zoned_Parcels");
  });

  it("resolves bastrop-city-tx from stamped cityKey", () => {
    const layer = resolveZoningLayerForDistrict({
      resolvedCityKey: "bastrop-city-tx",
      countyFips: "48021",
    });
    expect(layer?.cityKey).toBe("bastrop-city-tx");
    expect(layer?.codeField).toBe("ZoneTypeClass");
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
      codeField: "ZoneTypeClass",
      cityKey: "bastrop-city-tx",
      layerName: "Zoned_Parcels",
      stampedAt,
    });
  });
});
