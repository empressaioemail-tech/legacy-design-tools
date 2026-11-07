/**
 * P-445 fixtures from the real payload shape on 48021:27246.
 * One fixture per defect. Both directions where a gate is claimed.
 */
import { describe, expect, it } from "vitest";

import { lookUpEnvelopeTableRow } from "./envelopeDerivedFactCoherence";
import { buildR1Brief } from "./r1BriefCompose";
import { assembleParcelDraw } from "./parcelDrawStub";
import { serializeTwinOnRecord } from "./twinOnRecordSerialize";
import type { EnvelopeDrawOutcome } from "./buildableEnvelope/envelopeDrawOutcome";
import type { ZoningFactRead } from "./zoningFactFromParcelRecord";

const PI_ZONING: Extract<ZoningFactRead, { state: "present" }> = {
  state: "present",
  source: "zoning-fact-parcel-record",
  entityId: "48021:27246",
  district: "PI",
  jurisdictionKey: "bastrop-tx",
  provenance: "https://gis.example.test/zoning/bastrop",
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-04-14",
  evaluatedAt: "2026-04-14",
};

const MODELLED: EnvelopeDrawOutcome = {
  state: "modelled",
  chain: "present",
  model: {
    ringLngLat: [
      [-97.31, 30.11],
      [-97.309, 30.11],
      [-97.309, 30.111],
      [-97.31, 30.11],
    ],
    setbacks: {
      front_ft: 25,
      side_ft: 15,
      rear_ft: 20,
      side_corner_ft: 20,
      district: "PI",
    },
    disclosure: "BDC Sec. 14.02.003 H PI",
  },
};

const REFUSED: EnvelopeDrawOutcome = {
  state: "declined",
  refusal: { step: "setbacks-unresolved", chain: "present" },
};

function goldDrawInput(
  overrides: Record<string, unknown> = {},
): Parameters<typeof assembleParcelDraw>[0] {
  return {
    parcelNodeId: "48021:27246",
    label: "1201 WATER, BASTROP, TX",
    bakedAt: "2026-09-25",
    countyFips: "48021",
    zoning: { district: "PI" },
    landUse: { landUseCode: "C1" },
    yearBuilt: { v: 1960, source: "cad_property", sourceVintage: "2025" },
    anchor: { lat: 30.11, lng: -97.31 },
    boundary: { state: "refused", code: "atom-miss" },
    flood: { state: "refused" },
    envelopeRefusalReason: "setbacks-unresolved",
    pipeline: { state: "refused" },
    well: { state: "refused", code: "atom-miss" },
    specialDistrict: { state: "absent" },
    ...overrides,
  };
}

describe("P-445.1 refused envelope yields no draw envelope", () => {
  it("a declined envelopeOutcome refuses the brief and the draw overlay with the same reason", () => {
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      envelopeOutcome: REFUSED,
    });
    const envelope = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelope?.disposition).toBe("refused");
    expect(envelope?.reason).toBe("setbacks-unresolved");

    const draw = assembleParcelDraw(
      goldDrawInput({
        envelopeRefusalReason: "setbacks-unresolved",
        envelopeModelled: null,
      }),
    );
    const overlay = draw.overlays.find((o) => o.id === "envelope");
    expect(overlay?.state).toBe("refused");
    expect(overlay?.reason).toBe("setbacks-unresolved");
    expect(overlay?.geom).toBe("none");
  });

  it("a modelled envelopeOutcome presents the brief and a present draw overlay", () => {
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      envelopeOutcome: MODELLED,
    });
    const envelope = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelope?.disposition).toBe("present");
    const data = envelope?.data as { frontFt?: number; district?: string };
    expect(data.frontFt).toBe(25);
    expect(data.district).toBe("PI");
  });
});

describe("P-445.2 envelope fields share one reason with zoning", () => {
  it("zoning PI present carries its GIS citation and vintage, not a blank degrade", () => {
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      parcelRecordZoningFact: PI_ZONING,
    });
    const zoning = brief.sections.find((s) => s.id === "zoning");
    expect(zoning?.disposition).toBe("present");
    expect(zoning?.citations).toEqual([
      "https://gis.example.test/zoning/bastrop",
    ]);
    expect(zoning?.asOf).toBe("2026-04-14");
    expect(zoning?.citationsDegraded).toBeFalsy();
  });
});

describe("P-445.3 present footprint fact yields a measured overlay", () => {
  it("unknown/unmeasured when no fact is passed (today's default)", () => {
    const draw = assembleParcelDraw(goldDrawInput());
    const foot = draw.overlays.find((o) => o.id === "footprint");
    expect(foot?.state).toBe("unknown");
    expect(foot?.label).toMatch(/unmeasured/);
  });

  it("present fact → present overlay, not unmeasured", () => {
    const draw = assembleParcelDraw(
      goldDrawInput({
        buildingFootprint: {
          state: "present",
          source: "building-footprint",
          sourceVintage: "2026-03-01",
        },
      }),
    );
    const foot = draw.overlays.find((o) => o.id === "footprint");
    expect(foot?.state).toBe("present");
    expect(foot?.label).not.toMatch(/unmeasured/);
    expect(foot?.basis).toBe("measured-fact");
    expect(foot?.vintage).toBe("2026-03-01");
  });
});

describe("P-445.4 citation without a vintage fails unless it declares why", () => {
  it("land-use present with no URL declares why", () => {
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      landUseFact: {
        state: "present",
        source: "land-use-fact",
        boundAs: "48021:27246",
        tried: ["48021:27246", "48021:27246.00000000"],
        entityId: "48021:27246:2025",
        taxYear: 2025,
        landUseCode: "C1",
        landUseLabel: "Commercial",
        sourceAdapter: "cad_property",
        sourceVintage: "2025-bastrop-cad-export",
        evaluatedAt: "2025-bastrop-cad-export",
      },
    });
    const land = brief.sections.find((s) => s.id === "land-use");
    expect(land?.disposition).toBe("present");
    expect(land?.citations).toEqual([]);
    expect(land?.citationsDegraded).toBe(true);
    expect(land?.citationsUnavailableReason).toMatch(/2025-bastrop-cad-export/);
    expect(land?.asOf).toBe("2025-bastrop-cad-export");
    // asOf is evaluatedAt; vintage is declared on the citation reason
  });

  it("zoning with a provenance URL is not degraded", () => {
    const brief = buildR1Brief({}, null, { parcelRecordZoningFact: PI_ZONING });
    const zoning = brief.sections.find((s) => s.id === "zoning");
    expect(zoning?.citationsDegraded).toBeFalsy();
    expect(zoning?.citationsUnavailableReason).toBeUndefined();
  });
});

describe("P-445.5 two areas, each labelled; headline names one source", () => {
  it("labels acreage by method and sets areaHeadline to that source", () => {
    const onRecord = serializeTwinOnRecord(
      {
        countyFips: "48021",
        countyName: "Bastrop",
        bakedAt: "2026-09-25",
        baseFacts: {
          apn: "27246",
          situsState: "TX",
          acreage: {
            value: 1.086,
            sqft: 47309,
            method: "cad-roll-land-acres",
          },
        },
      },
      "48021:27246",
      true,
    );
    expect(onRecord.acreage).toMatchObject({
      sqft: 47309,
      method: "cad-roll-land-acres",
      source: "cad-roll-land-acres",
      sourceLabel: "county appraisal district roll (land acres)",
    });
    expect(onRecord.areaHeadline).toEqual({
      sqft: 47309,
      source: "cad-roll-land-acres",
      sourceLabel: "county appraisal district roll (land acres)",
    });
  });

  it("shoelace acreage is labelled computed geometry, not CAD", () => {
    const onRecord = serializeTwinOnRecord(
      {
        baseFacts: {
          acreage: { value: 1.082, sqft: 47151.47, method: "shoelace-wgs84" },
        },
      },
      "48021:27246",
      true,
    );
    expect(onRecord.acreage?.sourceLabel).toBe(
      "computed parcel geometry (shoelace WGS84)",
    );
    expect(onRecord.areaHeadline?.source).toBe("shoelace-wgs84");
  });
});

describe("P-445 three-parcel class: PI (new row), SF-1 (had a row), MU (still none)", () => {
  it("48021:34049-class SF-1 has a chart row; a modelled outcome presents the brief", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "SF-1");
    expect(row.tableHasDistrictRow).toBe(true);
    expect(row.district?.front_ft).toBe(30);
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      envelopeOutcome: {
        state: "modelled",
        chain: "present",
        model: {
          ringLngLat: [
            [-97.31, 30.11],
            [-97.309, 30.11],
            [-97.309, 30.111],
            [-97.31, 30.11],
          ],
          setbacks: {
            front_ft: 30,
            side_ft: 10,
            rear_ft: 30,
            side_corner_ft: 20,
            district: "SF-1",
          },
          disclosure: "BDC Sec. 14.02.003 SF-1",
        },
      },
    });
    const envelope = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelope?.disposition).toBe("present");
    expect((envelope?.data as { district?: string }).district).toBe("SF-1");
  });

  it("a Bastrop MU district still has no chart row — code-sets-none, never not-a-district", () => {
    const row = lookUpEnvelopeTableRow("bastrop-tx", "MU");
    expect(row.tableHasDistrictRow).toBe(false);
    const brief = buildR1Brief({ bakedAt: "2026-09-25" }, null, {
      envelopeOutcome: {
        state: "declined",
        refusal: { step: "setbacks-unresolved", chain: "present" },
      },
    });
    const envelope = brief.sections.find((s) => s.id === "setbacks-envelope");
    expect(envelope?.disposition).toBe("refused");
    expect(envelope?.reason).toBe("setbacks-unresolved");
  });
});
