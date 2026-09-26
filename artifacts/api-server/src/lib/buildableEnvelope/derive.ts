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
import {
  insetPerEdge,
  ringAreaSqFt,
  type InsetEmptyKind,
  type Ring,
} from "./geometry";
import {
  insetFeetForLabeling,
  type EdgeLabelingResult,
} from "./edgeLabeling";
import type { DistrictMappingResult } from "./districtMapping";
import type { RoadClassSetbackDistrictRow } from "./roadClassSetbacks";
// P-270 (OPS-24 X11): the ONE place that decides whether a served citation's
// vintage was worth declaring. See that module's doc for the ruling it
// implements and for why it calls the corpus's own date reader rather than
// parsing a date itself.
import {
  disclosureWithCitationVintage,
  readSetbackDateFromRowAtSource,
  readSetbackDateFromTable,
  setbackCitationVintageRow,
  todayIso,
  SETBACK_ADOPTED_DATE_FIELD_KEYS,
  type SetbackCitationVintageDeclaration,
} from "./setbackCitationVintage";

/**
 * P-354 (2026-09-18). The district ROW's own date-bearing fields, in the
 * source's own spellings. A row MAY state its own effective date, and when it
 * does, that date is the row's rule and the table's is not.
 */
const SETBACK_RULE_ROW_DATE_FIELD_KEYS = ["effectiveDate", "effective_date"] as const;

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
    side_corner_ft?: number;
    district: string;
    /** Axes where the code is silent (build-to-line) — not real zero feet. */
    not_specified?: {
      front?: boolean;
      side?: boolean;
      rear?: boolean;
      side_corner?: boolean;
      /**
       * True when max_height_ft is a stated absence (provenance flag, or the
       * canonical 999 sentinel): `maxHeightFt` is null for the same reason and
       * must not be read as "no limit" or as a real height (P-299).
       */
      max_height?: boolean;
    };
  };
  /** How the front edge was inferred. */
  edgeSignal: EdgeLabelingResult["signal"];
  edgeNote: string;
  /** How the district was chosen. */
  districtNote: string;
  /** Areas (square feet). */
  parcelAreaSqFt: number;
  /**
   * P-304 (2026-09-17). The buildable-area figure and percent are OMITTED
   * whenever no ground-truth VERIFIED buildable-envelope atom backs them
   * (A-180; `_decisions/2026-09-11_ruling_b_reversed_polygon_only.md`): the
   * modelled polygon still draws, the figure does not. Optional on purpose, so
   * a consumer reads the key's ABSENCE as the withheld state and never as a
   * zero or as "nothing here" — `withholdUnverifiedAreaFigure`
   * (`reconcileAtomEnvelope.ts`) is the one writer of that absence, and
   * `isEnvelopeAtomVerified` is the one predicate that decides it.
   */
  buildableAreaSqFt?: number;
  buildableAreaPct?: number;
  /** Dimensional caps that feed downstream ADU/addition sizing. */
  maxLotCoveragePct: number | null;
  /**
   * Feet, or null when the code states no feet height for this district.
   * NEVER the corpus's 999 stated-absence sentinel (P-299): the sentinel means
   * "read the provenance flag", and a consumer that reads it as a number sizes
   * a 999-foot building. `setbacks.not_specified.max_height` says the same
   * thing in the props' own vocabulary.
   */
  maxHeightFt: number | null;
  /** Max footprint (sqft) = envelope area capped by lot coverage of the PARCEL. */
  maxFootprintSqFt: number | null;
  /** Citation URL (Municode) for the setback district. */
  citationUrl: string;
  /**
   * P-270 (OPS-24 X11). The effective date of the instrument the citation
   * above points at, read AT SOURCE from the codified table's own
   * `effectiveDate` field. Present ONLY when that field held a readable date
   * AND a citation is being served — the key's absence means the source's
   * date could not be read, and `citationVintage` beside it says which of the
   * three causes applies. Never a placeholder: this lane writes no default
   * date anywhere.
   *
   * P-354 (2026-09-18): a date read from the ROW and LATER THAN TODAY is
   * deliberately NOT published here either, even though it is readable. This
   * field means "the citation's date, in force"; a rule adopted but not yet
   * effective is declared through `citationVintage` instead, which names both
   * its adoption date and its effective date.
   */
  citationEffectiveDate?: string;
  /**
   * P-270 (OPS-24 X11). The declaration row, present only when the citation
   * above must not be printed as a plain in-force citation: its effective date
   * could not be read, or it WAS read and has not arrived yet (P-354). Its
   * absence means the vintage is known or nothing is cited — never that the
   * payload declined to say. Composed by the ONE module
   * `buildableEnvelope/setbackCitationVintage.ts`, byte-identical to
   * hauska-map's copy of the same sentence.
   */
  citationVintage?: SetbackCitationVintageDeclaration;
  /** Empty-envelope reason, when there is no buildable area. */
  emptyReason?: string;
  /**
   * Machine-readable class of the empty result (P60b reason split):
   * "consumed" is the only class meaning the setbacks genuinely exceed the
   * lot; "validation-failed" means the geometry gates declined the derived
   * ring and must never be presented as a consume-lot measurement.
   */
  emptyKind?: InsetEmptyKind;
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
  /** True when there is no buildable area (see emptyKind for which class). */
  empty: boolean;
  /** Set when empty: distinguishes consume-lot from a validation decline. */
  emptyKind?: InsetEmptyKind;
  citationUrl: string;
  /** P-270 (OPS-24 X11): the citation's readable, IN-FORCE effective date, or absent. See `BuildableEnvelopeProps`. */
  citationEffectiveDate?: string;
  /** P-270 (OPS-24 X11) + P-354: the declaration, present only when the citation is undated or not yet in force. See `BuildableEnvelopeProps`. */
  citationVintage?: SetbackCitationVintageDeclaration;
  district: string;
  /**
   * The per-edge feet the inset applied, in projectRing order. Not a wire
   * field: the route names setbacks explicitly and does not spread this.
   * Optional so a caller that rebuilds the result without it leaves the area
   * check unmeasured rather than failing it.
   */
  insetFeetPerEdge?: number[];
}

export interface DeriveInput {
  ring: Ring;
  table: SetbackTable;
  district: DistrictMappingResult;
  labeling: EdgeLabelingResult;
  /** When set, per-edge setbacks resolve from (road-class, edge-role). */
  roadClassSetbackTable?: RoadClassSetbackDistrictRow | null;
}

function round(n: number, dp = 0): number {
  const f = Math.pow(10, dp);
  return Math.round(n * f) / f;
}

/**
 * Compose the disclosure sentence from the two inference notes + the survey
 * caveat. Always names the weakest link so the user knows what to verify.
 */
function fieldNotSpecified(
  d: SetbackDistrict,
  key: "front_ft" | "side_ft" | "rear_ft" | "side_corner_ft",
): boolean {
  const p = d.provenance?.[key];
  return !!(
    p &&
    typeof p === "object" &&
    (p as { not_specified?: boolean }).not_specified === true
  );
}

/**
 * The canonical "the code states no feet limit" sentinel for max_height_ft
 * (hauska-setback-corpus rule G7 / `NOT_SPECIFIED_MAX_HEIGHT_FT`).
 *
 * 999 is not a height any of these codes states — it is a placeholder that only
 * means "read the flag". The flag is the entire payload: the provenance slot
 * (`not_specified: true`) carries the meaning and the number carries none.
 */
export const NOT_SPECIFIED_MAX_HEIGHT_FT = 999;

/**
 * True when this district's height limit is ABSENT rather than a number.
 *
 * Two spellings map to absent, and both must be treated as absent here:
 *   1. provenance.max_height_ft.not_specified === true — the honest form.
 *   2. the bare canonical sentinel 999 with no flag — the form that leaked.
 *      A table may not ship it (corpus rule G8 blocks it), but this reader sits
 *      downstream of a JSON file, not of that gate, so it fails closed on the
 *      value too: 999 ft is not a buildable height and G3's own sanity band tops
 *      max_height_ft out at 300, so no district can mean 999.
 *
 * P-299: before this, the envelope props carried max_height_ft straight through,
 * so a Round Rock stories-only district surfaced "max height 999 ft" to the UI
 * and to any consumer sizing an ADU or an addition against it.
 */
function heightNotSpecified(d: SetbackDistrict): boolean {
  const p = d.provenance?.["max_height_ft"];
  const flagged =
    !!p &&
    typeof p === "object" &&
    (p as { not_specified?: boolean }).not_specified === true;
  return flagged || d.max_height_ft === NOT_SPECIFIED_MAX_HEIGHT_FT;
}

function composeDisclosure(
  approximate: boolean,
  labeling: EdgeLabelingResult,
  district: DistrictMappingResult,
  empty: boolean,
  emptyReason?: string,
  notSpecifiedNote?: string,
  heightNotSpecifiedNote?: string,
): string {
  if (empty) {
    // Never default to consume-lot wording: an unexplained empty is a
    // validation gap, not a measurement.
    return (
      `No buildable area: ${emptyReason ?? "reason unavailable"}. ` +
      `Approximate — verify with a survey and the city.`
    );
  }
  const parts: string[] = [];
  if (approximate) {
    parts.push("Approximate buildable area");
  } else {
    parts.push("Estimated buildable area");
  }
  if (notSpecifiedNote) parts.push(notSpecifiedNote.replace(/\.$/, ""));
  if (heightNotSpecifiedNote) parts.push(heightNotSpecifiedNote.replace(/\.$/, ""));
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
  const { ring, district, labeling, table } = input;
  const d: SetbackDistrict = district.district;

  const not_specified = {
    ...(fieldNotSpecified(d, "front_ft") ? { front: true } : {}),
    ...(fieldNotSpecified(d, "side_ft") ? { side: true } : {}),
    ...(fieldNotSpecified(d, "rear_ft") ? { rear: true } : {}),
    ...(fieldNotSpecified(d, "side_corner_ft") ? { side_corner: true } : {}),
  };
  const hasSilent = Object.keys(not_specified).length > 0;

  // A road class is not a setback (engine-side precedent: commit 293633a,
  // "refuse road-class setbacks"). Never silently substitute one by default —
  // only a caller that explicitly opts in gets road-class-aware insets.
  const roadClassTable = input.roadClassSetbackTable ?? null;

  const insetFeet = insetFeetForLabeling(
    labeling,
    {
      front_ft: d.front_ft,
      side_ft: d.side_ft,
      rear_ft: d.rear_ft,
      side_corner_ft: d.side_corner_ft,
      ...(hasSilent ? { not_specified } : {}),
    },
    {
      districtCode: d.district_name,
      roadClassTable,
    },
  );

  const inset = insetPerEdge(ring, insetFeet);

  // Geometry-only approximate signal. NEVER product confidence multiply.
  // Corner-unresolved and silent axes force approximate disclosure.
  const approximate =
    labeling.signal === "shape" ||
    inset.empty ||
    labeling.cornerUnresolved === true ||
    hasSilent;

  const parcelAreaSqFt = round(
    inset.parcelAreaSqFt || ringAreaSqFt(ring),
  );
  const buildableAreaSqFt = round(inset.areaSqFt);
  const buildableAreaPct =
    parcelAreaSqFt > 0 ? round((buildableAreaSqFt / parcelAreaSqFt) * 100, 1) : 0;

  const coverageFlag = d.provenance?.["max_lot_coverage_pct"];
  const coverageSilent =
    !!coverageFlag &&
    typeof coverageFlag === "object" &&
    (coverageFlag as { not_specified?: boolean }).not_specified === true;
  const maxLotCoveragePct = coverageSilent
    ? null
    : typeof d.max_lot_coverage_pct === "number"
      ? d.max_lot_coverage_pct
      : null;
  // P-299: a flagged (or bare-sentinel) height is ABSENT, not 999 feet. The
  // sentinel is the code's way of saying "no feet scalar here" (Round Rock
  // states these heights in stories), so it must reach the wire as absence.
  const heightSilent = heightNotSpecified(d);
  const maxHeightFt =
    !heightSilent && typeof d.max_height_ft === "number" ? d.max_height_ft : null;

  let maxFootprintSqFt: number | null = null;
  if (!inset.empty && maxLotCoveragePct != null) {
    const coverageCap = (maxLotCoveragePct / 100) * parcelAreaSqFt;
    maxFootprintSqFt = round(Math.min(buildableAreaSqFt, coverageCap));
  } else if (!inset.empty) {
    maxFootprintSqFt = buildableAreaSqFt;
  }

  // When every applied inset is silence (not_specified), an empty inset is a
  // geometry failure — never "setbacks consume the lot" from fabricated zeros.
  const allSilentPrimary =
    fieldNotSpecified(d, "front_ft") &&
    fieldNotSpecified(d, "side_ft") &&
    fieldNotSpecified(d, "rear_ft");
  const emptyReason =
    inset.empty && allSilentPrimary
      ? "Envelope geometry failed; code states no scalar setbacks (build-to-line governs) — not a consume-lot finding"
      : inset.emptyReason;
  // Fail closed on the class: an empty result of unknown class, or one built
  // from all-silent (fabricated-zero) setbacks, is a validation failure and
  // must never be presented as a consume-lot measurement.
  const emptyKind: InsetEmptyKind | undefined = inset.empty
    ? allSilentPrimary
      ? "validation-failed"
      : (inset.emptyKind ?? "validation-failed")
    : undefined;

  const silentNote = hasSilent
    ? "One or more scalar setbacks are not specified in the code (build-to-line governs); silent axes are not treated as 0 ft entitlements"
    : undefined;
  // P-299: say the height is absent out loud. Serving null silently would drop
  // the one fact the reader needs — that the code states no feet height for
  // this district, rather than that the field is missing from the payload.
  const heightNotSpecifiedNote = heightSilent
    ? "The code states no feet-based maximum height for this district (height is stated in stories or not as a feet scalar); no height limit is reported here — check the district's own note and the city before relying on a height"
    : undefined;

  const disclosure = composeDisclosure(
    approximate,
    labeling,
    district,
    inset.empty,
    emptyReason,
    silentNote,
    heightNotSpecifiedNote,
  );

  // P-270 (OPS-24 X11). The table's own date, read AT SOURCE, and the one
  // sentence that says so when it cannot be read. Both are gated on a
  // citation actually being served: with no citation there is nothing for a
  // vintage to qualify, and declaring one would be a statement about an
  // instrument this payload does not name. `never-looked` is NOT reachable
  // here any more, because this line IS the look.
  //
  // P-354 (2026-09-18). The ROW is asked FIRST and the table only when the row
  // states no date at all — the same precedence the corpus's own
  // `dateFromRowEffectiveDate` applies, so the surface and the resolver cannot
  // disagree about which of the two dates is the rule's. A row that states an
  // UNREADABLE date does not fall back to the table: that would be the silent
  // pick, and an unreadable value in a good field is a different defect from a
  // source with no date. A row date LATER THAN TODAY reads as
  // `future-effective`: the row is in the payload (the operator's A-218 ruling
  // serves Georgetown from its rewrite ahead of 2026-11-01) and the sentence
  // names BOTH dates instead of printing it as already in force.
  const citationUrl = (d.citation_url ?? "").trim();
  const rowDateRead = readSetbackDateFromRowAtSource(
    d as unknown as Record<string, unknown>,
    SETBACK_RULE_ROW_DATE_FIELD_KEYS,
    { adoptedKeys: SETBACK_ADOPTED_DATE_FIELD_KEYS, asOf: todayIso() },
  );
  const citationDateRead =
    rowDateRead.state === "unreadable-absent-at-source"
      ? readSetbackDateFromTable(table)
      : rowDateRead;
  const citationVintage = setbackCitationVintageRow({
    date: citationDateRead,
    citationUrl,
    sourceLabel: `codified setback table ${table.jurisdictionKey} (${table.jurisdictionDisplayName})`,
  });
  const disclosureWithVintage =
    disclosureWithCitationVintage(disclosure, citationVintage) ?? disclosure;

  const props: BuildableEnvelopeProps = {
    kind: "buildable-envelope",
    approximate,
    notSurveyGrade: true,
    disclosure: disclosureWithVintage,
    setbacks: {
      front_ft: d.front_ft,
      side_ft: d.side_ft,
      rear_ft: d.rear_ft,
      side_corner_ft: d.side_corner_ft,
      district: d.district_name,
      ...(hasSilent || heightSilent
        ? {
            not_specified: {
              ...not_specified,
              ...(heightSilent ? { max_height: true } : {}),
            },
          }
        : {}),
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
    ...(citationDateRead.state === "read" && citationUrl
      ? { citationEffectiveDate: citationDateRead.sourceDate! }
      : {}),
    ...(citationVintage ? { citationVintage } : {}),
    ...(inset.empty ? { emptyReason, emptyKind } : {}),
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
    ...(emptyKind ? { emptyKind } : {}),
    citationUrl: d.citation_url,
    ...(citationDateRead.state === "read" && citationUrl
      ? { citationEffectiveDate: citationDateRead.sourceDate! }
      : {}),
    ...(citationVintage ? { citationVintage } : {}),
    district: d.district_name,
    insetFeetPerEdge: insetFeet,
  };
}

