/**
 * Compose a saved-property / stub label from situs parts.
 * Punctuation-only strings (the live `48021:25420` `", ,"` defect) never
 * become a label. Fallback is the node id plus situs unknown.
 */

const PUNCTUATION_ONLY_RE = /^[\s,.\-;:'"`]+$/;

/**
 * P-270 ADDRESS HALF (2026-09-18): the address components a composed street line
 * must still carry.
 *
 * The shape: a payload can hold a city and a ZIP that its composed address line
 * DROPS. On the map's live payload for Pflugerville `48453:445501` that is
 * measured — the probe read `cityLimitsFact.cityName` "Pflugerville" against
 * `baseFacts.situsCity` absent-verified and a composed line of the bare street,
 * on 2026-09-18 — and the ledger's own `situsZip` 78660 is the dispatch's
 * 2026-09-18 factory `parcel_record_cell` read, not re-measured here.
 *
 * This module had the same gap in its own composer — `composeSitusLabel` returns
 * the `composed` argument the moment it is non-empty, so every `parts` entry after
 * the street line was dead code and the MCP's label was the bare street. That is a
 * CODE READ plus a unit test, not a measured MCP answer: this lane holds no OAuth
 * token for the MCP gate (`missing_bearer`), so `get_smart_site` was not driven.
 * The probe's address predicate carries an MCP arm that grades this surface as
 * soon as a token exists; until then this half is proven by test, and the close
 * says so rather than calling it measured.
 *
 * The join below is the SAME rule the map's `composeSitusLine`
 * (hauska-map `apps/property-explorer/src/lib/situs-address.ts`) applies, kept in
 * step deliberately: the two are separate repos with no shared package, and the
 * `scripts/surface-probe.mjs` address predicate (doc_repo) grades BOTH surfaces,
 * which is what makes a divergence visible rather than silent.
 *
 * A component already on the line is never appended twice, so a roll whose
 * situs already reads "…, BASTROP, TX 78602" is returned byte-identical.
 */
export type SitusLineComponents = {
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export function appendMissingSitusComponents(
  composed: string,
  components: SitusLineComponents,
): string {
  const upper = composed.toUpperCase();
  const segments = upper.split(",").map((s) => s.trim()).filter(Boolean);
  /** A city is a substring match: most rolls spell it inside the street line. */
  const hasCity = (v: string) => upper.includes(v.toUpperCase());
  /** State/ZIP are SEGMENT matches, so "1 TX AVE" is not read as a state "TX". */
  const hasState = (v: string) =>
    segments.some((s) => s === v.toUpperCase() || s.startsWith(`${v.toUpperCase()} `));
  const hasZip = (v: string) => upper.includes(v.toUpperCase());

  const out = [composed];
  const city = tokenFromPart(components.city);
  if (city && !hasCity(city)) out.push(city);

  const state = tokenFromPart(components.state);
  const zip = tokenFromPart(components.zip);

  if (zip && !hasZip(zip)) {
    // The ZIP rides with its state as ONE component; when the line already
    // carries the state it is a SPACE suffix rather than a new comma part, so the
    // ZIP never floats free ("…, TX 78660", never "…, TX, 78660").
    if (state && hasState(state)) return `${out.join(", ")} ${zip}`;
    out.push([state, zip].filter((v): v is string => v != null).join(" "));
  } else if (state && !hasState(state)) {
    out.push(state);
  }

  return out.join(", ");
}

export type SitusDisposition = "present" | "unknown";

/**
 * P-270 CITY HALF (2026-09-19) — THE LICENCE, kept beside the composer.
 *
 * THE DEFECT. The composer above was fixed by P-270's address half to append a
 * payload's city/state/ZIP to the street line, but it can only append a city the
 * payload HANDS it. The bake writes the CAD roll's own situs city as a DECLARED
 * absence when the roll has none (`{status:"absent", verdict:"absent-verified",
 * authority: <county> CAD roll}` — the live shape on `48453:445501`), and
 * `smartSiteStub` read that field with a `typeof === "string"` test, so the
 * declaration became `null` and the MCP label named no city at all while the
 * ledger held one.
 *
 * THE LICENCE (the same rule as the map's `applyCityLimitsSitusLicence`, in
 * `hauska-map` `apps/property-explorer/api/_lib/pe-property-atoms.ts`, and as the
 * probe's `addressCarriesLedgerLine` in `scripts/surface-probe.mjs`; the three
 * are NAMED, not pinned — P-331 has not merged). A city is taken from the
 * city-limits answer ONLY when BOTH hold:
 *
 *   1. the roll's own situs city is a DECLARED absence with verdict
 *      `absent-verified`. A bare null, a `lookup-failed`/`refused`, a
 *      `not-applicable`, or a rail that never served licenses NOTHING: the
 *      roll's silence is not evidence that the roll has no city, and naming the
 *      containing city there would be inventing one;
 *   2. the city-limits answer is `incorporated` AND names a city. An
 *      `unincorporated` answer positively says there is no city to name;
 *      `unmeasured` says nothing at all.
 *
 * A readable roll city is never replaced by the containing city, and a city
 * taken from city limits is a DIFFERENT claim from the roll's mailing city —
 * `basis` carries which is which so a caller can label it.
 */
export type CityLimitsDetermination =
  | { status?: unknown; cityName?: unknown }
  | null
  | undefined;

export type SitusCityResolution = {
  city: string | null;
  /** `"cad-roll"` = the roll's own city; `"city-limits"` = the containing city. Null = no city named. */
  basis: "cad-roll" | "city-limits" | null;
};

/** The roll's own situs city as the payload carries it — a string, or a declaration object, or nothing. */
export function rollSitusCityFromFacets(facets: unknown): unknown {
  if (!facets || typeof facets !== "object" || Array.isArray(facets)) return null;
  const baseFacts = (facets as Record<string, unknown>).baseFacts;
  if (!baseFacts || typeof baseFacts !== "object" || Array.isArray(baseFacts)) {
    return null;
  }
  return (baseFacts as Record<string, unknown>).situsCity;
}

/**
 * `verdict ?? status` is read in that ORDER because it is the order the probe's
 * own extractor reads it (`surface-probe.mjs`'s `situsCityAbsenceVerdict`), so
 * the licence cannot fire on a declaration the instrument would read
 * differently. A `lookup-failed` verdict beside an `absent` status therefore
 * licenses nothing — could-not-look is not found-nothing.
 */
export function rollSitusCityIsDeclaredAbsent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const word = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return (word(r.verdict) ?? word(r.status)) === "absent-verified";
}

/** The licence's own gate: an INCORPORATED answer that actually names a city. */
export function incorporatedCityLimitsCity(
  fact: CityLimitsDetermination,
): string | null {
  if (!fact || fact.status !== "incorporated") return null;
  return typeof fact.cityName === "string" && fact.cityName.trim()
    ? fact.cityName.trim()
    : null;
}

/**
 * THE ONE PLACE the label's city is decided. Returns the roll's own city when
 * the payload states one, the containing city when the roll's is a declared
 * absence and city limits name an incorporated one, and no city otherwise —
 * never a guess, never a jurisdiction city presented as the roll's.
 */
export function resolveSitusCity(args: {
  rollSitusCity: unknown;
  cityLimits?: CityLimitsDetermination;
}): SitusCityResolution {
  const rollCity =
    typeof args.rollSitusCity === "string" && args.rollSitusCity.trim()
      ? args.rollSitusCity.trim()
      : null;
  if (rollCity) return { city: rollCity, basis: "cad-roll" };
  if (!rollSitusCityIsDeclaredAbsent(args.rollSitusCity)) {
    return { city: null, basis: null };
  }
  const limitsCity = incorporatedCityLimitsCity(args.cityLimits);
  return limitsCity
    ? { city: limitsCity, basis: "city-limits" }
    : { city: null, basis: null };
}
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
  /**
   * P-270 ADDRESS HALF (2026-09-18): the components BEHIND `composed`. Without
   * them a composed street line drops a city/ZIP the payload also holds — the
   * `composed` short-circuit below returned the street alone and every `parts`
   * entry after it was dead code.
   *
   * Omitted by the callers whose `composed` IS the whole line
   * (`projectSavedPropertyLabel`, `firstPresentSitusLabel`), so their output is
   * byte-identical to before this card. Only `composeSmartSiteStub` supplies it.
   */
  components?: SitusLineComponents;
}): ComposedSitusLabel {
  const parcelNodeId = input.parcelNodeId.trim();
  const fromComposed = tokenFromPart(input.composed);
  if (fromComposed) {
    return {
      label: input.components
        ? appendMissingSitusComponents(fromComposed, input.components)
        : fromComposed,
      situs: "present",
    };
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
