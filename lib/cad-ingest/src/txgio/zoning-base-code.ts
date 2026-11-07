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
 * token is never claimed as the district. The overlay families the layer
 * publishes as bare values (TOD, NBG, ERC, TND, UNZ) and Austin's unrowed
 * `SF-4` are the live cases. The stamp then writes the PUBLISHED VALUE
 * verbatim, never a truncation: `SF-4A` must never resolve to `SF-4` (which is
 * not even a row) by cutting the suffix off, and an unresolved value must never
 * resolve to a token inside it. `parcelsUnrecognised` +
 * `unrecognisedHistogram` are how that bucket is reported, so the gap is a
 * worklist rather than a silence.
 *
 * INTERIM DISTRICTS (P-259b, operator ruling 2026-09-17). Austin publishes an
 * INTERIM family with a leading `I-` qualifier — 14 live values, 1,229 polygons
 * (`I-SF-2` 662, `I-RR` 321, `I-SF-4A` 220, `I-LA` 12, `I-SF-3` 3, `I-GR` 2,
 * `I-MF-3` 2, `I-AV` 1, `I-MF-2` 1, `I-PUD` 1, `I-RR-NP` 1, `I-SF-1` 1,
 * `I-SF-2-NP` 1, `I-SF-6` 1). An interim designation is granted on annexation
 * until permanent zoning is established, and the ordinance gives `I-SF-2` the
 * SF-2 standards (City of Austin C2O-2009-017; the city's 2016
 * development-standards table gives I-SF-2 front 25 / side 5 / rear 10, the
 * shipped `austin-tx.json` SF-2 row exactly). Leaving the family unrecognised
 * turns parcels the previous reading SERVED into district-misses — a false
 * absence, the defect class this program hunts.
 *
 * THE INTERIM RULE. A config MAY declare `interimQualifiers` (Austin:
 * `['I']`). When the value resolves to nothing directly, a declared qualifier
 * heading it at a separator boundary is STRIPPED and the SAME rule runs on the
 * remainder — longest known base first, then planned development, then
 * unrecognised:
 *
 *   "I-SF-2-NP" -> base SF-2   overlays ["NP"]   interim true
 *   "I-RR-NP"   -> base RR     overlays ["NP"]   interim true
 *   "I-PUD"     -> planned development           interim true
 *   "I-SF-4A"   -> base SF-4A  overlays []       interim true
 *
 * A qualifier followed by nothing (`I`, `I-`) or by a remainder that matches no
 * base (`I-XYZ`) stays `unrecognised` with a reason naming the qualifier — the
 * rule never invents a district and never truncates. `interim: true` is set
 * whenever a declared qualifier was recognised, so an unresolved interim value
 * is still disclosed as interim rather than silently folded into the generic
 * unrecognised set.
 *
 * ORDER. The direct resolution is attempted on the WHOLE value first: a city
 * that really rows a district whose code begins with a declared qualifier wins
 * over the strip. With `interimQualifiers` absent or empty this parser behaves
 * exactly as it did before the rule existed, field for field.
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
  /**
   * True when a DECLARED interim qualifier was recognised on this value (P-259b).
   * The published value is `I-<base>`: interim zoning granted on annexation until
   * permanent zoning is established, and the ordinance reads it as its base. Set
   * on every outcome once a given qualifier is recognised — a resolved interim
   * district (`kind: "base"`), an interim planned-development value (`I-PUD`),
   * and an interim value that resolves to nothing (`I-XYZ`, still `unrecognised`)
   * — so "was this value interim" is answerable without re-parsing. `false` for
   * every value with no declared qualifier, and for every layer that configures
   * none.
   */
  interim: boolean;
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
  /**
   * OPTIONAL. Leading qualifier tokens that mark an INTERIM district (P-259b,
   * operator ruling 2026-09-17). Austin's layer publishes its interim family as
   * `I-<base>` (`I-SF-2`, `I-RR-NP`, `I-PUD`, …), where the interim designation
   * carries the base district's standards by ordinance, so the value reads as
   * its base with the interim fact disclosed ({@link BaseCodeParse.interim}).
   *
   * Matched as the value's leading token, case-insensitively and normalized the
   * same way the vocabulary is, and ONLY when it ends at a separator boundary
   * (`-`, `/` or whitespace) or ends the value. The remainder is then resolved
   * by the same longest-match rule. Absent/empty for every layer that publishes
   * no interim family — and absent means this parser behaves exactly as it did
   * before the rule existed.
   */
  interimQualifiers?: readonly string[];
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
 * The leading declared interim qualifier of `value`, if one heads it, with the
 * remainder after it (P-259b).
 *
 * The qualifier is the value's leading token — everything up to the first
 * separator (or the whole value) — compared normalized and case-insensitively
 * against `qualifiers`. It must END at a separator boundary or at the end of
 * the value: `W/LO` is not an interim `W`, and `R&D` is not an interim `R`.
 *
 * Returns `{ qualifier, rest }` where `rest` has the separators between the
 * qualifier and the district stripped; `rest` is `""` when the qualifier is
 * followed by nothing (the caller reports that as unrecognised, never as a
 * district). Returns null when no declared qualifier heads the value.
 */
export function splitInterimQualifier(
  value: string,
  qualifiers: readonly string[] | undefined,
): { qualifier: string; rest: string } | null {
  if (!qualifiers || qualifiers.length === 0) return null;
  const declared = new Set<string>();
  for (const q of qualifiers) {
    const norm = normalizeBaseCode(q);
    if (norm.length > 0) declared.add(norm);
  }
  if (declared.size === 0) return null;

  let end = 0;
  while (end < value.length && !isBaseCodeSeparator(value[end]!)) end += 1;
  if (end === 0) return null;
  const head = value.slice(0, end).trim();
  if (!declared.has(normalizeBaseCode(head))) return null;

  let start = end;
  while (start < value.length && isBaseCodeSeparator(value[start]!)) start += 1;
  return { qualifier: head, rest: value.slice(start).trim() };
}

/** A resolution of one value, before the published `raw` and `interim` are attached. */
type Resolution = Omit<BaseCodeParse, "raw" | "interim">;

/**
 * Resolve one value against the vocabulary, the planned-development pattern and
 * the longest-match rule. `value` is already trimmed and non-empty.
 */
function resolveValue(
  value: string,
  vocabulary: Map<string, string>,
  mode: BaseMatchMode,
  plannedDevelopment: RegExp | null,
): Resolution {
  const match = matchBase(value, vocabulary, mode);
  if (!match) {
    if (plannedDevelopment && plannedDevelopment.test(value)) {
      const t = tokens(value);
      return {
        kind: "planned-development",
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
    base: match.canonical,
    overlays,
    additionalBases,
    unmatchedParts,
    reason: `longest known base district is ${match.canonical} (${suffix})`,
  };
}

/**
 * Parse one published zoning value into its base district plus the suffix
 * tokens carried alongside it. Pure and total: every input yields a result,
 * no result is a truncated guess, and a declared interim qualifier is disclosed
 * rather than silently stripped.
 *
 * ORDER. The whole value is resolved directly first; only when that yields
 * `unrecognised` is a declared leading interim qualifier stripped and the same
 * rule run on the remainder (see the file header). With `interimQualifiers`
 * absent this is exactly the pre-P-259b parser.
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
      interim: false,
      reason: "empty published value — the layer records no district for this polygon",
    };
  }

  const plannedDevelopment =
    cfg.plannedDevelopmentPattern !== undefined
      ? new RegExp(cfg.plannedDevelopmentPattern, cfg.plannedDevelopmentFlags)
      : null;

  const direct = resolveValue(value, vocabulary, mode, plannedDevelopment);
  if (direct.kind !== "unrecognised") {
    return { raw, interim: false, ...direct };
  }

  const split = splitInterimQualifier(value, cfg.interimQualifiers);
  if (!split) {
    return { raw, interim: false, ...direct };
  }

  if (split.rest.length === 0) {
    return {
      kind: "unrecognised",
      raw,
      base: null,
      overlays: [],
      additionalBases: [],
      unmatchedParts: [],
      interim: true,
      reason:
        `declared interim qualifier ${JSON.stringify(split.qualifier)} in ` +
        `${JSON.stringify(value)} is followed by no district — there is nothing to ` +
        "read as a base, so the value is left unrecognised rather than reduced to " +
        "the qualifier alone",
    };
  }

  const inner = resolveValue(split.rest, vocabulary, mode, plannedDevelopment);
  const provenance =
    `${inner.reason} — read from the published value ${JSON.stringify(value)} ` +
    `with the declared interim qualifier ${JSON.stringify(split.qualifier)} ` +
    "stripped and the interim fact disclosed";
  return {
    ...inner,
    raw,
    interim: true,
    reason: inner.kind === "unrecognised" ? provenance : `interim: ${provenance}`,
  };
}
