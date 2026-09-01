import { describe, expect, it } from "vitest";
import { interpretFloodHazardFactRows } from "../floodHazardFactRead";
import { interpretPipelineFactRows } from "../pipelineFactRead";
import { interpretWellFactRows } from "../wellFactRead";
import { interpretSpecialDistrictFactRows } from "../specialDistrictFactRead";
import { interpretBoundaryEdgeFactRows } from "../boundaryEdgeFactRead";
import { tryAssembleParcelDrawFromReads } from "../parcelDrawFromReads";
import type { StructuralFactRead } from "../structuralFactResolve";

const GOLD = "48021:34137";

const BOUNDARY_BODY = {
  entityType: "property-boundary-edge",
  edgeIndex: 0,
  role: "rear",
  adjacencyKind: "alley",
  parcelNeighborPropId: null,
  interior: {
    edgeEndpoints: [
      [0, 0],
      [30.48, 0],
    ],
  },
  propertyLineTags: { bearing: "N 90° E", distanceFeet: 100 },
  sourceAdapter: "descriptor-fixture",
};

const STRUCTURAL_PRESENT: StructuralFactRead = {
  state: "present",
  source: "structural-fact",
  countyFips: "48021",
  propId: "34137",
  taxYear: 2025,
  tier: "cad",
  livingAreaSqft: 1200,
  yearBuilt: 1910,
  sourceVintage: "tier:cad-export;adapter:bis-consultants;drop:202503",
};

const STRUCTURAL_ABSENT = {
  status: "absent",
  verdict: "lookup-failed",
} as StructuralFactRead;

function refusedFlood() {
  return interpretFloodHazardFactRows(GOLD, []);
}
function refusedPipeline() {
  return interpretPipelineFactRows(GOLD, []);
}
function refusedWell() {
  return interpretWellFactRows(GOLD, []);
}
function refusedSd() {
  return interpretSpecialDistrictFactRows(GOLD, []);
}

function drawFrom(args: {
  floodRows?: Array<{ entity_id: string; body: Record<string, unknown> }>;
  pipelineRows?: Array<{ entity_id: string; body: Record<string, unknown> }>;
  wellRows?: Array<{ entity_id: string; body: Record<string, unknown> }>;
  sdRows?: Array<{ entity_id: string; body: Record<string, unknown> }>;
  structural?: StructuralFactRead;
  facets?: unknown;
  queryPoint?: { latitude: number; longitude: number } | null;
}) {
  const boundary = interpretBoundaryEdgeFactRows(GOLD, [
    { entity_id: `${GOLD}:boundary:0`, body: BOUNDARY_BODY },
  ]);
  return tryAssembleParcelDrawFromReads({
    parcelNodeId: GOLD,
    facets: args.facets ?? {
      baseFacts: { landUse: { code: "A1", description: "Residential", vintage: "2025" } },
      situsAddress: "908 PINE, BASTROP, TX 78602",
    },
    bakedAt: "2026-08-04",
    queryPoint:
      args.queryPoint !== undefined
        ? args.queryPoint
        : { latitude: 30.1102, longitude: -97.315 },
    boundary,
    flood: args.floodRows
      ? interpretFloodHazardFactRows("48021:99999", args.floodRows)
      : refusedFlood(),
    pipeline: args.pipelineRows
      ? interpretPipelineFactRows("48021:99999", args.pipelineRows)
      : refusedPipeline(),
    well: args.wellRows
      ? interpretWellFactRows("48021:99999", args.wellRows)
      : refusedWell(),
    specialDistrict: args.sdRows
      ? interpretSpecialDistrictFactRows("48021:99999", args.sdRows)
      : refusedSd(),
    structural: args.structural ?? STRUCTURAL_ABSENT,
  });
}

describe("parcelDrawFromReads sourceVintage (item 4, both arms)", () => {
  it("flood absence with a known vintage is absent-verified", () => {
    const draw = drawFrom({
      floodRows: [
        {
          entity_id: "48021:99999",
          body: {
            entityType: "flood-hazard-fact",
            sourceTier: "absent",
            absence: { kind: "no-flood-coverage", reason: "outside NFHL tile" },
            sourceVintage: "NFHL_48_20260101",
          },
        },
      ],
    });
    expect(draw?.overlays.find((o) => o.id === "flood")).toMatchObject({
      state: "absent-verified",
      provenance: "present",
      vintage: "NFHL_48_20260101",
    });
  });

  it("flood absence without a vintage is unknown", () => {
    const draw = drawFrom({
      floodRows: [
        {
          entity_id: "48021:99999",
          body: {
            entityType: "flood-hazard-fact",
            sourceTier: "absent",
            absence: { kind: "no-flood-coverage", reason: "outside NFHL tile" },
          },
        },
      ],
    });
    expect(draw?.overlays.find((o) => o.id === "flood")).toMatchObject({
      state: "unknown",
      reason: "provenance unknown; vintage unknown",
    });
  });

  it("well and specialDistrict and pipeline-plain-absent follow the same vintage rule", () => {
    const withVintage = drawFrom({
      wellRows: [
        {
          entity_id: "48021:99999:none",
          body: {
            entityType: "well-fact",
            wellKey: "none",
            absence: { kind: "no-well-on-or-near", reason: "none within 152 m" },
            sourceVintage: "RRC_WELLS_2026-07",
          },
        },
      ],
      sdRows: [
        {
          entity_id: "48021:99999:sd:none",
          body: {
            entityType: "special-district-fact",
            districtId: "none",
            absence: { kind: "outside-districts", reason: "outside mapped" },
            sourceVintage: "TCEQ_SD_2026-07",
          },
        },
      ],
      pipelineRows: [
        {
          entity_id: "48021:99999",
          body: {
            entityType: "rrc-pipeline-fact",
            sourceTier: "absent",
            absence: { kind: "no-pipeline", reason: "none of record" },
            sourceVintage: "RRC_T4_2026Q1",
          },
        },
      ],
    });
    expect(withVintage?.overlays.find((o) => o.id === "well")?.state).toBe(
      "absent-verified",
    );
    expect(withVintage?.overlays.find((o) => o.id === "specialDistrict")?.state).toBe(
      "absent-verified",
    );
    expect(withVintage?.overlays.find((o) => o.id === "pipeline")?.state).toBe(
      "absent-verified",
    );

    const without = drawFrom({
      wellRows: [
        {
          entity_id: "48021:99999:none",
          body: {
            entityType: "well-fact",
            wellKey: "none",
            absence: { kind: "no-well-on-or-near", reason: "none within 152 m" },
          },
        },
      ],
      sdRows: [
        {
          entity_id: "48021:99999:sd:none",
          body: {
            entityType: "special-district-fact",
            districtId: "none",
            absence: { kind: "outside-districts", reason: "outside mapped" },
          },
        },
      ],
      pipelineRows: [
        {
          entity_id: "48021:99999",
          body: {
            entityType: "rrc-pipeline-fact",
            sourceTier: "absent",
            absence: { kind: "no-pipeline", reason: "none of record" },
          },
        },
      ],
    });
    expect(without?.overlays.find((o) => o.id === "well")?.state).toBe("unknown");
    expect(without?.overlays.find((o) => o.id === "specialDistrict")?.state).toBe(
      "unknown",
    );
    expect(without?.overlays.find((o) => o.id === "pipeline")?.state).toBe("unknown");
  });
});

describe("parcelDrawFromReads one-liners", () => {
  it("attrs.landUse.desc and taxYear populate from bake description/vintage", () => {
    const draw = drawFrom({});
    expect(draw?.attrs.landUse).toMatchObject({
      v: "A1",
      desc: "Residential",
      taxYear: 2025,
    });
  });

  it("yearBuilt comes only from cad_property; bake facets.yearBuilt is ignored", () => {
    const fromBakeOnly = drawFrom({
      structural: STRUCTURAL_ABSENT,
      facets: {
        yearBuilt: 2022,
        baseFacts: { yearBuilt: 2022, landUse: { code: "A1" } },
      },
    });
    expect(fromBakeOnly?.attrs.yearBuilt).toBeUndefined();

    const fromCad = drawFrom({ structural: STRUCTURAL_PRESENT });
    expect(fromCad?.attrs.yearBuilt).toEqual({
      v: 1910,
      state: "present",
      source: "cad_property",
      sourceVintage: "tier:cad-export;adapter:bis-consultants;drop:202503",
    });
  });

  it("sourceAdapter and absolute anchor appear on the wire", () => {
    const draw = drawFrom({});
    expect(draw?.edges?.[0]?.sourceAdapter).toBe("descriptor-fixture");
    expect(draw?.frame.anchor).toEqual({ lat: 30.1102, lng: -97.315 });
    expect(draw?.edges?.[0]).toHaveProperty("neighbor");
  });

  it("anchor is null when the query point is missing, never invented", () => {
    const draw = drawFrom({ queryPoint: null });
    expect(draw?.frame.anchor).toBeNull();
  });

  it("merges onRecord CAD values onto draw attrs with source and vintage", () => {
    const draw = drawFrom({
      facets: {
        countyFips: "48021",
        countyName: "Bastrop",
        baseFacts: {
          apn: "34137",
          situsState: "TX",
          cadRoll: {
            marketValue: {
              v: 100000,
              source: "cad_property",
              vintage: "2025",
              valueBasis: "county-assessed",
            },
            assessedValue: null,
            landValue: null,
            improvementValue: null,
            livingAreaSqft: null,
          },
        },
      },
    });
    expect(draw?.attrs.marketValue).toMatchObject({
      state: "present",
      v: 100000,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(draw?.attrs.assessedValue).toMatchObject({ state: "absent" });
    expect((draw?.attrs.assessedValue as { v?: unknown }).v).toBeUndefined();
  });

  it("vacant-lot draw: baked improvementValue 0 serves state zero, not absent", () => {
    const draw = drawFrom({
      facets: {
        countyFips: "48021",
        countyName: "Bastrop",
        baseFacts: {
          apn: "vacant",
          situsState: "TX",
          cadRoll: {
            marketValue: {
              v: 45000,
              source: "cad_property",
              vintage: "2025",
              valueBasis: "county-assessed",
            },
            assessedValue: {
              v: 45000,
              source: "cad_property",
              vintage: "2025",
              valueBasis: "county-assessed",
            },
            landValue: {
              v: 45000,
              source: "cad_property",
              vintage: "2025",
              valueBasis: "county-assessed",
            },
            improvementValue: {
              v: 0,
              source: "cad_property",
              vintage: "2025",
              valueBasis: "county-assessed",
            },
            livingAreaSqft: null,
          },
        },
      },
    });
    expect(draw?.attrs.improvementValue).toMatchObject({
      state: "zero",
      v: 0,
      source: "cad_property",
      vintage: "2025",
      valueBasis: "county-assessed",
    });
    expect(draw?.attrs.livingAreaSqft).toMatchObject({ state: "absent" });
    expect((draw?.attrs.livingAreaSqft as { v?: unknown }).v).toBeUndefined();
  });
});
