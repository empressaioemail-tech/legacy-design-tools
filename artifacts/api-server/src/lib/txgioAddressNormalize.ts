/**
 * Dependency-free address normalization for the F4d authoritative
 * address->parcel resolver.
 *
 * Extracted from `txgioAddressResolve.ts` (which is db-backed) so the
 * pure string logic can be unit-tested without pulling in `@workspace/db`
 * — the same pattern `ptadLandUse` uses to stay importable by the
 * offline bake. The db-backed resolver re-exports `normalizeStreetLine`
 * so existing import sites keep working.
 *
 * The job: fold a typed address to the canonical `"{number} {street}"`
 * token stream the appraisal situs / StratMap `full_addr` stores use, so
 * a string match is robust to case, punctuation, street-type spelling
 * (Lane<->LN), directionals, and a trailing city/state/zip or unit.
 */

/** USPS street-type synonyms -> canonical abbreviation (uppercase). */
const STREET_TYPE_ABBR: Record<string, string> = {
  ALLEY: "ALY",
  ALY: "ALY",
  AVENUE: "AVE",
  AVE: "AVE",
  AV: "AVE",
  BOULEVARD: "BLVD",
  BLVD: "BLVD",
  BEND: "BND",
  BND: "BND",
  CIRCLE: "CIR",
  CIR: "CIR",
  COURT: "CT",
  CT: "CT",
  COVE: "CV",
  CV: "CV",
  CROSSING: "XING",
  XING: "XING",
  DRIVE: "DR",
  DR: "DR",
  EXPRESSWAY: "EXPY",
  EXPY: "EXPY",
  HIGHWAY: "HWY",
  HWY: "HWY",
  HOLLOW: "HOLW",
  HOLW: "HOLW",
  LANE: "LN",
  LN: "LN",
  LOOP: "LOOP",
  PARKWAY: "PKWY",
  PKWY: "PKWY",
  PASS: "PASS",
  PATH: "PATH",
  PLACE: "PL",
  PL: "PL",
  PLAZA: "PLZ",
  PLZ: "PLZ",
  POINT: "PT",
  PT: "PT",
  RIDGE: "RDG",
  RDG: "RDG",
  ROAD: "RD",
  RD: "RD",
  ROW: "ROW",
  RUN: "RUN",
  SQUARE: "SQ",
  SQ: "SQ",
  STREET: "ST",
  ST: "ST",
  TERRACE: "TER",
  TER: "TER",
  TRACE: "TRCE",
  TRCE: "TRCE",
  TRAIL: "TRL",
  TRL: "TRL",
  TURNPIKE: "TPKE",
  TPKE: "TPKE",
  WAY: "WAY",
};

/** Directional synonyms -> canonical abbreviation. */
const DIRECTIONAL_ABBR: Record<string, string> = {
  NORTH: "N",
  N: "N",
  SOUTH: "S",
  S: "S",
  EAST: "E",
  E: "E",
  WEST: "W",
  W: "W",
  NORTHEAST: "NE",
  NE: "NE",
  NORTHWEST: "NW",
  NW: "NW",
  SOUTHEAST: "SE",
  SE: "SE",
  SOUTHWEST: "SW",
  SW: "SW",
};

/** Secondary-unit designators — everything from here on is a unit. */
const UNIT_DESIGNATORS = new Set([
  "APT",
  "APARTMENT",
  "UNIT",
  "STE",
  "SUITE",
  "BLDG",
  "BUILDING",
  "FL",
  "FLOOR",
  "RM",
  "ROOM",
  "SPC",
  "SPACE",
  "TRLR",
  "LOT",
  "#",
]);

/**
 * Normalize an address to a canonical `"{number} {street}"` token stream
 * for equality comparison against a stored situs/full_addr. Drops any
 * trailing city/state/zip (so a typed "6026 Marsh Ln, Buda, TX 78610"
 * still compares against the store's "6026 MARSH LN"), a trailing unit,
 * and canonicalizes street-type + directional words to their USPS
 * abbreviation.
 *
 * Returns null when there is nothing usable (no leading house number).
 */
export function normalizeStreetLine(raw: string): string | null {
  if (!raw) return null;
  // Take the FIRST comma-delimited segment — the street line. A typed
  // full address ("6026 Marsh Ln, Buda, TX 78610") and a bare street
  // line both reduce to the same street tokens this way, and a stored
  // situs that DOES carry city/state ("6026 MARSH LN, BUDA, TX 78610")
  // is normalized the same way when we build its comparison key.
  const firstSegment = raw.split(",")[0] ?? raw;
  const cleaned = firstSegment
    .toUpperCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  // Must start with a house number (the situs/full_addr store both do).
  // Addresses with no leading number (e.g. a bare street or the empty
  // ", ," situs) are not matchable this way -> null.
  if (!/^\d/.test(tokens[0]!)) return null;

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Stop at a secondary-unit designator (and its value): the store's
    // street label does not carry the unit inline.
    if (UNIT_DESIGNATORS.has(t) || t.startsWith("#")) break;
    const canonical = DIRECTIONAL_ABBR[t] ?? STREET_TYPE_ABBR[t] ?? t;
    out.push(canonical);
  }
  if (out.length < 2) return null; // need at least number + one street token
  return out.join(" ");
}
