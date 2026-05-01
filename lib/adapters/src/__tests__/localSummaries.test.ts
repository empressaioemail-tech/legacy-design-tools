/**
 * Unit tests for the local-tier payload summary chips rendered in
 * the Site Context tab. Mirrors the structure of
 * `federalSummaries.test.ts` and `stateSummaries.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  summarizeFloodplainPayload,
  summarizeLocalPayload,
  summarizeRoadsPayload,
  summarizeZoningPayload,
} from "../local/summaries";

describe("summarizeZoningPayload", () => {
  it("includes the zoning code and human-readable description when both are present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "R-1", ZONE_DESC: "Single-Family Residential" },
        },
      }),
    ).toBe("Zoning R-1 · Single-Family Residential");
  });

  it("emits the code alone when no description column is present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { ZONE_CODE: "C-2" } },
      }),
    ).toBe("Zoning C-2");
  });

  it("falls back to the description alone when no code column is present", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { DESCRIPTION: "Mixed Use Overlay" } },
      }),
    ).toBe("Zoning: Mixed Use Overlay");
  });

  it("falls back to a generic chip when attributes are empty", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: {} },
      }),
    ).toBe("Zoning polygon present");
  });

  it("accepts the alternate ZONING column name", () => {
    expect(
      summarizeZoningPayload({
        kind: "zoning",
        zoning: { attributes: { ZONING: "A-1" } },
      }),
    ).toBe("Zoning A-1");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(summarizeZoningPayload({ kind: "parcel" })).toBeNull();
    expect(summarizeZoningPayload(null)).toBeNull();
  });
});

describe("summarizeRoadsPayload", () => {
  it("attributes a county-GIS reading explicitly", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [{}, {}, {}],
      }),
    ).toBe("3 road segments (county GIS)");
  });

  it("singularizes for one feature", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [{}],
      }),
    ).toBe("1 road segment (county GIS)");
  });

  it("attributes the OSM fallback path and surfaces the search radius", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "osm",
        radiusMeters: 100,
        elements: [{}, {}],
      }),
    ).toBe("2 road segments within 100m (OSM)");
  });

  it("emits the empty-state chip when no roads were found", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        source: "county-gis",
        features: [],
      }),
    ).toBe("No roads recorded near this point");
  });

  it("degrades gracefully when source attribution is missing", () => {
    expect(
      summarizeRoadsPayload({
        kind: "roads",
        features: [{}],
      }),
    ).toBe("1 road segment");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeRoadsPayload({ kind: "floodplain" }),
    ).toBeNull();
  });
});

describe("summarizeFloodplainPayload", () => {
  it("surfaces the FEMA-derived FLD_ZONE when the parcel is in the floodplain", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "AE" } }],
      }),
    ).toBe("In mapped floodplain (Zone AE)");
  });

  it("falls back to the no-zone chip when in floodplain but no FLD_ZONE attribute is present", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: {} }],
      }),
    ).toBe("In mapped floodplain");
  });

  it("emits the outside chip when the parcel is not in a mapped floodplain", () => {
    expect(
      summarizeFloodplainPayload({
        kind: "floodplain",
        inMappedFloodplain: false,
        features: [],
      }),
    ).toBe("Outside mapped floodplain");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeFloodplainPayload({ kind: "zoning" }),
    ).toBeNull();
  });
});

describe("summarizeLocalPayload (registry)", () => {
  it("routes by layerKind to the correct formatter", () => {
    expect(
      summarizeLocalPayload("grand-county-ut-parcels", {
        kind: "parcel",
        parcel: { attributes: { PARCEL_ID: "G-1", ACRES: 0.5 } },
      }),
    ).toBe("Parcel G-1 · 0.5 ac");
    expect(
      summarizeLocalPayload("lemhi-county-id-zoning", {
        kind: "zoning",
        zoning: { attributes: { ZONE_CODE: "AG-1" } },
      }),
    ).toBe("Zoning AG-1");
    expect(
      summarizeLocalPayload("bastrop-tx-zoning", {
        kind: "zoning",
        zoning: {
          attributes: { ZONE_CODE: "MF-2", ZONE_DESC: "Multi-Family" },
        },
      }),
    ).toBe("Zoning MF-2 · Multi-Family");
    expect(
      summarizeLocalPayload("grand-county-ut-roads", {
        kind: "roads",
        source: "osm",
        radiusMeters: 100,
        elements: [{}],
      }),
    ).toBe("1 road segment within 100m (OSM)");
    expect(
      summarizeLocalPayload("lemhi-county-id-roads", {
        kind: "roads",
        source: "county-gis",
        features: [{}, {}],
      }),
    ).toBe("2 road segments (county GIS)");
    expect(
      summarizeLocalPayload("bastrop-tx-floodplain", {
        kind: "floodplain",
        inMappedFloodplain: true,
        features: [{ attributes: { FLD_ZONE: "X" } }],
      }),
    ).toBe("In mapped floodplain (Zone X)");
  });

  it("returns null for unknown layer kinds (federal/state rows fall through)", () => {
    expect(
      summarizeLocalPayload("fema-nfhl-flood-zone", {
        kind: "flood-zone",
      }),
    ).toBeNull();
    expect(
      summarizeLocalPayload("ugrc-parcels", {
        kind: "parcel",
        parcel: null,
      }),
    ).toBeNull();
  });
});
