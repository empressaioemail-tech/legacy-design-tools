import { describe, expect, it } from "vitest";
import {
  assembleParcelDraw,
  assertDrawStub,
  disposeDrawEdgeNeighbor,
  metresToSurveyFeet,
  type AssembleParcelDrawInput,
  type DrawBoundaryEdgeIn,
  type ParcelDrawStub,
} from "../parcelDrawStub";

const GOLD_EDGES: DrawBoundaryEdgeIn[] = [
  {
    entityId: "48021:34137:boundary:0",
    edgeIndex: 0,
    role: "rear",
    adjacencyKind: "alley",
    parcelNeighborPropId: null,
    facingRoad: {
      roadNodeId: "48021:road:925036023",
      classification: "alley",
    },
    interior: {
      edgeEndpoints: [
        [14.814489172284857, 25.585977892777553],
        [-15.353665357492847, 25.51295230710278],
      ],
    },
    propertyLineTags: { bearing: "S 89°52' W", distanceFeet: 98.97717491201193 },
    sourceAdapter: "descriptor-fixture",
  },
  {
    entityId: "48021:34137:boundary:1",
    edgeIndex: 1,
    role: "side",
    adjacencyKind: "neighbor-parcel",
    parcelNeighborPropId: "34169",
    facingRoad: null,
    interior: {
      edgeEndpoints: [
        [-15.353665357492847, 25.51295230710278],
        [-14.956914885858247, -25.6894493599237],
      ],
    },
    propertyLineTags: { bearing: "S 0°27' E", distanceFeet: 167.99192515757665 },
    sourceAdapter: "descriptor-fixture",
    neighborCheck: { result: "reciprocal" },
  },
  {
    entityId: "48021:34137:boundary:2",
    edgeIndex: 2,
    role: "front",
    adjacencyKind: "ROW",
    parcelNeighborPropId: "34121",
    facingRoad: {
      roadNodeId: "48021:road:15113284",
      classification: "residential",
    },
    interior: {
      edgeEndpoints: [
        [-14.956914885858247, -25.6894493599237],
        [15.496091071066237, -25.409480839956633],
      ],
    },
    propertyLineTags: { bearing: "N 89°28' E", distanceFeet: 99.91565902085094 },
    sourceAdapter: "descriptor-fixture",
  },
  {
    entityId: "48021:34137:boundary:3",
    edgeIndex: 3,
    role: "side_corner",
    adjacencyKind: "ROW",
    parcelNeighborPropId: null,
    facingRoad: {
      roadNodeId: "48021:road:129017865",
      classification: "residential",
    },
    interior: {
      edgeEndpoints: [
        [15.496091071066237, -25.409480839956633],
        [14.814489172284857, 25.585977892777553],
      ],
    },
    propertyLineTags: { bearing: "N 0°46' W", distanceFeet: 167.32287943589597 },
    sourceAdapter: "descriptor-fixture",
  },
];

function goldInput(
  overrides: Partial<AssembleParcelDrawInput> = {},
): AssembleParcelDrawInput {
  return {
    parcelNodeId: "48021:34137",
    label: "908 PINE, BASTROP, TX 78602",
    bakedAt: "2026-08-04",
    countyFips: "48021",
    zoning: {
      district: "SF-1",
      cityKey: "bastrop-city-tx",
      matchBasis: "exact",
      sourceCodeAtomRef: {
        atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-003",
      },
      codeSectionRefs: {
        permittedUseTable: {
          atomDid: "did:hauska:code-section:bastrop_tx-bdc-2026-adopted/14-02-008",
        },
      },
    },
    landUse: {
      landUseCode: "A1",
      landUseDescription: "Single-family residential",
      taxYear: 2025,
    },
    yearBuilt: {
      v: 1910,
      source: "cad_property",
      sourceVintage: "tier:cad-export",
    },
    anchor: { lat: 30.1102, lng: -97.315 },
    boundary: { state: "present", edges: GOLD_EDGES },
    flood: {
      state: "present",
      floodZone: "X",
      zoneSubtype: "shaded, 0.2% annual chance",
      inSpecialFloodHazardArea: false,
    },
    envelopeRefusalReason: "atom_path_pending",
    pipeline: {
      state: "present",
      nearPipeline: false,
      bufferMeters: 152.4,
      sourceVintage: "UNKNOWN",
    },
    well: { state: "refused", code: "atom-miss" },
    specialDistrict: { state: "absent" },
    ...overrides,
  };
}

describe("metresToSurveyFeet", () => {
  it("reproduces gold distanceFeet to the hundredth on edge 0", () => {
    const dx = -15.353665357492847 - 14.814489172284857;
    const dy = 25.51295230710278 - 25.585977892777553;
    expect(metresToSurveyFeet(Math.hypot(dx, dy))).toBe(98.98);
  });
});

describe("assembleParcelDraw gold (WDLL 23–25)", () => {
  const draw = assembleParcelDraw(goldInput());

  it("projects the dump ring to the locked feet vertices", () => {
    expect(draw.ring).toEqual([
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ]);
    expect(draw.ringOrder).toBe("ccw");
    expect(draw.frame).toMatchObject({
      units: "ft",
      convertedFrom: "local-enu-m",
      factor: "us-survey-foot",
      quality: "gis-approximate",
    });
  });

  it("keeps per-edge frontage and does not treat front as the only road", () => {
    expect(draw.edges?.map((e) => e.role)).toEqual([
      "rear",
      "side",
      "front",
      "side_corner",
    ]);
    expect(draw.edges?.[0]?.roadNode).toBe("48021:road:925036023");
    expect(draw.edges?.[1]?.neighbor).toBe("48021:34169");
    expect(draw.edges?.[1]?.roadNode).toBeNull();
    expect(draw.edges?.[2]?.roadNode).toBe("48021:road:15113284");
    expect(draw.edges?.[3]?.roadNode).toBe("48021:road:129017865");
  });

  it("omits fixture setbacks and seed floats; deep-links; seed confidence", () => {
    expect(draw.attrs).not.toHaveProperty("setbacks");
    expect(JSON.stringify(draw)).not.toMatch(/0\.7|calibratedConfidence/);
    expect(draw.confidence).toBe("seed");
    expect(draw.url).toBe("https://smartsite.cloud/p/48021:34137");
    expect(draw.attrs.zoning).toMatchObject({
      v: "SF-1",
      refBasis: "body-denorm",
    });
  });

  it("maps atom-miss well to unknown; gold pipeline outside with vintage UNKNOWN is unknown, not verified (F5)", () => {
    const well = draw.overlays.find((o) => o.id === "well");
    const pipe = draw.overlays.find((o) => o.id === "pipeline");
    const foot = draw.overlays.find((o) => o.id === "footprint");
    expect(well?.state).toBe("unknown");
    expect(well?.label).toMatch(/not checked/i);
    expect(pipe?.state).toBe("unknown");
    expect(pipe?.reason).toBe("provenance degraded; vintage unknown");
    expect(pipe?.label).toBe("No pipeline within 500 ft");
    expect(foot?.state).toBe("unknown");
    expect(foot?.label).toMatch(/1910/);
    expect(foot?.draw).toBe("hatch-interior");
  });
});

describe("assembleParcelDraw miss path (WDLL 26)", () => {
  it("refuses to invent a ring when boundary atoms are missing", () => {
    const draw = assembleParcelDraw(
      goldInput({ boundary: { state: "refused", code: "atom-miss" } }),
    );
    expect(draw.ring).toBeUndefined();
    expect(draw.edges).toBeUndefined();
    const boundary = draw.overlays.find((o) => o.id === "boundary");
    expect(boundary).toMatchObject({
      state: "unknown",
      draw: "hatch-interior",
      label: "Parcel boundary unmeasured",
    });
  });
});

describe("assertDrawStub", () => {
  it("rejects unlabeled unknown hatch", () => {
    const bad = assembleParcelDraw(goldInput()) as ParcelDrawStub;
    bad.overlays.push({
      id: "x",
      label: "",
      draw: "hatch-interior",
      state: "unknown",
    });
    expect(() => assertDrawStub(bad)).toThrow(/label/);
  });
});

describe("typed well absence", () => {
  it("maps stored well absence with a vintage to absent-verified, not unknown", () => {
    const draw = assembleParcelDraw(
      goldInput({ well: { state: "absent", sourceVintage: "RRC_WELLS_2026-07" } }),
    );
    expect(draw.overlays.find((o) => o.id === "well")).toMatchObject({
      state: "absent-verified",
      provenance: "present",
      vintage: "RRC_WELLS_2026-07",
    });
  });

  it("maps stored well absence without a vintage to unknown and says why (F5)", () => {
    const draw = assembleParcelDraw(
      goldInput({ well: { state: "absent" } }),
    );
    expect(draw.overlays.find((o) => o.id === "well")).toMatchObject({
      state: "unknown",
      reason: "provenance unknown; vintage unknown",
    });
  });
});

function presentCitationDishonest(rail: {
  state?: unknown;
  citations?: unknown;
  citationsDegraded?: unknown;
}): boolean {
  if (rail.state !== "present") return false;
  const citations = Array.isArray(rail.citations)
    ? rail.citations.filter(
        (item) => typeof item === "string" && /^https?:\/\//i.test(item),
      )
    : [];
  return citations.length === 0 && rail.citationsDegraded !== true;
}

describe("assembleParcelDraw citation honesty (P-91 item 9)", () => {
  it("fails the empty-present shape: gold flood and landUse cannot be present with empty citations and no citationsDegraded", () => {
    const draw = assembleParcelDraw(goldInput());
    const flood = draw.overlays.find((o) => o.id === "flood");
    const landUse = draw.attrs.landUse as {
      state?: unknown;
      citations?: unknown;
      citationsDegraded?: unknown;
    } | undefined;
    expect(flood?.state).toBe("present");
    expect(landUse?.state).toBe("present");
    expect(presentCitationDishonest(flood ?? {})).toBe(false);
    expect(presentCitationDishonest(landUse ?? {})).toBe(false);
  });

  it("locks gold 48021:34137 ring and label from the item-27 probe", () => {
    const draw = assembleParcelDraw(
      goldInput({ label: "908 PINE , BASTROP, TX 78602" }),
    );
    expect(draw.node).toBe("48021:34137");
    expect(draw.label).toBe("908 PINE , BASTROP, TX 78602");
    expect(draw.ring).toEqual([
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ]);
    expect(draw.ringOrder).toBe("ccw");
  });

  it("attaches an http flood citation when the source carries one", () => {
    const url = "https://hazards.fema.gov/nfhlv2/output/State/NFHL_48_20260101.zip";
    const draw = assembleParcelDraw(
      goldInput({
        flood: {
          state: "present",
          floodZone: "X",
          zoneSubtype: "0.2 PCT ANNUAL CHANCE FLOOD HAZARD",
          inSpecialFloodHazardArea: false,
          citations: [url],
        },
      }),
    );
    const flood = draw.overlays.find((o) => o.id === "flood");
    expect(flood).toMatchObject({
      state: "present",
      citations: [url],
    });
    expect(flood).not.toHaveProperty("citationsDegraded");
  });

  it("attaches an http landUse citation when the source carries one", () => {
    const url = "https://example.test/bastrop-cad";
    const draw = assembleParcelDraw(
      goldInput({
        landUse: {
          landUseCode: "A1",
          sourceUrl: url,
        },
      }),
    );
    expect(draw.attrs.landUse).toMatchObject({
      v: "A1",
      state: "present",
      citations: [url],
    });
    expect(draw.attrs.landUse).not.toHaveProperty("citationsDegraded");
  });
});

describe("assertDrawStub present-citation fail-closed (P-91 item 9)", () => {
  it("rejects present flood with empty citations and no citationsDegraded", () => {
    const bad = assembleParcelDraw(goldInput()) as ParcelDrawStub;
    const flood = bad.overlays.find((o) => o.id === "flood");
    if (flood) {
      delete (flood as { citations?: unknown }).citations;
      delete (flood as { citationsDegraded?: unknown }).citationsDegraded;
    }
    expect(() => assertDrawStub(bad)).toThrow(/citationsDegraded|empty citation/i);
  });
});

/**
 * F5 (v2 card, triage D6). absent-verified was asserted with provenance
 * degraded and vintage UNKNOWN, and specialDistrict with no provenance at
 * all. Verified means verified: the state is earned only with known
 * provenance and a known vintage; otherwise unknown with a reason that
 * names what is missing. The pipeline radius prints in feet.
 */
describe("F5 verified means verified", () => {
  function absentVerifiedOverlays(draw: ParcelDrawStub) {
    return draw.overlays.filter((o) => o.state === "absent-verified");
  }

  it("gold pipeline (provenance degraded, vintage UNKNOWN) is unknown with both reasons and the radius in feet", () => {
    const pipe = assembleParcelDraw(goldInput()).overlays.find((o) => o.id === "pipeline");
    expect(pipe).toMatchObject({
      id: "pipeline",
      state: "unknown",
      reason: "provenance degraded; vintage unknown",
      provenance: "degraded",
      vintage: "UNKNOWN",
      label: "No pipeline within 500 ft",
    });
    expect(pipe?.label).not.toMatch(/152\.4| m$/);
  });

  it("pipeline outside with a known vintage stays absent-verified with provenance present", () => {
    const pipe = assembleParcelDraw(
      goldInput({
        pipeline: {
          state: "present",
          nearPipeline: false,
          bufferMeters: 152.4,
          sourceVintage: "RRC_T4_2026Q1",
        },
      }),
    ).overlays.find((o) => o.id === "pipeline");
    expect(pipe).toMatchObject({
      state: "absent-verified",
      provenance: "present",
      vintage: "RRC_T4_2026Q1",
      label: "No pipeline within 500 ft",
    });
    expect(pipe).not.toHaveProperty("reason");
  });

  it("pipeline outside with no vintage at all is unknown: provenance unknown; vintage unknown", () => {
    const pipe = assembleParcelDraw(
      goldInput({
        pipeline: {
          state: "present",
          nearPipeline: false,
          bufferMeters: 152.4,
          sourceVintage: null,
        },
      }),
    ).overlays.find((o) => o.id === "pipeline");
    expect(pipe).toMatchObject({
      state: "unknown",
      reason: "provenance unknown; vintage unknown",
    });
    expect(pipe).not.toHaveProperty("provenance");
    expect(pipe).not.toHaveProperty("vintage");
  });

  it("specialDistrict absent with no provenance field is unknown and says why", () => {
    const sd = assembleParcelDraw(goldInput()).overlays.find(
      (o) => o.id === "specialDistrict",
    );
    expect(sd).toMatchObject({
      id: "specialDistrict",
      state: "unknown",
      reason: "provenance unknown; vintage unknown",
    });
  });

  it("specialDistrict absent with a vintage is absent-verified", () => {
    const sd = assembleParcelDraw(
      goldInput({
        specialDistrict: { state: "absent", sourceVintage: "TCEQ_SD_2026-07" },
      }),
    ).overlays.find((o) => o.id === "specialDistrict");
    expect(sd).toMatchObject({
      state: "absent-verified",
      provenance: "present",
      vintage: "TCEQ_SD_2026-07",
    });
  });

  it("flood typed absence without a vintage is unknown, never absent-verified", () => {
    const flood = assembleParcelDraw(
      goldInput({ flood: { state: "absent" } }),
    ).overlays.find((o) => o.id === "flood");
    expect(flood?.state).toBe("unknown");
    expect(flood?.reason).toBe("provenance unknown; vintage unknown");
  });

  it("a vintage spelled UNKNOWN in any case, or blank, is not a vintage", () => {
    for (const vintage of ["UNKNOWN", "unknown", " Unknown ", ""]) {
      const pipe = assembleParcelDraw(
        goldInput({
          pipeline: {
            state: "present",
            nearPipeline: false,
            bufferMeters: 152.4,
            sourceVintage: vintage,
          },
        }),
      ).overlays.find((o) => o.id === "pipeline");
      expect(pipe?.state, "vintage=" + JSON.stringify(vintage)).toBe("unknown");
    }
  });

  it("invariant: no overlay is absent-verified without provenance present and a vintage", () => {
    const inputs = [
      goldInput(),
      goldInput({
        well: { state: "absent" },
        flood: { state: "absent" },
        pipeline: { state: "absent" },
      }),
      goldInput({
        well: { state: "absent", sourceVintage: "RRC_WELLS_2026-07" },
        specialDistrict: { state: "absent", sourceVintage: "TCEQ_SD_2026-07" },
        pipeline: { state: "absent", sourceVintage: "RRC_T4_2026Q1" },
      }),
    ];
    let verified = 0;
    for (const input of inputs) {
      for (const overlay of absentVerifiedOverlays(assembleParcelDraw(input))) {
        verified += 1;
        expect(overlay.provenance, overlay.id).toBe("present");
        expect(typeof overlay.vintage, overlay.id).toBe("string");
        expect(overlay.vintage!.trim().toUpperCase(), overlay.id).not.toBe("UNKNOWN");
        expect(overlay.vintage!.trim(), overlay.id).not.toBe("");
      }
    }
    // The sweep is not vacuous: the third input earns exactly three.
    expect(verified).toBe(3);
  });

  it("assertDrawStub refuses an absent-verified overlay that lost its provenance or vintage", () => {
    const good = assembleParcelDraw(
      goldInput({ well: { state: "absent", sourceVintage: "RRC_WELLS_2026-07" } }),
    );
    expect(() => assertDrawStub(good)).not.toThrow();
    const noProvenance = structuredClone(good) as ParcelDrawStub;
    const well = noProvenance.overlays.find((o) => o.id === "well")!;
    delete (well as { provenance?: unknown }).provenance;
    expect(() => assertDrawStub(noProvenance)).toThrow(/well overlay is absent-verified without/);
    const unknownVintage = structuredClone(good) as ParcelDrawStub;
    unknownVintage.overlays.find((o) => o.id === "well")!.vintage = "UNKNOWN";
    expect(() => assertDrawStub(unknownVintage)).toThrow(/well overlay is absent-verified without/);
  });
});

describe("X2 edge disposition (both arms)", () => {
  it("a gold reciprocal neighbour stays present and always keys neighbor", () => {
    const draw = assembleParcelDraw(goldInput());
    const side = draw.edges?.find((e) => e.id === "48021:34137:boundary:1");
    expect(side).toMatchObject({
      state: "present",
      neighbor: "48021:34169",
      reciprocity: "pass",
      sourceAdapter: "descriptor-fixture",
    });
    for (const edge of draw.edges ?? []) {
      expect(edge).toHaveProperty("neighbor");
      expect(edge).toHaveProperty("sourceAdapter");
    }
    expect(draw.frame.anchor).toEqual({ lat: 30.1102, lng: -97.315 });
  });

  it("an unchecked neighbour id is unknown, never present", () => {
    const draw = assembleParcelDraw(goldInput());
    const front = draw.edges?.find((e) => e.id === "48021:34137:boundary:2");
    expect(front).toMatchObject({
      state: "unknown",
      neighbor: "48021:34121",
    });
    expect(front).not.toHaveProperty("reciprocity");
  });

  it("a contradicted neighbour cannot emit present", () => {
    const edges = GOLD_EDGES.map((e) =>
      e.edgeIndex === 1
        ? {
            ...e,
            neighborCheck: {
              result: "contradicted" as const,
              agentGuidance:
                "Reciprocal edge on 48021:34169 does not name this parcel.",
            },
          }
        : e,
    );
    const draw = assembleParcelDraw(
      goldInput({ boundary: { state: "present", edges } }),
    );
    const side = draw.edges?.find((e) => e.id === "48021:34137:boundary:1");
    expect(side?.state).toBe("refused");
    expect(side).toMatchObject({
      neighbor: "48021:34169",
      agentGuidance:
        "Reciprocal edge on 48021:34169 does not name this parcel.",
    });
    expect(side?.state).not.toBe("present");
  });

  it("a self-neighbour is refused from the payload, not from adjacencyKind", () => {
    const disposed = disposeDrawEdgeNeighbor({
      parcelNodeId: "48021:34137",
      parcelNeighborPropId: "34137",
      fips: "48021",
    });
    expect(disposed).toMatchObject({
      state: "refused",
      neighbor: "48021:34137",
    });
    expect(disposed.state).not.toBe("present");
  });

  it("null neighbour is unknown, not a present without a witness", () => {
    const rear = assembleParcelDraw(goldInput()).edges?.find(
      (e) => e.id === "48021:34137:boundary:0",
    );
    expect(rear).toMatchObject({
      state: "unknown",
      neighbor: null,
      reason: "no neighbour of record",
    });
    expect(rear).not.toHaveProperty("reciprocity");
  });

  it("a retired edge is dropped; the active sibling stays", () => {
    const edges = [
      ...GOLD_EDGES,
      {
        ...GOLD_EDGES[1]!,
        entityId: "48021:34137:boundary:99",
        edgeIndex: 99,
        status: "retired",
        parcelNeighborPropId: "99999",
      },
    ];
    const draw = assembleParcelDraw(
      goldInput({ boundary: { state: "present", edges } }),
    );
    expect(draw.edges?.some((e) => e.id === "48021:34137:boundary:99")).toBe(
      false,
    );
    expect(
      draw.edges?.some((e) => e.id === "48021:34137:boundary:1"),
    ).toBe(true);
  });
});

describe("landUse bake keys (description / vintage)", () => {
  it("populates desc and taxYear from the keys the bake writes", () => {
    const draw = assembleParcelDraw(
      goldInput({
        landUse: {
          code: "A1",
          description: "Single-family residential",
          vintage: "2025",
        },
      }),
    );
    expect(draw.attrs.landUse).toMatchObject({
      v: "A1",
      desc: "Single-family residential",
      taxYear: 2025,
      state: "present",
    });
  });
});

describe("yearBuilt carries its source, never a bake fallback shape", () => {
  it("ships cad_property on the wire", () => {
    const draw = assembleParcelDraw(goldInput());
    expect(draw.attrs.yearBuilt).toEqual({
      v: 1910,
      state: "present",
      source: "cad_property",
      sourceVintage: "tier:cad-export",
    });
  });
});

describe("feetLabelFromMetres prints no more precision than the source", () => {
  it("152.4 m (one decimal) prints as whole feet: 500 ft", async () => {
    const mod = (await import("../parcelDrawStub")) as {
      feetLabelFromMetres?: (metres: number) => string;
    };
    expect(typeof mod.feetLabelFromMetres).toBe("function");
    expect(mod.feetLabelFromMetres!(152.4)).toBe("500 ft");
    expect(mod.feetLabelFromMetres!(100)).toBe("328 ft");
    expect(mod.feetLabelFromMetres!(30.48)).toBe("100.0 ft");
    expect(mod.feetLabelFromMetres!(0.5)).toBe("2 ft");
  });
});
