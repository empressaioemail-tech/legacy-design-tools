/**
 * Compose a saved-property / stub label from situs parts.
 * Punctuation-only strings (the live `48021:25420` `", ,"` defect) never
 * become a label. Fallback is the node id plus situs unknown.
 */

const PUNCTUATION_ONLY_RE = /^[\s,.\-;:'"`]+$/;

export type SitusDisposition = "present" | "unknown";

export type ComposedSitusLabel = {
  label: string;
  situs: SitusDisposition;
};

export function isPunctuationOnlySitus(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim();
  return s === "" || PUNCTUATION_ONLY_RE.test(s);
}

function tokenFromPart(part: string | null | undefined): string | null {
  if (part == null) return null;
  const trimmed = part.trim();
  if (trimmed === "" || PUNCTUATION_ONLY_RE.test(trimmed)) return null;
  return trimmed;
}

/**
 * Join situs components. Empty or separator-only parts are dropped.
 * If nothing remains, label is the node id and situs is unknown.
 */
export function composeSitusLabel(input: {
  parcelNodeId: string;
  parts?: Array<string | null | undefined>;
  composed?: string | null;
}): ComposedSitusLabel {
  const parcelNodeId = input.parcelNodeId.trim();
  const fromComposed = tokenFromPart(input.composed);
  if (fromComposed) {
    return { label: fromComposed, situs: "present" };
  }
  const tokens = (input.parts ?? [])
    .map(tokenFromPart)
    .filter((t): t is string => t != null);
  if (tokens.length === 0) {
    return { label: parcelNodeId, situs: "unknown" };
  }
  return { label: tokens.join(", "), situs: "present" };
}

/** List-row projection: never emit a punctuation label. */
export function projectSavedPropertyLabel(
  parcelNodeId: string,
  storedLabel: string | null | undefined,
): ComposedSitusLabel {
  return composeSitusLabel({ parcelNodeId, composed: storedLabel ?? null });
}

/**
 * Draw / inspect label: first real candidate only.
 * Joining every address field would change gold draw.label (A3).
 */
export function firstPresentSitusLabel(
  parcelNodeId: string,
  candidates: Array<string | null | undefined>,
): ComposedSitusLabel {
  const first = candidates.find(
    (candidate) => typeof candidate === "string" && !isPunctuationOnlySitus(candidate),
  );
  return composeSitusLabel({
    parcelNodeId,
    composed: typeof first === "string" ? first : null,
  });
}
