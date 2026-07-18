/**
 * Buildable-envelope derivation (Problem C: the honest composition).
 *
 * Composes the real parcel polygon + the jurisdiction setback table into a
 * buildable-envelope GeoJSON polygon carrying an HONEST confidence + provenance
 * + citation, exactly like every other Brief output (structural commitment #1:
 * a wrong envelope drawn confidently is worse than none).
 *
 * The geometry (per-edge inset) is DETERMINISTIC given labeled edges + a
 * district; the UNCERTAINTY lives in two upstream inferences:
 *   - edge labeling (which edge is the front) — road / point / shape signal
 *   - district mapping (which setback row applies) — zoningCode match / fallback
 * The envelope confidence is the product of those two, and whenever either is
 * weak the payload is marked APPROXIMATE with an explicit disclosure. A
 * high-confidence envelope still reads as "not survey grade". Never a bare
 * confident polygon a user would treat as a survey.
 *
 * This module is pure (no Express, no DB): callers supply the parcel ring, the
 * setback table + mapped district, the labeling, and the citation. The route
 * (brokeragePlaceBuildableEnvelope.ts) does the fetching and wraps the result
 * in the engine envelope.
 */

import type { SetbackDistrict, SetbackTable } from "@workspace/adapters";
import { insetPerEdge, ringAreaSqFt, type Ring } from "./geometry";
import {
  insetFeetForLabeling,
  type EdgeLabelingResult,
} from "./edgeLabeling";
import type { DistrictMappingResult } from "./districtMapping";

/** Confidence floor below which the envelope is always "approximate". */
export const APPROXIMATE_THRESHOLD = 0.7;

export interface BuildableEnvelopeProps {
  kind: "buildable-envelope";
  /** True unless BOTH labeling and district mapping were high-confidence. */
  approximate: boolean;
  /** Always true — derived from public parcel + codified setbacks, not a survey. */
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
  /** Overall confidence 0..1 (labeling x district), for the honesty envelope. */
  confidence: number;
  /** True when the envelope should render as approximate. */
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
      `Approximate — verify with a survey and the city.`
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
    "Not survey grade — front/side/rear orientation and district are inferred; " +
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

  // Overall confidence = labeling confidence x district confidence. Both are
  // inferences; a weak either makes the whole thing weak.
  const confidence = round(labeling.confidence * district.confidence, 3);
  const approximate = confidence < APPROXIMATE_THRESHOLD || inset.empty;

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

  // Max footprint feeds downstream ADU/addition sizing: the buildable footprint
  // is bounded by BOTH the setback envelope AND the lot-coverage cap (applied to
  // the PARCEL area, which is how coverage ordinances read). Take the smaller.
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
    // Empty-envelope: an honest feature carrying null geometry + the reason, so
    // the consumer can render the "no buildable area" state with the disclosure
    // rather than silently drawing nothing.
    features.push({
      type: "Feature",
      geometry: null,
      properties: props,
    });
  }

  return {
    geojson: { type: "FeatureCollection", features },
    confidence,
    approximate,
    empty: inset.empty,
    citationUrl: d.citation_url,
    district: d.district_name,
  };
}
