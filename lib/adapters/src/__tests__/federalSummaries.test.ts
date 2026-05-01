/**
 * Unit tests for the federal-tier payload summary chips rendered in
 * the Site Context tab. Each adapter has its own describe block — the
 * fixtures from `__fixtures__/federalFixtures.ts` cover the happy
 * paths and we assert the graceful-degradation paths inline here.
 */

import { describe, expect, it } from "vitest";
import {
  diffFederalPayload,
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

describe("diffFederalPayload", () => {
  it("returns one entry per moved key for a FEMA flood-zone rerun", () => {
    const prior = {
      kind: "flood-zone",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      baseFloodElevation: 425.5,
    };
    const current = {
      kind: "flood-zone",
      inSpecialFloodHazardArea: false,
      floodZone: "X",
      baseFloodElevation: null,
    };
    const changes = diffFederalPayload(
      "fema-nfhl-flood-zone",
      prior,
      current,
    );
    expect(changes).toEqual([
      { key: "floodZone", label: "Flood Zone", before: "AE", after: "X" },
      {
        key: "inSpecialFloodHazardArea",
        label: "In SFHA",
        before: "Yes",
        after: "No",
      },
      {
        key: "baseFloodElevation",
        label: "BFE",
        before: "425.5 ft",
        after: "(none)",
      },
    ]);
  });

  it("returns an empty array when every key formats identically (true no-op)", () => {
    const payload = {
      kind: "flood-zone",
      inSpecialFloodHazardArea: true,
      floodZone: "AE",
      baseFloodElevation: 425.5,
    };
    expect(
      diffFederalPayload("fema-nfhl-flood-zone", payload, { ...payload }),
    ).toEqual([]);
  });

  it("emits BFE deltas with the same 'ft' unit suffix as the inline summary chip", () => {
    const changes = diffFederalPayload(
      "fema-nfhl-flood-zone",
      {
        kind: "flood-zone",
        inSpecialFloodHazardArea: true,
        floodZone: "AE",
        baseFloodElevation: 425.5,
      },
      {
        kind: "flood-zone",
        inSpecialFloodHazardArea: true,
        floodZone: "AE",
        baseFloodElevation: 426.1,
      },
    );
    expect(changes).toEqual([
      {
        key: "baseFloodElevation",
        label: "BFE",
        before: "425.5 ft",
        after: "426.1 ft",
      },
    ]);
  });

  it("formats USGS elevation deltas with the chip's unit normalization (Feet → ft, thousands grouping)", () => {
    const changes = diffFederalPayload(
      "usgs-ned-elevation",
      {
        kind: "elevation-point",
        elevationFeet: 4033,
        units: "Feet",
      },
      {
        kind: "elevation-point",
        elevationFeet: 4034,
        units: "Feet",
      },
    );
    expect(changes).toEqual([
      {
        key: "elevationFeet",
        label: "Elevation",
        before: "4,033 ft",
        after: "4,034 ft",
      },
    ]);
  });

  it("emits ordinal-suffix percentile deltas for EJScreen reruns", () => {
    const changes = diffFederalPayload(
      "epa-ejscreen-blockgroup",
      {
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 65,
        pm25Percentile: 72,
      },
      {
        kind: "ejscreen-blockgroup",
        demographicIndexPercentile: 71,
        pm25Percentile: 72,
      },
    );
    expect(changes).toEqual([
      {
        key: "demographicIndexPercentile",
        label: "EJ Index",
        before: "65th pctile",
        after: "71st pctile",
      },
    ]);
  });

  it("normalizes FCC broadband Mbps → Gbps the same way the chip does", () => {
    const changes = diffFederalPayload(
      "fcc-broadband-availability",
      {
        kind: "broadband-availability",
        providerCount: 1,
        fastestDownstreamMbps: 100,
      },
      {
        kind: "broadband-availability",
        providerCount: 2,
        fastestDownstreamMbps: 1000,
      },
    );
    expect(changes).toEqual([
      { key: "providerCount", label: "Providers", before: "1", after: "2" },
      {
        key: "fastestDownstreamMbps",
        label: "Fastest",
        before: "100 Mbps",
        after: "1 Gbps",
      },
    ]);
  });

  it("returns null when the payload kinds differ between reruns", () => {
    expect(
      diffFederalPayload(
        "fema-nfhl-flood-zone",
        { kind: "flood-zone", floodZone: "AE" },
        { kind: "elevation-point", elevationFeet: 100 },
      ),
    ).toBeNull();
  });

  it("returns null when either payload is malformed (missing kind / not an object)", () => {
    expect(
      diffFederalPayload(
        "fema-nfhl-flood-zone",
        { floodZone: "AE" },
        { kind: "flood-zone", floodZone: "X" },
      ),
    ).toBeNull();
    expect(
      diffFederalPayload(
        "fema-nfhl-flood-zone",
        null,
        { kind: "flood-zone", floodZone: "X" },
      ),
    ).toBeNull();
  });

  it("returns null for non-federal layer kinds (state/local rows are skipped)", () => {
    expect(
      diffFederalPayload(
        "grand-county-ut:zoning",
        { kind: "zoning", zoning: "RR-1" },
        { kind: "zoning", zoning: "RR-2" },
      ),
    ).toBeNull();
  });
});
