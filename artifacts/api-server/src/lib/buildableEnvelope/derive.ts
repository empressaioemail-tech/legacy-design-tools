/**
 * Buildable-envelope GEOMETRY helper (anti-zombie cut, Master WDLL 3.7 / I-A).
 *
 * Composes the real parcel polygon + the jurisdiction setback table into a
 * buildable-envelope GeoJSON polygon. This module is a pure geometry helper â€”
 * product confidence MUST NOT be `labeling×district product`.
 * Product confidence comes from the atom-chain readContract / engine compose
 * path. Callers that still need a wire confidence field must read atoms or
 * honest-decline (`atom_path_pending`), never invent a multiply.
 *
 * Approximate-ness here is geometry-signal only (shape front edge / empty
 * inset), not a substitute for atom assertedConfidence.
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";
import { insetPerEdge, ringAreaSqFt, type Ring } from "./geometry";
import {
  insetFeetForLabeling,
  type EdgeLabelingResult,
} from "./edgeLabeling";
import type { DistrictMappingResult } from "./districtMapping";

export interface BuildableEnvelopeProps {
  kind: "buildable-envelope";
  /** True when geometry signal is weak (shape front) or inset empty. */
  approximate: boolean;
  /** Always true â€” derived from public parcel + codified setbacks, not a survey. */
  notSurveyGrade: true;
  /** Human disclosure string for the UI. */
  disclosure: string;
  /** Applied setbacks (feet). */
  setbacks: {
    front_ft: number;
    side_ft: number;
    rear_ft: number;
    district: string;
  };
  /** How the front edge was inferred. */
  edgeSignal: EdgeLabelingResult["signal"];
  edgeNote: string;
  /** How the district was chosen. */
  districtNote: string;
  /** Areas (square feet). */
  parcelAreaSqFt: number;
  buildableAreaSqFt: number;
  buildableAreaPct: number;
  /** Dimensional caps that feed downstream ADU/addition sizing. */
  maxLotCoveragePct: number | null;
  maxHeightFt: number | null;
  /** Max footprint (sqft) = envelope area capped by lot coverage of the PARCEL. */
  maxFootprintSqFt: number | null;
  /** Citation URL (Municode) for the setback district. */
  citationUrl: string;
  /** Empty-envelope reason, when there is no buildable area. */
  emptyReason?: string;
}

export interface BuildableEnvelopeResult {
  /** The envelope FeatureCollection (0 or 1 features; empty when no buildable area). */
  geojson: {
    type: "FeatureCollection";
    features: {
      type: "Feature";
      geometry: { type: "Polygon"; coordinates: number[][][] } | null;
      properties: BuildableEnvelopeProps;
    }[];
  };
  /**
   * Product confidence is intentionally absent. The retired multiply
   * (`labeling×district product`) must not reappear.
   * Use atom readContract / engine compose for product confidence.
   */
  confidence: null;
  /** True when the envelope should render as approximate (geometry signal). */
  approximate: boolean;
  /** True when setbacks consume the lot (no buildable area). */
  empty: boolean;
  citationUrl: string;
  district: string;
}

export interface DeriveInput {
  ring: Ring;
  table: SetbackTable;
  district: DistrictMappingResult;
  labeling: EdgeLabelingResult;
}

function round(n: number, dp = 0): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * Compose the disclosure sentence from the two inference notes + the survey
 * caveat. Always names the weakest link so the user knows what to verify.
 */
function composeDisclosure(
  approximate: boolean,
  labeling: EdgeLabelingResult,
  district: DistrictMappingResult,
  empty: boolean,
  emptyReason?: string,
): string {
  if (empty) {
    return (
      `No buildable area: ${emptyReason ?? "setbacks exceed the lot"}. ` +
      `Approximate â€” verify with a survey and the city.`
    );
  }
  const parts: string[] = [];
  if (approximate) {
    parts.push("Approximate buildable area");
  } else {
    parts.push("Estimated buildable area");
  }
  parts.push(labeling.note.replace(/\.$/, ""));
  parts.push(district.note.replace(/\.$/, ""));
  parts.push(
    "Not survey grade â€” front/side/rear orientation and district are inferred; " +
      "verify with a survey and the city before relying on it",
  );
  return parts.join(". ") + ".";
}

export function deriveBuildableEnvelope(
  input: DeriveInput,
): BuildableEnvelopeResult {
  const { ring, district, labeling } = input;
  const d: SetbackDistrict = district.district;

  const insetFeet = insetFeetForLabeling(labeling, {
    front_ft: d.front_ft,
    side_ft: d.side_ft,
    rear_ft: d.rear_ft,
  });

  const inset = insetPerEdge(ring, insetFeet);

  // Geometry-only approximate signal. NEVER product confidence multiply.
  const approximate = labeling.signal === "shape" || inset.empty;

  const parcelAreaSqFt = round(
    inset.parcelAreaSqFt || ringAreaSqFt(ring),
  );
  const buildableAreaSqFt = round(inset.areaSqFt);
  const buildableAreaPct =
    parcelAreaSqFt > 0 ? round((buildableAreaSqFt / parcelAreaSqFt) * 100, 1) : 0;

  const maxLotCoveragePct =
    typeof d.max_lot_coverage_pct === "number" ? d.max_lot_coverage_pct : null;
  const maxHeightFt =
    typeof d.max_height_ft === "number" ? d.max_height_ft : null;

  let maxFootprintSqFt: number | null = null;
  if (!inset.empty && maxLotCoveragePct != null) {
    const coverageCap = (maxLotCoveragePct / 100) * parcelAreaSqFt;
    maxFootprintSqFt = round(Math.min(buildableAreaSqFt, coverageCap));
  } else if (!inset.empty) {
    maxFootprintSqFt = buildableAreaSqFt;
  }

  const disclosure = composeDisclosure(
    approximate,
    labeling,
    district,
    inset.empty,
    inset.emptyReason,
  );

  const props: BuildableEnvelopeProps = {
    kind: "buildable-envelope",
    approximate,
    notSurveyGrade: true,
    disclosure,
    setbacks: {
      front_ft: d.front_ft,
      side_ft: d.side_ft,
      rear_ft: d.rear_ft,
      district: d.district_name,
    },
    edgeSignal: labeling.signal,
    edgeNote: labeling.note,
    districtNote: district.note,
    parcelAreaSqFt,
    buildableAreaSqFt,
    buildableAreaPct,
    maxLotCoveragePct,
    maxHeightFt,
    maxFootprintSqFt,
    citationUrl: d.citation_url,
    ...(inset.empty ? { emptyReason: inset.emptyReason } : {}),
  };

  const features: BuildableEnvelopeResult["geojson"]["features"] = [];
  if (!inset.empty && inset.ring) {
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [inset.ring] },
      properties: props,
    });
  } else {
    features.push({
      type: "Feature",
      geometry: null,
      properties: props,
    });
  }

  return {
    geojson: { type: "FeatureCollection", features },
    confidence: null,
    approximate,
    empty: inset.empty,
    citationUrl: d.citation_url,
    district: d.district_name,
  };
}

