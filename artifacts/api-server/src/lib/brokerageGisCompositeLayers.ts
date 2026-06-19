/**
 * Max map composite reasoning layers — fixture-friendly EngineEnvelope responses.
 */

import {
  wrapEngineEnvelope,
  type EngineEnvelope,
  type EngineHonesty,
} from "../../../../lib/engine-core/src/envelope";
import type { ArcGisGeoJsonFeatureCollection } from "@workspace/adapters/arcgis";
import type { GisLayerBbox } from "./brokerageGisLayers";

export type CompositeLayerKey =
  | "buildable-envelope"
  | "constraint-density"
  | "oz-deal-crossfilter"
  | "motivated-seller";

export const COMPOSITE_LAYER_KEYS: readonly CompositeLayerKey[] = [
  "buildable-envelope",
  "constraint-density",
  "oz-deal-crossfilter",
  "motivated-seller",
];

export type CompositeLayerPayload = {
  layer: CompositeLayerKey;
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "bbox";
  fixture?: boolean;
  notes?: string;
};

function defaultHonesty(adapter: string, degraded = false): EngineHonesty {
  return {
    confidence: { value: degraded ? 0.55 : 0.72, kind: "asserted" },
    dataVintage: new Date().toISOString().slice(0, 10),
    coverage: degraded
      ? {
          degraded: true,
          reason: "Composite derived from fixture/synthetic inputs for dev.",
        }
      : { degraded: false },
    source: { adapter },
  };
}

function parcelRing(bbox: GisLayerBbox, scale = 0.35): number[][] {
  const cx = (bbox.westLng + bbox.eastLng) / 2;
  const cy = (bbox.southLat + bbox.northLat) / 2;
  const dx = (bbox.eastLng - bbox.westLng) * scale;
  const dy = (bbox.northLat - bbox.southLat) * scale;
  return [
    [cx - dx, cy - dy],
    [cx + dx, cy - dy],
    [cx + dx, cy + dy],
    [cx - dx, cy + dy],
    [cx - dx, cy - dy],
  ];
}

function insetRing(outer: number[][], inset = 0.15): number[][] {
  const cx =
    outer.reduce((s, p) => s + p[0]!, 0) / Math.max(outer.length - 1, 1);
  const cy =
    outer.reduce((s, p) => s + p[1]!, 0) / Math.max(outer.length - 1, 1);
  return outer.map(([x, y]) => [
    cx + (x! - cx) * (1 - inset),
    cy + (y! - cy) * (1 - inset),
  ]);
}

export function buildCompositeLayerFixture(
  layer: CompositeLayerKey,
  bbox: GisLayerBbox,
): CompositeLayerPayload {
  const parcel = parcelRing(bbox);
  const buildable = insetRing(parcel, 0.22);

  if (layer === "buildable-envelope") {
    return {
      layer,
      queryMode: "bbox",
      fixture: true,
      featureCount: 1,
      notes:
        "Parcel minus floodway/floodplain/steep slope/aquifer recharge (fixture).",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [buildable] },
            properties: {
              kind: "buildable-envelope",
              constraintsRemoved: [
                "floodway",
                "floodplain",
                "steep-slope",
                "aquifer-recharge",
              ],
              buildableAreaPct: 78,
            },
          },
        ],
      },
    };
  }

  if (layer === "constraint-density") {
    return {
      layer,
      queryMode: "bbox",
      fixture: true,
      featureCount: 1,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [parcel] },
            properties: {
              kind: "constraint-density",
              constraintCount: 4,
              overlays: ["floodplain", "steep-slope", "aquifer", "wetland"],
            },
          },
        ],
      },
    };
  }

  if (layer === "oz-deal-crossfilter") {
    return {
      layer,
      queryMode: "bbox",
      fixture: true,
      featureCount: 1,
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Polygon", coordinates: [parcel] },
            properties: {
              kind: "oz-deal-crossfilter",
              geoid10: "48453002400",
              inOpportunityZone: true,
              dealScore: 0.82,
              radarTier: "A",
            },
          },
        ],
      },
    };
  }

  return {
    layer: "motivated-seller",
    queryMode: "bbox",
    fixture: true,
    featureCount: 1,
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [parcel] },
          properties: {
            kind: "motivated-seller",
            motivatedSellerHeat: 0.74,
            propensity: 0.81,
            absenteeOwner: 1,
            equityPosition: 0.62,
            taxDelinquency: 0.55,
          },
        },
      ],
    },
  };
}

export function queryCompositeLayer(input: {
  layer: CompositeLayerKey;
  bbox: GisLayerBbox;
  fixture?: boolean;
}): EngineEnvelope<CompositeLayerPayload> {
  const payload = buildCompositeLayerFixture(input.layer, input.bbox);
  const honesty = defaultHonesty(`brokerage:composite-${input.layer}`, true);
  return wrapEngineEnvelope(
    {
      ...payload,
      fixture: input.fixture ?? payload.fixture,
    },
    honesty,
  );
}

export function listCompositeLayerEndpoints(): Array<{
  layer: CompositeLayerKey;
  adapterKey: string;
  description: string;
}> {
  return [
    {
      layer: "buildable-envelope",
      adapterKey: "brokerage:composite-buildable-envelope",
      description: "Parcel minus floodway, floodplain, steep slope, aquifer recharge",
    },
    {
      layer: "constraint-density",
      adapterKey: "brokerage:composite-constraint-density",
      description: "Overlay constraint count per parcel polygon",
    },
    {
      layer: "oz-deal-crossfilter",
      adapterKey: "brokerage:composite-oz-deal-crossfilter",
      description: "Opportunity Zone tract crossed with fixture deal scores",
    },
    {
      layer: "motivated-seller",
      adapterKey: "brokerage:composite-motivated-seller",
      description:
        "Propensity × absentee × equity × tax-delinquency motivated-seller heat",
    },
  ];
}
