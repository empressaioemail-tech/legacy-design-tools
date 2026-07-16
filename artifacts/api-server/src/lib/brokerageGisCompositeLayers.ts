/**
 * Max map composite reasoning layers — fixture-friendly EngineEnvelope responses.
 */

import {
  wrapEngineEnvelope,
  type EngineEnvelope,
  type EngineHonesty,
} from "../../../../lib/engine-core/src/envelope";
import {
  legacyHonestyToReadContract,
  readContractForWire,
} from "@workspace/engine-core";
import type { ReadContract } from "@hauska/atom-contract/read-contract";
import type { ArcGisGeoJsonFeatureCollection } from "@workspace/adapters/arcgis";
import type { GisLayerBbox } from "./brokerageGisLayers";
import {
  ozTractsInBbox,
  ozTractLayerProvenance,
} from "./opportunityZoneAdapter";

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

export type CompositeLayerProvenance = {
  ozDesignation: {
    source: string;
    sourceUrl: string | null;
    designationRound: string;
    dataVintage: string | null;
    tractListVersion: string;
    nationalDesignatedTractCount: number | null;
    bundledScope: string | null;
    matchMethod: "bbox-overlap";
  };
  dealSignal: {
    kind: "oz-designation-membership";
    source: string;
    excludes: string[];
    note: string;
  };
  generatedAt: string;
};

export type CompositeLayerPayload = {
  layer: CompositeLayerKey;
  geojson: ArcGisGeoJsonFeatureCollection;
  featureCount: number;
  queryMode: "bbox";
  fixture?: boolean;
  notes?: string;
  provenance?: CompositeLayerProvenance;
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

/**
 * Real oz-deal-crossfilter derivation (STEP B).
 *
 * Resolves which CDFI/HUD-designated Opportunity Zone tracts overlap the
 * requested viewport from the refreshed bundled OZ layer, and emits each with
 * real tract geometry plus full provenance. The "deal signal" is the OZ
 * designation itself — a public, investor-relevant tax-advantage signal
 * (capital-gains deferral eligibility). No Cotality propensity is consumed
 * (eval-clause); no synthetic dealScore/radarTier is invented.
 *
 * Membership is a deterministic bbox-overlap test against authoritative federal
 * geometry, so the honesty is deterministic/earned, not an asserted number.
 */
export function deriveOzDealCrossfilter(bbox: GisLayerBbox): {
  payload: CompositeLayerPayload;
  honesty: EngineHonesty;
} {
  const prov = ozTractLayerProvenance();
  const tracts = ozTractsInBbox({
    westLng: bbox.westLng,
    southLat: bbox.southLat,
    eastLng: bbox.eastLng,
    northLat: bbox.northLat,
  });
  const generatedAt = new Date().toISOString();

  const provenance: CompositeLayerProvenance = {
    ozDesignation: {
      source: prov.source,
      sourceUrl: prov.sourceUrl,
      designationRound: prov.designationRound,
      dataVintage: prov.dataVintage,
      tractListVersion: prov.tractListVersion,
      nationalDesignatedTractCount: prov.nationalDesignatedTractCount,
      bundledScope: prov.bundledScope,
      matchMethod: "bbox-overlap",
    },
    dealSignal: {
      kind: "oz-designation-membership",
      source: "CDFI/HUD OZ designation (public federal record)",
      excludes: ["cotality-propensity", "tenant-private", "synthetic-deal-score"],
      note:
        "v1 deal signal is OZ designation membership only. No public-record per-tract deal score exists in the spine yet; none is fabricated.",
    },
    generatedAt,
  };

  const features = tracts.map((t) => {
    const geoid = String(t.properties.geoid10 ?? "");
    return {
      type: "Feature" as const,
      geometry: t.geometry,
      properties: {
        kind: "oz-deal-crossfilter",
        geoid10: geoid,
        inOpportunityZone: true,
        ozDesignationRound: String(t.properties.round ?? prov.designationRound),
        countyFips: t.properties.countyfp ?? null,
        stateFips: t.properties.statefp ?? null,
        dealSignal: "oz-designation-membership",
        dealSignalSource: "CDFI/HUD OZ designation (public federal record)",
        // Reasoning chain per commitment #1 — no bare/unearned number.
        reasoning: `Tract ${geoid} is a CDFI/HUD-designated Opportunity Zone (${provenance.ozDesignation.designationRound}); OZ status is a public, investor-relevant capital-gains-deferral signal. Membership resolved by deterministic bbox overlap against authoritative federal geometry.`,
        confidence: 1,
        confidenceKind: "deterministic",
        source: prov.source,
        sourceUrl: prov.sourceUrl,
        dataVintage: prov.dataVintage,
        generatedAt,
      },
    };
  });

  const honesty: EngineHonesty = {
    confidence: { value: 1, kind: "deterministic" },
    dataVintage: prov.dataVintage,
    coverage: { degraded: false },
    source: {
      adapter: "brokerage:composite-oz-deal-crossfilter",
    },
  };

  return {
    payload: {
      layer: "oz-deal-crossfilter",
      queryMode: "bbox",
      fixture: false,
      featureCount: features.length,
      notes: `Designated OZ tracts overlapping the viewport (${features.length}), each carrying OZ-designation deal signal + provenance. Deal signal excludes Cotality propensity.`,
      provenance,
      geojson: {
        type: "FeatureCollection",
        features,
      },
    },
    honesty,
  };
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
    // Real derivation — never a fixture. Delegates to the OZ layer.
    return deriveOzDealCrossfilter(bbox).payload;
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
}): EngineEnvelope<CompositeLayerPayload> & { readContract: ReadContract } {
  // oz-deal-crossfilter is a real derivation over the refreshed OZ layer:
  // deterministic honesty, degraded:false, real provenance. It never presents
  // as a fixture, so an incoming fixture flag does not downgrade it.
  if (input.layer === "oz-deal-crossfilter") {
    const { payload, honesty } = deriveOzDealCrossfilter(input.bbox);
    return {
      ...wrapEngineEnvelope(payload, honesty),
      readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
    };
  }

  const payload = buildCompositeLayerFixture(input.layer, input.bbox);
  const honesty = defaultHonesty(`brokerage:composite-${input.layer}`, true);
  return {
    ...wrapEngineEnvelope(
      {
        ...payload,
        fixture: input.fixture ?? payload.fixture,
      },
      honesty,
    ),
    readContract: readContractForWire(legacyHonestyToReadContract(honesty)),
  };
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
      description:
        "CDFI/HUD-designated Opportunity Zone tracts in view, carrying OZ-designation deal signal + provenance (public-record only; no Cotality propensity)",
    },
    {
      layer: "motivated-seller",
      adapterKey: "brokerage:composite-motivated-seller",
      description:
        "Propensity × absentee × equity × tax-delinquency motivated-seller heat",
    },
  ];
}
