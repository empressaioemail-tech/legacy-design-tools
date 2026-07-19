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
export const STREET_TYPE_ABBR: Record<string, string> = {
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
export const DIRECTIONAL_ABBR: Record<string, string> = {
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

/**
 * The ordered set of (spelledOut -> abbrev) canonicalizations the JS
 * normalizer applies, derived from the SAME two token maps so the SQL
 * side (below) and the JS side (above) can never drift. Only pairs where
 * the source spelling differs from its abbreviation are emitted (a token
 * that already equals its abbreviation is a no-op). Directionals are
 * listed before street types to mirror the JS lookup order
 * (`DIRECTIONAL_ABBR[t] ?? STREET_TYPE_ABBR[t]`); since the two key sets
 * are disjoint and no abbreviation is itself a spelled-out key, the order
 * only documents intent — there is no cascading between rules.
 */
export function streetCanonicalizationPairs(): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const map of [DIRECTIONAL_ABBR, STREET_TYPE_ABBR]) {
    for (const [word, abbr] of Object.entries(map)) {
      if (word === abbr) continue; // no-op (already canonical)
      if (seen.has(word)) continue; // first map wins, mirroring JS
      seen.add(word);
      pairs.push([word, abbr]);
    }
  }
  return pairs;
}

/**
 * Build a SQL expression that normalizes a STORED situs/full_addr column
 * to the SAME canonical street line `normalizeStreetLine()` produces for
 * the query — SYMMETRICALLY, including street-type + directional
 * canonicalization (so a stored spelled-out "144 THOMAS PLACE" matches a
 * query of "144 Thomas Place" AND "144 Thomas Pl"). Generated from
 * {@link streetCanonicalizationPairs} so it cannot diverge from the JS
 * normalizer.
 *
 * Shape (mirrors `normalizeStreetLine`, column side):
 *   1. `split_part(col, ',', 1)`  — drop city/state/zip after first comma.
 *   2. uppercase, strip periods, collapse whitespace, trim.
 *   3. for each (spelledOut -> abbrev): replace whole-word occurrences
 *      (`\m..\M` word boundaries, global) with the abbreviation.
 *
 * Every function used (`split_part`, `upper`, `trim`, `regexp_replace`)
 * is IMMUTABLE, so this expression is valid as a functional-index key —
 * the resolver queries and the migration's indexes build the expression
 * from THIS function, guaranteeing they match byte-for-byte.
 *
 * `col` is the raw column SQL text, e.g. `"situs_address"` or
 * `"full_addr"` (already the correct identifier for the target table).
 */
export function buildNormalizedStreetSql(col: string): string {
  // Base: comma-split, upper, strip periods, collapse whitespace, trim.
  // Note the ordering — strip periods BEFORE collapsing whitespace, same
  // as the JS `.replace(/[.]/g,"").replace(/\s+/g," ")` order.
  let expr =
    `trim(regexp_replace(` +
    `regexp_replace(upper(split_part(${col}, ',', 1)), '[.]', '', 'g'), ` +
    `'\\s+', ' ', 'g'))`;
  // Wrap the base in a leading+trailing space so a token at the very
  // start or end still sits between word boundaries uniformly; the outer
  // trim() at the end removes them. (Postgres \m/\M already handle edges,
  // but this keeps the expression robust and readable.)
  for (const [word, abbr] of streetCanonicalizationPairs()) {
    // \m WORD \M = whole-word match on WORD (Postgres regex word bounds).
    expr = `regexp_replace(${expr}, '\\m${word}\\M', '${abbr}', 'g')`;
  }
  // Final trim + whitespace collapse in case a replacement changed length
  // (it never introduces spaces, but keep the contract identical).
  return `trim(${expr})`;
}
