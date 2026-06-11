import {
  BLOCKED_CITY_STATE_KEYS,
  CENTRAL_TEXAS_CITY_STATE_TO_KEY,
} from "./centralTexasPilot";

/**
 * Jurisdiction registry — what code books we can warm up, per jurisdiction.
 *
 * A "jurisdiction key" is a stable lowercase slug (e.g. `grand_county_ut`,
 * `bastrop_tx`) that we persist on every atom. The key is derived from the
 * engagement's geocode result (jurisdictionCity + jurisdictionState) via
 * `keyFromEngagement()` below.
 *
 * Adding a new jurisdiction:
 *   1. Add a JurisdictionConfig to JURISDICTIONS.
 *   2. Add a city/state mapping to CITY_STATE_TO_KEY.
 *   3. Ensure each book.sourceName matches a row in code_atom_sources.
 */

export interface CodeBookConfig {
  /** Human label, e.g. "2021 IRC R301.2(1) values". */
  label: string;
  /** Stable book identifier persisted on the atom (`code_book` column). */
  codeBook: string;
  /** e.g. "IRC 2021", "IWUIC 2006", "Supplement 19". */
  edition: string;
  /** Must match a code_atom_sources.source_name row. */
  sourceName: string;
  /** Adapter-specific knobs forwarded into source.listToc({ config }). */
  config?: Record<string, unknown>;
}

export interface JurisdictionConfig {
  /** Stable slug stored on every atom. */
  key: string;
  /** Display name used by the Code Library UI. */
  displayName: string;
  /** Books we attempt to warm up for any engagement in this jurisdiction. */
  books: CodeBookConfig[];
}

export const JURISDICTIONS: Record<string, JurisdictionConfig> = {
  grand_county_ut: {
    key: "grand_county_ut",
    displayName: "Grand County, UT (Moab)",
    books: [
      {
        label: "2021 IRC Table 301.2(1) — Climatic & Geographic Design Criteria",
        codeBook: "IRC_R301_2_1",
        edition: "IRC 2021",
        sourceName: "grand_county_html",
      },
      {
        label: "2006 International Wildland-Urban Interface Code",
        codeBook: "IWUIC",
        edition: "IWUIC 2006",
        sourceName: "grand_county_pdf",
      },
      {
        label: "Grand County Land Use Code (rev. 3/21)",
        codeBook: "LAND_USE",
        edition: "Land Use Code (rev. 3/21)",
        sourceName: "grand_county_landuse_html",
      },
    ],
  },
  bastrop_tx: {
    key: "bastrop_tx",
    displayName: "Bastrop, TX",
    books: [
      {
        label: "City of Bastrop — Code of Ordinances",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        sourceName: "bastrop_municode",
        config: {
          municodeClientId: 1169,
          municipalityName: "Bastrop",
          stateAbbr: "TX",
          librarySlug: "bastrop",
          maxTocNodes: 30,
        },
      },
    ],
  },
  cedar_hill_tx: {
    key: "cedar_hill_tx",
    displayName: "Cedar Hill, TX",
    books: [
      {
        label: "City of Cedar Hill — Code of Ordinances",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current)",
        sourceName: "cedar_hill_municode",
        config: {
          municodeClientId: 1568,
          municodeProductId: 11825,
          municipalityName: "Cedar Hill",
          stateAbbr: "TX",
          librarySlug: "cedar_hill",
          maxTocNodes: 40,
        },
      },
    ],
  },
  miami_beach_fl: {
    key: "miami_beach_fl",
    displayName: "Miami Beach, FL",
    books: [
      {
        label: "City of Miami Beach — Code of Ordinances",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        sourceName: "miami_beach_municode",
        config: {
          municodeClientId: 3289,
          municipalityName: "Miami Beach",
          stateAbbr: "FL",
          librarySlug: "miami_beach",
          maxTocNodes: 25,
          targetChapterPatterns: [
            "existing building",
            "building",
            "mechanical",
            "electrical",
            "plumbing",
            "fire",
            "administration",
            "permit",
            "valuation",
          ],
        },
      },
    ],
  },
  miami_dade_fl: {
    key: "miami_dade_fl",
    displayName: "Miami-Dade County, FL",
    books: [
      {
        label: "Miami-Dade County — Code of Ordinances",
        codeBook: "MUNI_CODE",
        edition: "Code of Ordinances (current supplement)",
        sourceName: "miami_dade_municode",
        config: {
          municodeClientId: 11719,
          municipalityName: "Miami-Dade County",
          stateAbbr: "FL",
          librarySlug: "miami_dade",
          productNameIncludes: "code of ordinances",
          maxTocNodes: 30,
          targetChapterPatterns: [
            "chapter 8",
            "hvac",
            "mechanical",
            "building",
            "product approval",
            "bora",
            "wind",
            "demolition",
            "combination",
            "unit",
          ],
        },
      },
    ],
  },
};

/**
 * Mapping from `${city}|${state}` (lowercased) to jurisdiction key. Both
 * city-only and county-only spellings are accepted because geocoders return
 * different shapes for different addresses.
 */
const CITY_STATE_TO_KEY: Record<string, string> = {
  // Grand County, UT — geocoder may report "Moab" (city) or "Grand County".
  "moab|ut": "grand_county_ut",
  "moab|utah": "grand_county_ut",
  "grand county|ut": "grand_county_ut",
  "grand county|utah": "grand_county_ut",
  // Bastrop, TX
  "bastrop|tx": "bastrop_tx",
  "bastrop|texas": "bastrop_tx",
  // Cedar Hill, TX — QA-58 / QA-60 (city municipal code; 706 atoms shipped)
  "cedar hill|tx": "cedar_hill_tx",
  "cedar hill|texas": "cedar_hill_tx",
  // Miami Beach, FL — 5225 Collins Ave / 404 Remodel_B
  "miami beach|fl": "miami_beach_fl",
  "miami beach|florida": "miami_beach_fl",
  // Miami-Dade County, FL — county overlay (HVAC Ch.8, NOA/BORA, unit-combination)
  "miami-dade county|fl": "miami_dade_fl",
  "miami-dade county|florida": "miami_dade_fl",
  "miami dade county|fl": "miami_dade_fl",
  "miami dade county|florida": "miami_dade_fl",
  // Blocked — do not map: dallas|tx (AmLegal partnership), dallas county|tx (no Municode product)
};

/**
 * Resolve a jurisdiction key from an engagement. Tries, in order:
 *   1. Structured `jurisdictionCity` + `jurisdictionState` (from geocoder).
 *   2. Freeform `jurisdiction` string (e.g. "Moab, UT"), parsed loosely.
 *   3. `address` field, scanned for any registered "city, state" pair.
 *
 * The fallback chain matters because legacy engagements created before the
 * geocoder split city/state into structured columns still carry the location
 * in the freeform `jurisdiction` and `address` strings. Without these
 * fallbacks, retrieval silently returns zero atoms and the chat answers from
 * model knowledge instead of our ingested code corpus.
 *
 * Returns null only when city/state cannot be resolved (including blocked
 * partnership keys). Unwarmed cities synthesize a `city_state` slug so
 * retrieval + web-first grounding can run on demand.
 */
export function keyFromEngagement(input: {
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
  jurisdiction?: string | null;
  address?: string | null;
}): string | null {
  // 1) Structured city+state (preferred — set by the geocoder).
  const city = (input.jurisdictionCity ?? "").trim().toLowerCase();
  const state = (input.jurisdictionState ?? "").trim().toLowerCase();
  if (city && state) {
    const resolved = resolveRegisteredOrSynthesizedKey(
      `${city}|${state}`,
      input.jurisdictionCity ?? city,
      state,
    );
    if (resolved) return resolved;
  }

  // 2) Freeform "City, ST" jurisdiction string.
  const fromJurisdiction = parseCityState(input.jurisdiction);
  if (fromJurisdiction) {
    const [parsedCity, parsedState] = fromJurisdiction.split("|");
    const resolved = resolveRegisteredOrSynthesizedKey(
      fromJurisdiction,
      parsedCity,
      parsedState,
    );
    if (resolved) return resolved;
  }

  // 3) Scan the address for any registered city/state pair. We test each
  //    known key by substring match — cheap because the registry is tiny.
  const addr = (input.address ?? "").toLowerCase();
  if (addr) {
    const merged = {
      ...CENTRAL_TEXAS_CITY_STATE_TO_KEY,
      ...CITY_STATE_TO_KEY,
    };
    for (const [pair, key] of Object.entries(merged)) {
      const [c, s] = pair.split("|");
      // Require both city and state to appear, to avoid e.g. "Moab" matching
      // "Moab, OK". Use a comma-aware test for the typical "City, ST" form.
      if (
        addr.includes(`${c}, ${s}`) ||
        (addr.includes(c) && addr.includes(`, ${s}`))
      ) {
        return key;
      }
    }

    const fromAddress = parseCityStateFromAddress(input.address ?? "");
    if (fromAddress) {
      const pair = `${fromAddress.city.toLowerCase()}|${fromAddress.state.toLowerCase()}`;
      const resolved = resolveRegisteredOrSynthesizedKey(
        pair,
        fromAddress.city,
        fromAddress.state,
      );
      if (resolved) return resolved;
    }
  }

  return null;
}

const US_STATE_SLUG: Record<string, string> = {
  al: "al",
  alabama: "al",
  ak: "ak",
  alaska: "ak",
  az: "az",
  arizona: "az",
  ar: "ar",
  arkansas: "ar",
  ca: "ca",
  california: "ca",
  co: "co",
  colorado: "co",
  ct: "ct",
  connecticut: "ct",
  de: "de",
  delaware: "de",
  fl: "fl",
  florida: "fl",
  ga: "ga",
  georgia: "ga",
  hi: "hi",
  hawaii: "hi",
  id: "id",
  idaho: "id",
  il: "il",
  illinois: "il",
  in: "in",
  indiana: "in",
  ia: "ia",
  iowa: "ia",
  ks: "ks",
  kansas: "ks",
  ky: "ky",
  kentucky: "ky",
  la: "la",
  louisiana: "la",
  me: "me",
  maine: "me",
  md: "md",
  maryland: "md",
  ma: "ma",
  massachusetts: "ma",
  mi: "mi",
  michigan: "mi",
  mn: "mn",
  minnesota: "mn",
  ms: "ms",
  mississippi: "ms",
  mo: "mo",
  missouri: "mo",
  mt: "mt",
  montana: "mt",
  ne: "ne",
  nebraska: "ne",
  nv: "nv",
  nevada: "nv",
  nh: "nh",
  "new hampshire": "nh",
  nj: "nj",
  "new jersey": "nj",
  nm: "nm",
  "new mexico": "nm",
  ny: "ny",
  "new york": "ny",
  nc: "nc",
  "north carolina": "nc",
  nd: "nd",
  "north dakota": "nd",
  oh: "oh",
  ohio: "oh",
  ok: "ok",
  oklahoma: "ok",
  or: "or",
  oregon: "or",
  pa: "pa",
  pennsylvania: "pa",
  ri: "ri",
  "rhode island": "ri",
  sc: "sc",
  "south carolina": "sc",
  sd: "sd",
  "south dakota": "sd",
  tn: "tn",
  tennessee: "tn",
  tx: "tx",
  texas: "tx",
  ut: "ut",
  utah: "ut",
  vt: "vt",
  vermont: "vt",
  va: "va",
  virginia: "va",
  wa: "wa",
  washington: "wa",
  wv: "wv",
  "west virginia": "wv",
  wi: "wi",
  wisconsin: "wi",
  wy: "wy",
  wyoming: "wy",
};

function normalizeStateSlug(state: string): string | null {
  const raw = state.trim().toLowerCase();
  if (!raw) return null;
  return US_STATE_SLUG[raw] ?? null;
}

function slugifyCityName(city: string): string {
  return city
    .trim()
    .toLowerCase()
    .replace(/['.]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Synthesize a jurisdiction slug for an unwarmed US city (`san_marcos_tx`).
 * Returns null for blocked partnership keys or unparseable city/state.
 */
export function synthesizeJurisdictionKey(
  city: string,
  state: string,
): string | null {
  const cityNorm = city.trim().toLowerCase();
  const stateSlug = normalizeStateSlug(state);
  if (!cityNorm || !stateSlug) return null;
  const pair = `${cityNorm}|${stateSlug}`;
  if (BLOCKED_CITY_STATE_KEYS[pair as keyof typeof BLOCKED_CITY_STATE_KEYS]) {
    return null;
  }
  const citySlug = slugifyCityName(city);
  if (!citySlug) return null;
  return `${citySlug}_${stateSlug}`;
}

function resolveRegisteredOrSynthesizedKey(
  pair: string,
  city: string,
  stateToken: string,
): string | null {
  if (BLOCKED_CITY_STATE_KEYS[pair as keyof typeof BLOCKED_CITY_STATE_KEYS]) {
    return null;
  }
  const registered =
    CITY_STATE_TO_KEY[pair] ?? CENTRAL_TEXAS_CITY_STATE_TO_KEY[pair];
  if (registered) return registered;
  return synthesizeJurisdictionKey(city, stateToken);
}

/** Parse trailing "City, ST [zip]" from a US mailing address. */
function parseCityStateFromAddress(
  address: string,
): { city: string; state: string } | null {
  const m = address
    .trim()
    .match(/,\s*([^,]+?),\s*([A-Za-z]{2})(?:\s+(?:\d{5}(?:-\d{4})?))?\s*$/);
  if (!m) return null;
  const city = m[1]!.trim();
  const state = m[2]!.trim();
  if (!city || !state) return null;
  if (!normalizeStateSlug(state)) return null;
  return { city, state };
}

/**
 * Parse a freeform jurisdiction string of the form "City, ST" or "City, State"
 * into the lowercased "city|state" key used by CITY_STATE_TO_KEY. Returns null
 * if the string can't be split cleanly.
 */
function parseCityState(s: string | null | undefined): string | null {
  const raw = (s ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(",").map((p) => p.trim().toLowerCase());
  if (parts.length < 2) return null;
  const c = parts[0];
  // Drop trailing tokens after the state (e.g. "Moab, UT 84532") — keep first
  // token of the second segment.
  const s2 = parts[1].split(/\s+/)[0];
  if (!c || !s2) return null;
  return `${c}|${s2}`;
}

export function getJurisdiction(key: string): JurisdictionConfig | null {
  return JURISDICTIONS[key] ?? null;
}

export function listJurisdictions(): JurisdictionConfig[] {
  return Object.values(JURISDICTIONS);
}
