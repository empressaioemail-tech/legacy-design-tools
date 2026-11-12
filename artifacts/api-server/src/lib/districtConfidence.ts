/**
 * District confidence for the setback rail.
 *
 * The factory's zoning stamp writes a parcel_record cell `zoningConfidence`
 * ("high" | "medium") beside `zoningDistrict`, and carries the same label onto
 * the setback cells it writes (`zoningConfidence` + `districtConfidence`).
 * A parcel whose district could not be read at all is never stamped, which the
 * rails already serve as "Not checked".
 *
 * One internal notion, two values:
 *   - "high"           -> confirmed. Nothing changes in the copy.
 *   - "medium"         -> review, worded "for review at the edges".
 *   - any other value  -> review, worded "marked for review". No invented scale.
 *   - absent           -> confirmed (today's behavior; Bastrop and Travis are unchanged).
 *
 * The disclosure is plain words and never says "guarantee" or "safe".
 */

export type DistrictConfidenceLevel = "confirmed" | "review";

export type DistrictConfidence = {
  level: DistrictConfidenceLevel;
  /** The stamp's own label, as written ("high", "medium", ...). */
  label: string;
};

/**
 * Numeric stand-in for DistrictMappingResult.confidence when the district is
 * under review. Confirmed stays 1. The wire does not read this number for the
 * product confidence (derive.ts); it only has to stop saying 1 for a district
 * that is not certain.
 */
export const REVIEW_DISTRICT_CONFIDENCE = 0.5;

export const DISTRICT_REVIEW_EDGES_DISCLOSURE =
  "The zoning district for this parcel was read from the city's zoning map and is for review at the edges; setbacks are shown for review, not confirmed.";
export const DISTRICT_REVIEW_DISCLOSURE =
  "The zoning district for this parcel was read from the city's zoning map and is marked for review; setbacks are shown for review, not confirmed.";

/** Map a stamp label to the internal notion. Null or blank means the stamp carried none. */
export function districtConfidenceFromLabel(label: unknown): DistrictConfidence | null {
  if (label === null || label === undefined) return null;
  const text = typeof label === "string" ? label : String(label);
  const key = text.trim().toLowerCase();
  if (key === "high") return { level: "confirmed", label: text };
  return { level: "review", label: text };
}

/**
 * Read the confidence a factory-written cell carries (its `zoningConfidence` label, or
 * a `districtConfidence` level). Never throws; null when the cell says nothing.
 */
export function districtConfidenceFromRaw(raw: Record<string, unknown> | null | undefined): DistrictConfidence | null {
  if (!raw) return null;
  const fromLabel = districtConfidenceFromLabel(raw.zoningConfidence);
  if (fromLabel) return fromLabel;
  if (raw.districtConfidence === "review") return { level: "review", label: "review" };
  if (raw.districtConfidence === "confirmed") return { level: "confirmed", label: "confirmed" };
  return null;
}

/** The more cautious of two readings: review wins over confirmed, confirmed over nothing. */
export function mergeDistrictConfidence(
  a: DistrictConfidence | null | undefined,
  b: DistrictConfidence | null | undefined,
): DistrictConfidence | null {
  if (a?.level === "review") return a;
  if (b?.level === "review") return b;
  return a ?? b ?? null;
}

/** The disclosure sentence, or null when the district is confirmed (or unstamped). */
export function districtDisclosure(confidence: DistrictConfidence | null | undefined): string | null {
  if (!confidence || confidence.level !== "review") return null;
  return confidence.label.trim().toLowerCase() === "medium"
    ? DISTRICT_REVIEW_EDGES_DISCLOSURE
    : DISTRICT_REVIEW_DISCLOSURE;
}
