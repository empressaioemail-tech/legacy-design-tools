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
 * Resolve a jurisdiction key from an engagement's geocoded city/state. Returns
 * null when no warmup is configured for the engagement's location.
 */
export function keyFromEngagement(input: {
  jurisdictionCity?: string | null;
  jurisdictionState?: string | null;
}): string | null {
  const city = (input.jurisdictionCity ?? "").trim().toLowerCase();
  const state = (input.jurisdictionState ?? "").trim().toLowerCase();
  if (!city || !state) return null;
  return CITY_STATE_TO_KEY[`${city}|${state}`] ?? null;
}

export function getJurisdiction(key: string): JurisdictionConfig | null {
  return JURISDICTIONS[key] ?? null;
}

export function listJurisdictions(): JurisdictionConfig[] {
  return Object.values(JURISDICTIONS);
}
