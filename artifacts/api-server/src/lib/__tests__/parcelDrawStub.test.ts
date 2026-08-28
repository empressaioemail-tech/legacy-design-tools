import { describe, expect, it } from "vitest";
import {
  assembleParcelDraw,
  assertDrawStub,
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
    yearBuilt: 1910,
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

  it("maps atom-miss well to unknown and pipeline outside to absent-verified", () => {
    const well = draw.overlays.find((o) => o.id === "well");
    const pipe = draw.overlays.find((o) => o.id === "pipeline");
    const foot = draw.overlays.find((o) => o.id === "footprint");
    expect(well?.state).toBe("unknown");
    expect(well?.label).toMatch(/not checked/i);
    expect(pipe?.state).toBe("absent-verified");
    expect(pipe?.label).toBe("No pipeline within 152.4 m");
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
  it("maps stored well absence to absent-verified, not unknown", () => {
    const draw = assembleParcelDraw(
      goldInput({ well: { state: "absent" } }),
    );
    expect(draw.overlays.find((o) => o.id === "well")).toMatchObject({
      state: "absent-verified",
    });
  });
});
