/**
 * Unit tests for the federal-tier payload summary chips rendered in
 * the Site Context tab. Each adapter has its own describe block — the
 * fixtures from `__fixtures__/federalFixtures.ts` cover the happy
 * paths and we assert the graceful-degradation paths inline here.
 */

import { describe, expect, it } from "vitest";
import {
  summarizeFederalPayload,
  summarizeFemaNfhlPayload,
  summarizeUsgsNedPayload,
  summarizeEpaEjscreenPayload,
  summarizeFccBroadbandPayload,
} from "../federal/summaries";
import {
  ejscreenBlockGroup,
  epqsElevationFeet,
  epqsNoData,
  fccBroadbandFeatures,
  femaNfhlFeature,
} from "../__fixtures__/federalFixtures";

describe("summarizeFemaNfhlPayload", () => {
  it("includes the BFE for an in-floodplain parcel", () => {
    // Mirror the adapter's transform on the fixture: SFHA_TF "T" → true,
    // STATIC_BFE → baseFloodElevation, FLD_ZONE → floodZone.
    const attrs = femaNfhlFeature.features[0].attributes;
    const summary = summarizeFemaNfhlPayload({
      kind: "flood-zone",
      inSpecialFloodHazardArea: attrs.SFHA_TF === "T",
      floodZone: attrs.FLD_ZONE,
      baseFloodElevation: attrs.STATIC_BFE,
      features: femaNfhlFeature.features,
    });
    expect(summary).toBe("Flood Zone AE · BFE 425.5 ft");
  });

  it("falls back to a high-risk label when SFHA is true but BFE is missing", () => {
    expect(
      summarizeFemaNfhlPayload({
        kind: "flood-zone",
        inSpecialFloodHazardArea: true,
        floodZone: "VE",
        baseFloodElevation: null,
        features: [],
      }),
    ).toBe("Flood Zone VE (high-risk)");
  });

  it("renders the zone alone when the parcel is mapped but not in an SFHA", () => {
    expect(
      summarizeFemaNfhlPayload({
        kind: "flood-zone",
        inSpecialFloodHazardArea: false,
        floodZone: "X",
        baseFloodElevation: null,
        features: [],
      }),
    ).toBe("Flood Zone X");
  });

  it("emits the no-coverage chip when the adapter persisted a null floodZone (out-of-floodplain row)", () => {
    expect(
      summarizeFemaNfhlPayload({
        kind: "flood-zone",
        inSpecialFloodHazardArea: false,
        floodZone: null,
        features: [],
      }),
    ).toBe("No mapped flood risk (Zone X)");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeFemaNfhlPayload({ kind: "elevation-point" }),
    ).toBeNull();
    expect(summarizeFemaNfhlPayload(null)).toBeNull();
    expect(summarizeFemaNfhlPayload("not an object")).toBeNull();
  });
});

describe("summarizeUsgsNedPayload", () => {
  it("rounds the elevation to a whole foot and groups thousands", () => {
    const summary = summarizeUsgsNedPayload({
      kind: "elevation-point",
      elevationFeet: epqsElevationFeet.value,
      units: epqsElevationFeet.units,
    });
    expect(summary).toBe("Elevation: 4,033 ft");
  });

  it("normalizes the meters unit to the short form", () => {
    expect(
      summarizeUsgsNedPayload({
        kind: "elevation-point",
        elevationFeet: 142.4,
        units: "Meters",
      }),
    ).toBe("Elevation: 142 m");
  });

  it("degrades gracefully when the elevation is null (off-raster)", () => {
    // Mirror what the adapter persists for the EPQS no-data sentinel.
    const summary = summarizeUsgsNedPayload({
      kind: "elevation-point",
      elevationFeet: null,
      units: epqsNoData.units,
    });
    expect(summary).toBe("Elevation: not available (off-raster)");
  });

  it("returns null for non-elevation payloads", () => {
    expect(summarizeUsgsNedPayload({ kind: "flood-zone" })).toBeNull();
    expect(summarizeUsgsNedPayload(undefined)).toBeNull();
  });
});

describe("summarizeEpaEjscreenPayload", () => {
  it("leads with the demographic index and adds the PM2.5 percentile", () => {
    // Mirror the adapter's normalized subset of the broker `data.main`
    // envelope — only the percentiles the chip surfaces are needed.
    const main = ejscreenBlockGroup.data.main;
    const summary = summarizeEpaEjscreenPayload({
      kind: "ejscreen-blockgroup",
      demographicIndexPercentile: main.P_D2_VULEOPCT,
      pm25Percentile: main.P_PM25,
    });
    expect(summary).toBe("EJ Index 65th pctile · PM2.5 72nd pctile");
  });

  it("emits the demographic index alone when PM2.5 is missing", () => {
    expect(
      summarizeEpaEjscreenPayload({
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 87,
        pm25Percentile: null,
      }),
    ).toBe("EJ Index 87th pctile");
  });

  it("falls back to PM2.5 alone when the demographic index is missing", () => {
    expect(
      summarizeEpaEjscreenPayload({
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: null,
        pm25Percentile: 22,
      }),
    ).toBe("PM2.5 22nd pctile");
  });

  it("uses an 'unavailable' chip when neither percentile is present", () => {
    expect(
      summarizeEpaEjscreenPayload({
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: null,
        pm25Percentile: null,
      }),
    ).toBe("EJScreen indicators unavailable");
  });

  it("returns null when the payload kind doesn't match", () => {
    expect(
      summarizeEpaEjscreenPayload({ kind: "broadband-availability" }),
    ).toBeNull();
  });
});

describe("summarizeFccBroadbandPayload", () => {
  it("formats fastest tier in Gbps and pluralizes provider count", () => {
    // Mirror the adapter's roll-up of the per-provider fixture rows.
    const downs = fccBroadbandFeatures.features.map(
      (f) => f.attributes.MaxAdDown,
    );
    const summary = summarizeFccBroadbandPayload({
      kind: "broadband-availability",
      providerCount: fccBroadbandFeatures.features.length,
      fastestDownstreamMbps: Math.max(...downs),
      providers: [],
    });
    expect(summary).toBe("Up to 1 Gbps · 2 providers");
  });

  it("uses Mbps for sub-gigabit tiers and singular 'provider' for one-provider rows", () => {
    expect(
      summarizeFccBroadbandPayload({
        kind: "broadband-availability",
        providerCount: 1,
        fastestDownstreamMbps: 100,
        providers: [],
      }),
    ).toBe("Up to 100 Mbps · 1 provider");
  });

  it("emits a 'no broadband' chip when the adapter reported zero providers", () => {
    expect(
      summarizeFccBroadbandPayload({
        kind: "broadband-availability",
        providerCount: 0,
        fastestDownstreamMbps: null,
        providers: [],
      }),
    ).toBe("No fixed broadband reported");
  });

  it("falls back to the provider count when Mbps is unknown but providers exist", () => {
    expect(
      summarizeFccBroadbandPayload({
        kind: "broadband-availability",
        providerCount: 3,
        fastestDownstreamMbps: null,
        providers: [],
      }),
    ).toBe("3 providers reported");
  });

  it("returns null for an unrelated payload kind", () => {
    expect(
      summarizeFccBroadbandPayload({ kind: "ejscreen-blockgroup" }),
    ).toBeNull();
  });
});

describe("summarizeFederalPayload (registry)", () => {
  it("routes by layerKind to the correct formatter", () => {
    expect(
      summarizeFederalPayload("fema-nfhl-flood-zone", {
        kind: "flood-zone",
        inSpecialFloodHazardArea: true,
        floodZone: "AE",
        baseFloodElevation: 12,
        features: [],
      }),
    ).toBe("Flood Zone AE · BFE 12 ft");
    expect(
      summarizeFederalPayload("usgs-ned-elevation", {
        kind: "elevation-point",
        elevationFeet: 100,
        units: "Feet",
      }),
    ).toBe("Elevation: 100 ft");
    expect(
      summarizeFederalPayload("epa-ejscreen-blockgroup", {
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 50,
      }),
    ).toBe("EJ Index 50th pctile");
    expect(
      summarizeFederalPayload("fcc-broadband-availability", {
        kind: "broadband-availability",
        providerCount: 0,
      }),
    ).toBe("No fixed broadband reported");
  });

  it("returns null for unknown layer kinds (state/local rows fall through)", () => {
    expect(
      summarizeFederalPayload("grand-county-ut:zoning", {
        kind: "zoning",
      }),
    ).toBeNull();
  });
});
