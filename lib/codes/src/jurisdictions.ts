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
 * Returns null when no warmup is configured for the engagement's location.
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
    const k = CITY_STATE_TO_KEY[`${city}|${state}`];
    if (k) return k;
  }

  // 2) Freeform "City, ST" jurisdiction string.
  const fromJurisdiction = parseCityState(input.jurisdiction);
  if (fromJurisdiction) {
    const k = CITY_STATE_TO_KEY[fromJurisdiction];
    if (k) return k;
  }

  // 3) Scan the address for any registered city/state pair. We test each
  //    known key by substring match — cheap because the registry is tiny.
  const addr = (input.address ?? "").toLowerCase();
  if (addr) {
    for (const [pair, key] of Object.entries(CITY_STATE_TO_KEY)) {
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
  }

  return null;
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
