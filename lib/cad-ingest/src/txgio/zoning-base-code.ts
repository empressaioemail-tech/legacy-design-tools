/**
 * Base-code parser for compound published zoning values (P-259, Austin).
 *
 * THE FINDING (A-164, measured live 2026-09-15 anonymously; re-measured by
 * this lane at the fixture file's `fetchedAt`): Austin's public
 * `PLANNINGCADASTRE_zoning_large_map_scale/FeatureServer/0` publishes
 * `ZONING_ZTYPE`, which appends combining districts and overlays to the base
 * district with the SAME `-` that separates the base's own parts:
 *
 *   "SF-3-HD-NP"                    -> base SF-3   (HD and NP are overlays)
 *   "MF-4-H-CO"                     -> base MF-4
 *   "CS-1-MU-V-NCCD-ETOD-DBETOD-NP" -> base CS-1
 *
 * `ZONING_BASE`, the layer's other code field, collapses the same polygons
 * ("SF" and "MF" with no numeric suffix) and cannot be used.
 *
 * WHY A TRUNCATED GUESS IS NOT A NEAR MISS. Austin's setback table
 * (`lib/adapters/src/local/setbacks/austin-tx.json`, 37 districts) rows
 * BOTH `CS General Commercial Services` and `CS-1 Commercial-Liquor Sales`.
 * The router (`buildableEnvelope/districtMapping.ts`) matches an exact
 * normalized code before anything else, and both normalized forms exist, so
 * splitting "CS-1-MU-..." on `-` and taking the first token stamps "CS",
 * which EXACTLY matches the CS row: the parcel gets the wrong district's
 * setbacks, silently, with a `matched` kind and 0.9 confidence. Truncation
 * here does not degrade to a conservative fallback — it selects a different
 * real district.
 *
 * THE RULE. The base is the LONGEST known base district that prefixes the
 * published value at a separator boundary. "CS-1" beats "CS" because it is a
 * longer boundary-aligned prefix of the same value, and the vocabulary is
 * the layer's own city's setback table (Austin's `district_name` leading
 * tokens), so every base this parser returns normalizes to a code the
 * router exact-matches. `AUSTIN_BASE_CODES` (zoning-layers.ts) is asserted
 * equal to that table's leading-token set by a test that reads the table at
 * source, so the vocabulary cannot drift away from the row it must hit.
 *
 * WHAT IS NOT A MATCH. When no known base prefixes the value at a separator
 * boundary the result is `unrecognised` and `base` stays null — a shorter
 * token is never claimed as the district. Austin's interim districts
 * (`I-SF-2`, `I-RR`, `I-PUD`, …) and the overlay families the layer publishes
 * as bare values (TOD, NBG, ERC, TND, UNZ) are the live cases. The stamp then
 * writes the PUBLISHED VALUE verbatim, never a truncation: `I-SF-2` must never
 * resolve to `SF`, and `SF-4A` must never resolve to `SF-4` (which is not even
 * a row) by cutting the suffix off. `parcelsUnrecognised` +
 * `unrecognisedHistogram` are how that bucket is reported, so the gap is a
 * worklist rather than a silence.
 *
 * OVERLAYS ARE CARRIED, NOT DISCARDED. Combining districts and overlays are
 * returned in `overlays` verbatim, so a later ruling can use them (Austin's
 * NCCD/ETOD/DBETOD carry their own standards) without re-parsing the layer.
 * Base districts joined by `/` — measured live: "GR-MU-CO-NP/MF-6-CO-NP",
 * "CS-MU-CO-NP/MF-6-CO-NP" and "CS-MU-NP/MF-6-CO-NP", 4 polygons in
 * total — are returned in `additionalBases`, and a `/`-part carrying no known
 * base is returned verbatim in `unmatchedParts`.
 *
 * PLANNED DEVELOPMENT. `PUD`/`PDD`/`PD`/`PC` codes are not districts: A-164
 * routes them to the "your setbacks come from your PUD ordinance" message.
 * They are classified `planned-development` (base null) using the census's
 * own formula, copied not paraphrased, so the stamp and P-255's census mean
 * the same thing by the words. ORDER IS THE ONE DIVERGENCE: this parser
 * checks the base vocabulary FIRST, so a city whose table really rows a
 * `PD`/`PC`/`PUD` district resolves it as a district (the census classifies
 * on the raw code alone and would call it planned development). Austin's
 * table rows neither, so for this layer the two agree on every published
 * value — asserted over the whole live vocabulary in the fixtures test.
 */

/** How a published zoning value resolves to a base district. */
export type BaseCodeKind =
  /** A known base district prefixes the value; `base` carries it. */
  | "base"
  /** A planned-development code (A-164): the PUD message, never a district. */
  | "planned-development"
  /** No known base prefixes the value — never truncated to a guess. */
  | "unrecognised";

export interface BaseCodeParse {
  kind: BaseCodeKind;
  /** The published value, verbatim (trimmed). */
  raw: string;
  /** The base district, or null when `kind` is not `base`. */
  base: string | null;
  /** Combining/overlay tokens carried verbatim, in published order. */
  overlays: string[];
  /** Base districts joined to this one by `/` (a parcel zoned two ways). */
  additionalBases: string[];
  /** `/`-parts carrying no known base, verbatim — never dropped, never guessed. */
  unmatchedParts: string[];
  /** Why this outcome — for the stamp's audit log and the unrecognised listing. */
  reason: string;
}

/**
 * Which value the vocabulary is matched against.
 *
 * ONLY `longest-match` is ever set by a registry entry. The other two exist so
 * a test can run THIS parser with the rule removed and show the fixtures fail
 * (P-259 falsifier 4):
 *  - `first-token` models A-164's `value.split("-")[0]` — it loses the numeric
 *    suffix of every district, so `SF-3-HD-NP`, `SF-1` and `W/LO` all fail.
 *  - `shortest-match` keeps boundary awareness and inverts ONLY the preference,
 *    which is the purest test of the longest-match rule: it is the reading
 *    under which `CS-1-MU-V-NCCD-ETOD-DBETOD-NP` becomes `CS`, a real district
 *    in the same table.
 * Neither is ever a production value.
 */
export type BaseMatchMode = "longest-match" | "shortest-match" | "first-token";

export interface BaseCodeParseConfig {
  /**
   * The base-district vocabulary for this layer's city. Austin: the 37
   * `district_name` leading tokens of `austin-tx.json`, listed explicitly in
   * `zoning-layers.ts` (AUSTIN_BASE_CODES) and asserted against that table by
   * a test — an implicit read of the table here would hide a typo in it.
   */
  knownBaseCodes: readonly string[];
  /**
   * Start-anchored regex STRING for planned-development codes. Copied verbatim
   * from P-255's census (`PLANNED_DEVELOPMENT`), which is the same formula the
   * factory writer uses, so this parser and the census cannot mean different
   * things by "planned development".
   */
  plannedDevelopmentPattern?: string;
  /**
   * Regex flags for `plannedDevelopmentPattern`, kept beside it so the pair
   * can be copied from the census's literal (`…$/i`) without paraphrase.
   */
  plannedDevelopmentFlags?: string;
  /** Default `longest-match`. See {@link BaseMatchMode}. */
  matchMode?: BaseMatchMode;
}

/**
 * The separators that start a new token in a published zoning value. These
 * three are what Austin's layer uses. `.` and `&` are deliberately NOT
 * separators: they occur INSIDE district names (`R&D`, San Marcos'
 * `SF-4.5`), so treating them as boundaries could match `SF-4` inside
 * `SF-4.5` — the exact truncation this file exists to prevent.
 */
const SEPARATORS = new Set(["-", "/", " ", "\t", "\n", "\r", "\f", "\v"]);

/** Upper-case, alphanumeric-only. Mirrors `normalizeCode` in districtMapping.ts. */
export function normalizeBaseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function isBaseCodeSeparator(ch: string): boolean {
  return SEPARATORS.has(ch);
}

/**
 * Every prefix of `value` that ends at a separator boundary, LONGEST FIRST.
 * The whole value is always a candidate; `end` is the raw index so the caller
 * can slice the remainder without re-deriving it from a trimmed string.
 */
export function baseCodePrefixes(value: string): { text: string; end: number }[] {
  const out: { text: string; end: number }[] = [];
  for (let i = value.length; i > 0; i--) {
    if (i === value.length || isBaseCodeSeparator(value[i]!)) {
      const text = value.slice(0, i).trim();
      if (text.length > 0) out.push({ text, end: i });
    }
  }
  return out;
}

/** Separator-split tokens, empties dropped, raw text kept. */
function tokens(value: string): string[] {
  return value
    .split(/[-/\s]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

interface BaseMatch {
  /** The canonical vocabulary entry that matched. */
  canonical: string;
  /** Raw index in the parsed value just past the matched prefix. */
  end: number;
}

function matchBase(
  value: string,
  vocabulary: Map<string, string>,
  mode: BaseMatchMode,
): BaseMatch | null {
  const prefixes = baseCodePrefixes(value);
  if (prefixes.length === 0) return null;
  // Longest first as returned. `first-token` is the shortest boundary prefix
  // (the model of `value.split("-")[0]`); `shortest-match` is the same
  // candidate set walked in the opposite order.
  const candidates =
    mode === "first-token"
      ? [prefixes[prefixes.length - 1]!]
      : mode === "shortest-match"
        ? [...prefixes].reverse()
        : prefixes;
  for (const c of candidates) {
    const canonical = vocabulary.get(normalizeBaseCode(c.text));
    if (canonical !== undefined) return { canonical, end: c.end };
  }
  return null;
}

/**
 * Parse one published zoning value into its base district plus the suffix
 * tokens carried alongside it. Pure and total: every input yields a result,
 * and no result is a truncated guess.
 */
export function parseBaseCode(
  raw: string,
  cfg: BaseCodeParseConfig,
): BaseCodeParse {
  const value = raw.trim();
  const mode = cfg.matchMode ?? "longest-match";
  const vocabulary = new Map<string, string>();
  for (const code of cfg.knownBaseCodes) {
    const norm = normalizeBaseCode(code);
    if (norm.length > 0 && !vocabulary.has(norm)) vocabulary.set(norm, code);
  }
  if (value.length === 0) {
    return {
      kind: "unrecognised",
      raw,
      base: null,
      overlays: [],
      additionalBases: [],
      unmatchedParts: [],
      reason: "empty published value — the layer records no district for this polygon",
    };
  }

  const match = matchBase(value, vocabulary, mode);
  if (!match) {
    const pd =
      cfg.plannedDevelopmentPattern !== undefined
        ? new RegExp(cfg.plannedDevelopmentPattern, cfg.plannedDevelopmentFlags)
        : null;
    if (pd && pd.test(value)) {
      const t = tokens(value);
      return {
        kind: "planned-development",
        raw,
        base: null,
        overlays: t.slice(1),
        additionalBases: [],
        unmatchedParts: [],
        reason:
          `planned-development code ${JSON.stringify(t[0] ?? value)} — A-164 routes ` +
          "this to the PUD message (its setbacks come from its own ordinance), " +
          "so no base district is claimed",
      };
    }
    const prefixes = baseCodePrefixes(value);
    return {
      kind: "unrecognised",
      raw,
      base: null,
      overlays: tokens(value),
      additionalBases: [],
      unmatchedParts: [],
      reason:
        `no known base district prefixes ${JSON.stringify(value)} at a separator ` +
        `boundary (${prefixes.length} candidate prefix${prefixes.length === 1 ? "" : "es"} ` +
        `tried against ${vocabulary.size} known bases) — left unrecognised rather ` +
        "than truncated to a shorter token",
    };
  }

  const overlays: string[] = [];
  const additionalBases: string[] = [];
  const unmatchedParts: string[] = [];
  const remainder = value.slice(match.end);
  const parts = remainder.split("/");
  // Part 0 is the tail of the part the base already came from: everything left
  // in it is overlay/combining, by construction.
  for (const t of tokens(parts[0] ?? "")) overlays.push(t);
  for (let i = 1; i < parts.length; i++) {
    const part = (parts[i] ?? "").replace(/^[-/\s]+/, "").replace(/[-/\s]+$/, "");
    if (part.length === 0) continue;
    const inner = matchBase(part, vocabulary, mode);
    if (inner) {
      additionalBases.push(inner.canonical);
      for (const t of tokens(part.slice(inner.end))) overlays.push(t);
    } else {
      unmatchedParts.push(part);
      for (const t of tokens(part)) overlays.push(t);
    }
  }

  const suffix = [
    overlays.length > 0 ? `overlays [${overlays.join(", ")}]` : "no overlays",
    additionalBases.length > 0
      ? `also zoned [${additionalBases.join(", ")}]`
      : null,
    unmatchedParts.length > 0
      ? `unmatched /-parts [${unmatchedParts.join(", ")}]`
      : null,
  ]
    .filter((v): v is string => v !== null)
    .join(", ");

  return {
    kind: "base",
    raw,
    base: match.canonical,
    overlays,
    additionalBases,
    unmatchedParts,
    reason: `longest known base district is ${match.canonical} (${suffix})`,
  };
}
