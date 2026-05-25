/** Two-letter US state code, uppercased. */
export type StateCode = string;

const STATE_NAME_TO_CODE: Record<string, StateCode> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};

export function normalizeStateCode(
  state: string | null | undefined,
): StateCode | null {
  const raw = (state ?? "").trim();
  if (!raw) return null;
  if (raw.length === 2) return raw.toUpperCase();
  return STATE_NAME_TO_CODE[raw.toLowerCase()] ?? null;
}

export interface JurisdictionLike {
  key: string;
  displayName: string;
}

export function jurisdictionMatchesState(
  jurisdiction: JurisdictionLike,
  state: StateCode,
): boolean {
  const st = state.toUpperCase();
  const key = jurisdiction.key.toLowerCase();
  const stLower = st.toLowerCase();
  if (
    key.endsWith(`_${stLower}`) ||
    key.endsWith(`-${stLower}`) ||
    key.endsWith(stLower)
  ) {
    return true;
  }
  const name = jurisdiction.displayName;
  if (new RegExp(`\\b${st}\\b`).test(name)) return true;
  if (name.toLowerCase().includes(`, ${stLower}`)) return true;
  return false;
}

/** Union of geocoded states from engagement list summaries. */
export function collectFirmStateCodes(
  engagements: ReadonlyArray<{
    site?: { geocode?: { jurisdictionState?: string | null } | null } | null;
  }>,
): Set<StateCode> {
  const out = new Set<StateCode>();
  for (const e of engagements) {
    const st = normalizeStateCode(e.site?.geocode?.jurisdictionState);
    if (st) out.add(st);
  }
  return out;
}

export function filterJurisdictionsByStates<T extends JurisdictionLike>(
  jurisdictions: ReadonlyArray<T>,
  states: ReadonlySet<StateCode>,
): T[] {
  if (states.size === 0) return [];
  return jurisdictions.filter((j) =>
    [...states].some((st) => jurisdictionMatchesState(j, st)),
  );
}

export function filterJurisdictionsBySearch<T extends JurisdictionLike>(
  jurisdictions: ReadonlyArray<T>,
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...jurisdictions];
  return jurisdictions.filter(
    (j) =>
      j.key.toLowerCase().includes(q) ||
      j.displayName.toLowerCase().includes(q),
  );
}

export function filterJurisdictionsByKeys<T extends JurisdictionLike>(
  jurisdictions: ReadonlyArray<T>,
  keys: ReadonlySet<string>,
): T[] {
  if (keys.size === 0) return [];
  const normalized = new Set([...keys].map((k) => k.toLowerCase()));
  return jurisdictions.filter((j) => normalized.has(j.key.toLowerCase()));
}

export function parseStateListParam(raw: string | undefined): Set<StateCode> {
  if (!raw?.trim()) return new Set();
  const out = new Set<StateCode>();
  for (const part of raw.split(",")) {
    const st = normalizeStateCode(part.trim());
    if (st) out.add(st);
  }
  return out;
}

export function parseKeysParam(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Normalize substrate/cortex key variants (`bastrop-tx` vs `bastrop_tx`). */
export function normalizeJurisdictionKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_");
}

export function jurisdictionKeysEquivalent(a: string, b: string): boolean {
  return normalizeJurisdictionKey(a) === normalizeJurisdictionKey(b);
}

export function matchSubstrateJurisdiction(
  list: ReadonlyArray<JurisdictionLike>,
  input: {
    jurisdictionCity?: string | null;
    jurisdictionState?: string | null;
    jurisdictionFips?: string | null;
  },
): string | null {
  const state = normalizeStateCode(input.jurisdictionState);
  if (!state) return null;
  const city = (input.jurisdictionCity ?? "").trim().toLowerCase();
  const candidates = filterJurisdictionsByStates(list, new Set([state]));
  if (candidates.length === 0) return null;
  if (city) {
    const byCity = candidates.find((j) => {
      const name = j.displayName.toLowerCase();
      return name.includes(city) || j.key.toLowerCase().includes(city.replace(/\s+/g, "_"));
    });
    if (byCity) return byCity.key;
  }
  return candidates[0]?.key ?? null;
}
