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
 * Fold the FIRST comma-delimited segment of a typed address into the
 * canonical token stream a stored situs/full_addr street line reduces to:
 * uppercase, punctuation-stripped, whitespace-collapsed, unit-truncated,
 * and street-type/directional canonicalized to USPS abbreviations. Returns
 * an empty array when there is no leading house number (unmatchable).
 *
 * Shared by {@link normalizeStreetLine} and
 * {@link normalizeStreetLineCandidates} so both derive their key(s) from
 * the identical base tokenization.
 */
function baseStreetTokens(raw: string): string[] {
  return tokenizeSegment(raw.split(",")[0] ?? raw);
}

/**
 * Tokenize ONE already-isolated address segment (case-folded,
 * punctuation-stripped, whitespace-collapsed) to the canonical street-token
 * stream, applying the unit-truncation and street-type/directional
 * canonicalization. The caller decides what the "segment" is:
 * {@link baseStreetTokens} passes the FIRST comma-delimited piece (the
 * primary key), while {@link normalizeStreetLineCandidates} also passes the
 * WHOLE comma-flattened address so a trailing `<state> <zip>` anchor that
 * sits behind a mis-placed comma still survives to drive the drop-N strip.
 */
function tokenizeSegment(segment: string): string[] {
  if (!segment) return [];
  const cleaned = segment
    .toUpperCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return [];

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];

  // Must start with a house number (the situs/full_addr store both do).
  // Addresses with no leading number (e.g. a bare street or the empty
  // ", ," situs) are not matchable this way -> [].
  if (!/^\d/.test(tokens[0]!)) return [];

  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    // Stop at a secondary-unit designator (and its value): the store's
    // street label does not carry the unit inline.
    if (UNIT_DESIGNATORS.has(t) || t.startsWith("#")) break;
    const canonical = DIRECTIONAL_ABBR[t] ?? STREET_TYPE_ABBR[t] ?? t;
    out.push(canonical);
  }
  return out;
}

/** A 5-digit or ZIP+4 zip token. */
const ZIP_RE = /^\d{5}(-\d{4})?$/;
/** A bare 2-letter US state token (already uppercased). Kept broad — any
 *  two-letter alpha token that sits directly before a trailing zip is a
 *  state in this position (the store is TX-only, but the anchor is the
 *  <state><zip> shape, not the literal "TX"). */
const STATE_RE = /^[A-Z]{2}$/;

/**
 * Normalize an address to a canonical `"{number} {street}"` token stream
 * for equality comparison against a stored situs/full_addr. Drops the
 * city/state/zip AFTER the first comma (so a typed
 * "6026 Marsh Ln, Buda, TX 78610" still compares against the store's
 * "6026 MARSH LN"), a trailing unit, and canonicalizes street-type +
 * directional words to their USPS abbreviation.
 *
 * This is the PRIMARY key. For a comma-LESS full address (the shape the FE
 * usually sends) it still contains the trailing locality; use
 * {@link normalizeStreetLineCandidates} to also get the city/state/zip-
 * stripped street-line candidates for the situs/rooftop lookups.
 *
 * Returns null when there is nothing usable (no leading house number, or
 * fewer than number + one street token).
 */
export function normalizeStreetLine(raw: string): string | null {
  const tokens = baseStreetTokens(raw);
  if (tokens.length < 2) return null; // need at least number + one street token
  return tokens.join(" ");
}

/**
 * Prefix-search key for situs typeahead — same tokenization as equality
 * match but allows a single house-number token ("6026") or a partial street
 * ("6026 MARSH"). Returns null when there is no leading house number.
 */
export function normalizeSitusSearchPrefix(raw: string): string | null {
  const tokens = tokenizeSegment(raw.split(",")[0] ?? raw);
  if (tokens.length === 0) return null;
  return tokens.join(" ");
}

/** Canonical street-type suffix tokens (USPS abbreviations). */
const STREET_TYPE_SUFFIXES = new Set(Object.values(STREET_TYPE_ABBR));

/**
 * Prefix variants for locality-filtered situs search. When the typed query
 * includes a street-type suffix ("908 Pine St") but the CAD situs omits it
 * ("908 PINE , BASTROP, TX 78602"), exact street-key lookup misses; prefix
 * ILIKE on the stripped form recovers the hit while locality still blocks
 * homonyms in other counties.
 */
export function situsSearchPrefixVariants(raw: string): string[] {
  const streetOnly = raw.split(",")[0] ?? raw;
  const primary = normalizeSitusSearchPrefix(streetOnly);
  if (!primary) return [];

  const variants: string[] = [primary];
  const tokens = primary.split(" ").filter(Boolean);
  if (tokens.length >= 3) {
    const last = tokens[tokens.length - 1]!;
    if (STREET_TYPE_SUFFIXES.has(last)) {
      const stripped = tokens.slice(0, -1).join(" ");
      if (stripped.length > 0 && !variants.includes(stripped)) {
        variants.push(stripped);
      }
    }
  }
  return variants;
}

/** City / state / ZIP constraints parsed from a typeahead or MCP find query. */
export type PlaceSearchLocality = {
  city: string | null;
  state: string | null;
  zip: string | null;
};

function normalizeLocalityToken(value: string | null | undefined): string | null {
  if (!value) return null;
  const folded = value.trim().toUpperCase().replace(/\s+/g, " ");
  return folded.length > 0 ? folded : null;
}

function parseLocalityTail(tail: string): PlaceSearchLocality {
  const upper = tail.toUpperCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();
  if (!upper) return { city: null, state: null, zip: null };

  const zipMatch = /\b(\d{5})(?:-\d{4})?\b/.exec(upper);
  const zip = zipMatch ? zipMatch[1]! : null;
  let rest = zipMatch ? upper.replace(zipMatch[0], " ").replace(/\s+/g, " ").trim() : upper;

  let state: string | null = null;
  const stateTail = /\b([A-Z]{2})\b$/.exec(rest);
  if (stateTail) {
    state = stateTail[1]!;
    rest = rest.slice(0, stateTail.index).trim();
  } else {
    const stateAny = /\b([A-Z]{2})\b/.exec(rest);
    if (stateAny) {
      state = stateAny[1]!;
      rest = `${rest.slice(0, stateAny.index)} ${rest.slice(stateAny.index + 2)}`
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  const city = normalizeLocalityToken(rest.replace(/,/g, " "));
  return { city, state, zip };
}

/**
 * Parse city/state/ZIP from a full typed address for prefix-search filtering.
 * Supports "908 Pine St, Bastrop TX 78602" and comma-less "908 Pine St Bastrop TX 78602".
 */
export function parsePlaceSearchLocality(raw: string): PlaceSearchLocality {
  const trimmed = raw.trim();
  if (!trimmed) return { city: null, state: null, zip: null };

  const commaParts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  if (commaParts.length >= 2) {
    return parseLocalityTail(commaParts.slice(1).join(", "));
  }

  const flat = trimmed.replace(/,/g, " ");
  const tokens = flat
    .toUpperCase()
    .replace(/[.]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (tokens.length < 4) return { city: null, state: null, zip: null };

  const last = tokens[tokens.length - 1]!;
  if (!ZIP_RE.test(last)) {
    // Comma-less "<street> <city>" without state/zip — e.g. "908 Pine St Bastrop".
    for (let i = tokens.length - 2; i >= 1; i--) {
      const t = tokens[i]!;
      const canonical = STREET_TYPE_ABBR[t] ?? t;
      if (STREET_TYPE_SUFFIXES.has(canonical)) {
        const cityTokens = tokens.slice(i + 1);
        if (cityTokens.length >= 1 && cityTokens.length <= 3) {
          return {
            city: normalizeLocalityToken(cityTokens.join(" ")),
            state: null,
            zip: null,
          };
        }
        break;
      }
    }
    return { city: null, state: null, zip: null };
  }
  const zip = last;
  const maybeState = tokens[tokens.length - 2]!;
  if (!STATE_RE.test(maybeState)) {
    return { city: null, state: null, zip };
  }
  const state = maybeState;

  let end = tokens.length - 2; // strip state + zip
  const withoutAnchor = tokens.slice(0, end);
  const candidateKeys = new Set(normalizeStreetLineCandidates(trimmed));
  let streetTokenCount: number | null = null;
  for (let drop = 0; drop <= 3; drop++) {
    const sliceLen = withoutAnchor.length - drop;
    if (sliceLen < 2) break;
    const key = withoutAnchor.slice(0, sliceLen).join(" ");
    if (candidateKeys.has(key) && sliceLen < withoutAnchor.length) {
      if (streetTokenCount == null || sliceLen > streetTokenCount) {
        streetTokenCount = sliceLen;
      }
    }
  }
  if (streetTokenCount == null) {
    return { city: null, state, zip };
  }
  const cityTokens = withoutAnchor.slice(streetTokenCount);
  const city = normalizeLocalityToken(cityTokens.join(" "));
  return { city, state, zip };
}

/** Extract locality from a stored situs or formatted address-point label. */
export function localityFromStoredAddress(raw: string): PlaceSearchLocality {
  const trimmed = raw.trim();
  if (!trimmed) return { city: null, state: null, zip: null };

  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 3) {
    const city = normalizeLocalityToken(parts[1]);
    const tail = parseLocalityTail(parts.slice(2).join(" "));
    return {
      city,
      state: tail.state,
      zip: tail.zip,
    };
  }
  if (parts.length === 2) {
    return parseLocalityTail(parts[1]!);
  }
  return parseLocalityTail(trimmed);
}

export function placeSearchLocalityMatches(
  stored: PlaceSearchLocality,
  query: PlaceSearchLocality,
): boolean {
  const qZip = query.zip;
  const qCity = query.city;
  const qState = query.state;

  if (!qZip && !qCity && !qState) return true;

  if (qZip) {
    if (!stored.zip || stored.zip !== qZip) return false;
  }
  if (qState) {
    if (!stored.state || stored.state !== qState) return false;
  }
  if (qCity) {
    if (!stored.city) return false;
    if (stored.city !== qCity) return false;
  }
  return true;
}

export function hasPlaceSearchLocality(query: PlaceSearchLocality): boolean {
  return Boolean(query.city || query.state || query.zip);
}

/**
 * QUERY-SIDE key derivation for the F4d/F4e situs + rooftop lookups. Given
 * a typed address, return the set of candidate normalized street-line keys
 * to match against the stored (comma-bearing) situs/full_addr — most
 * authoritative (fewest assumptions) first.
 *
 * WHY A SET. The stored situs is ALWAYS comma-delimited, so its street
 * line falls out of `split_part(col, ',', 1)` cleanly. A typed query is
 * frequently comma-LESS ("576 Sage Thrasher Cir Dripping Springs TX
 * 78620") — the common FE shape — and then the first-comma split yields
 * the WHOLE string, so `normalizeStreetLine` keeps the city/state/zip and
 * never equals the stored "576 SAGE THRASHER CIR". We fix that here,
 * QUERY-side only (the stored-side / index expression in
 * {@link buildNormalizedStreetSql} is UNCHANGED — no reindex).
 *
 * THE RULE (only fires when a trailing <STATE> <ZIP> anchor is present,
 * i.e. the input was comma-less):
 *   1. Base tokens = {@link baseStreetTokens} (the primary key's tokens).
 *   2. If the tokens end with `<2-letter state> <zip>` or a bare `<zip>`,
 *      strip that anchor, then emit the street-line candidates that drop
 *      0, 1, 2, and 3 further trailing tokens — the city is 0..3 words in
 *      the real store (0 = "<street> <state> <zip>" with no city; 233k of
 *      234k city-bearing parcels are 1-2 words, a handful are 3 like
 *      "FAIR OAKS RANCH"). Each candidate keeps >= number + one street
 *      token.
 *
 * WHY DROP-N RATHER THAN CUT-AT-SUFFIX. The store's street lines do NOT
 * reliably end in a recognizable street-type suffix (highways/FM/RR/US/IH
 * "13341 W US 290", "1531 LOOP 165", "TBD"), and some CITY names DO end in
 * a street-type word ("GARDEN RIDGE" -> RIDGE is in the abbr map). So
 * neither "keep through the last street-type suffix" nor "cut at the first
 * suffix" is safe (last breaks Garden Ridge; first breaks "LOOP 165",
 * "CIRCLE OAK DR", "CATTLE TRAIL DR"). The <state><zip> tail is the only
 * reliable anchor; from it we enumerate the 1..3-word city drop and let
 * the DB's EXACT normalized match + UNIQUE-prop-id rule pick the real
 * street line. An over- or under-stripped candidate matches nothing (or,
 * at worst, adds a distinct prop id that makes the resolver DECLINE as
 * ambiguous — never returns a wrong parcel; commitment #1).
 *
 * The returned list is de-duplicated and preserves order (primary first).
 * When there is no <state><zip> anchor (a comma-delimited address, or a
 * bare street line like "6026 Marsh Ln"), the ONLY candidate is the
 * primary key — behavior identical to `normalizeStreetLine`.
 */
export function normalizeStreetLineCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const push = (toks: string[]) => {
    if (toks.length < 2) return; // need number + >= one street token
    const key = toks.join(" ");
    if (!candidates.includes(key)) candidates.push(key);
  };

  // Primary key: the full FIRST-comma-segment street line. Unchanged
  // behavior — and the correct/only key for a comma-delimited address
  // ("576 Sage Thrasher Cir, Dripping Springs, TX 78620"), whose first
  // segment IS the bare street line. Byte-identical to the stored-side /
  // index expression, so no reindex.
  const primaryTokens = baseStreetTokens(raw);
  if (primaryTokens.length >= 2) {
    push(primaryTokens);
    // If the primary tokens themselves end in a <state> <zip> anchor, the
    // input was fully comma-LESS ("576 Sage Thrasher Cir Dripping Springs
    // TX 78620") and the anchor is intact here — enumerate the drop-N city
    // strip off it (original F4f path).
    emitAnchorStrippedCandidates(primaryTokens, push);
  }

  // F6b: the FE also sends MIS-PUNCTUATED forms where a comma lands AFTER
  // the street type or INSIDE the city, so the first-comma split above
  // discards the <state> <zip> anchor before the drop-N strip can see it:
  //   "576 Sage Thrasher Cir Dripping Springs, TX 78620"  (street-city comma)
  //   "576 Sage Thrasher Cir Dripping, Springs, TX 78620" (interior city comma)
  // Both truncate to "...CIR DRIPPING[ SPRINGS]" with NO anchor left, so the
  // stored "576 SAGE THRASHER CIR" is never generated and the situs misses.
  //
  // Fix, QUERY-side only: tokenize the WHOLE address with every comma
  // flattened to a space, so the trailing <state> <zip> anchor survives no
  // matter where the commas fell, then run the SAME anchor-strip + drop-N.
  // This only ADDS candidates; the resolver's EXACT-match set + unique-prop
  // rule means an over-/under-stripped candidate matches nothing (or, at
  // worst, makes the resolver DECLINE as ambiguous) — never a wrong parcel
  // (commitment #1). Guard the extra work behind an actually-present anchor:
  // if the flattened tail has no <state> <zip>, emitAnchorStrippedCandidates
  // is a no-op and we add nothing beyond the primary key above.
  const flatTokens = baseStreetTokens(raw.replace(/,/g, " "));
  if (flatTokens.length >= 2) {
    emitAnchorStrippedCandidates(flatTokens, push);
  }

  return candidates;
}

/**
 * If `tokens` ends in a trailing `<2-letter state> <zip>` (or a bare
 * `<zip>`, or the rare `<zip> <state>` ordering) anchor, strip it and push
 * the street-line candidates that drop 0..3 further trailing city tokens
 * (city is 0..3 words in the store: 0 = "<street> <state> <zip>" with no
 * city, up to 3 like "FAIR OAKS RANCH"). Each keeps >= number + one street
 * token. NO-OP when no such anchor is present, so bare street lines
 * ("6026 MARSH LN") and comma-delimited inputs stay untouched.
 *
 * The drop-N enumeration (rather than cut-at-street-type-suffix) is
 * deliberate: the store's street lines do not reliably end in a recognizable
 * suffix (highways/FM/US "13341 W US 290", "1531 LOOP 165") and some CITY
 * names DO end in a street-type word ("GARDEN RIDGE" -> RIDGE). The
 * <state><zip> tail is the only reliable anchor; from it we enumerate the
 * 1..3-word city drop and let the DB's EXACT normalized match + unique-prop
 * rule pick the real street line.
 */
function emitAnchorStrippedCandidates(
  tokens: string[],
  push: (toks: string[]) => void,
): void {
  let end = tokens.length;
  const last = tokens[end - 1]!;
  const secondLast = end >= 2 ? tokens[end - 2]! : undefined;
  let strippedAnchor = false;
  if (ZIP_RE.test(last)) {
    end -= 1; // drop zip
    strippedAnchor = true;
    if (secondLast && STATE_RE.test(secondLast)) {
      end -= 1; // drop state before the zip
    }
  } else if (STATE_RE.test(last) && secondLast && ZIP_RE.test(secondLast)) {
    // Rare "<zip> <state>" ordering — drop both.
    end -= 2;
    strippedAnchor = true;
  }
  if (!strippedAnchor) return;

  const withoutAnchor = tokens.slice(0, end);
  for (let drop = 0; drop <= 3; drop++) {
    if (withoutAnchor.length - drop < 2) break;
    push(withoutAnchor.slice(0, withoutAnchor.length - drop));
  }
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
