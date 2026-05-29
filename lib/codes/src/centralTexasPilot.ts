/**
 * Central Texas pilot — geocode aliases and coverage manifest inputs.
 *
 * Jurisdiction keys sourced from hauska-engine corpus snapshot
 * (`services/retrieval-api/corpus/snapshot.json`, 2026-05-26).
 * Neon warmup in LDT may lag; {@link getPilotCoverageTier} distinguishes
 * `neon` (JURISDICTIONS + code_atoms) vs `engine_only`.
 */

import { JURISDICTIONS } from "./jurisdictions";

/** Keys present in engine substrate corpus snapshot (Central TX + pilot UT). */
export const ENGINE_CORPUS_JURISDICTION_KEYS = [
  "austin_tx",
  "bastrop_county_tx",
  "bastrop_tx",
  "boerne_tx",
  "brownsville_tx",
  "cedar_hill_tx",
  "converse_tx",
  "copperas_cove_tx",
  "crowley_tx",
  "dripping_springs_tx",
  "el_paso_tx",
  "elgin_tx",
  "georgetown_tx",
  "grand_county_ut",
  "hutto_tx",
  "keller_tx",
  "killeen_tx",
  "lago_vista_tx",
  "leander_tx",
  "live_oak_tx",
  "lockhart_tx",
  "manor_tx",
  "mission_tx",
  "new_braunfels_tx",
  "pasadena_tx",
  "plano_tx",
  "rollingwood_tx",
  "round_rock_tx",
  "saginaw_tx",
  "san_antonio_tx",
  "schertz_tx",
  "sugar_land_tx",
  "taylor_tx",
  "watauga_tx",
  "wimberley_tx",
] as const;

export type EngineCorpusJurisdictionKey =
  (typeof ENGINE_CORPUS_JURISDICTION_KEYS)[number];

/** Geocoder pairs that must NOT map (AmLegal / partnership). */
export const BLOCKED_CITY_STATE_KEYS: Record<string, "blocked_partnership"> = {
  "dallas|tx": "blocked_partnership",
  "dallas|texas": "blocked_partnership",
  "dallas county|tx": "blocked_partnership",
  "dallas county|texas": "blocked_partnership",
};

function displayNameFromKey(key: string): string {
  const base = key.replace(/_tx$/, "").replace(/_ut$/, "").replace(/_/g, " ");
  const suffix = key.endsWith("_ut") ? ", UT" : ", TX";
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) + suffix;
}

function cityStateAliasesForKey(key: string): string[] {
  const pairs: string[] = [];
  const state = key.endsWith("_ut") ? "ut" : "tx";
  const stateLong = key.endsWith("_ut") ? "utah" : "texas";
  const city = key
    .replace(/_tx$/, "")
    .replace(/_ut$/, "")
    .replace(/_/g, " ");
  pairs.push(`${city}|${state}`, `${city}|${stateLong}`);
  if (key === "bastrop_county_tx") {
    pairs.push("bastrop county|tx", "bastrop county|texas");
  }
  if (key === "grand_county_ut") {
    pairs.push("moab|ut", "moab|utah", "grand county|ut", "grand county|utah");
  }
  if (key === "san_antonio_tx") {
    pairs.push("san antonio|tx", "san antonio|texas");
  }
  if (key === "new_braunfels_tx") {
    pairs.push("new braunfels|tx", "new braunfels|texas");
  }
  if (key === "copperas_cove_tx") {
    pairs.push("copperas cove|tx", "copperas cove|texas");
  }
  if (key === "dripping_springs_tx") {
    pairs.push("dripping springs|tx", "dripping springs|texas");
  }
  if (key === "lago_vista_tx") {
    pairs.push("lago vista|tx", "lago vista|texas");
  }
  if (key === "live_oak_tx") {
    pairs.push("live oak|tx", "live oak|texas");
  }
  if (key === "el_paso_tx") {
    pairs.push("el paso|tx", "el paso|texas");
  }
  if (key === "sugar_land_tx") {
    pairs.push("sugar land|tx", "sugar land|texas");
  }
  if (key === "round_rock_tx") {
    pairs.push("round rock|tx", "round rock|texas");
  }
  if (key === "plano_tx") {
    pairs.push("plano|tx", "plano|texas");
  }
  if (key === "cedar_hill_tx") {
    pairs.push("cedar hill|tx", "cedar hill|texas");
  }
  return pairs;
}

/** `${city}|${state}` → jurisdiction_key for Central TX pilot geocoding. */
export const CENTRAL_TEXAS_CITY_STATE_TO_KEY: Record<string, string> =
  (() => {
    const map: Record<string, string> = {};
    for (const key of ENGINE_CORPUS_JURISDICTION_KEYS) {
      for (const pair of cityStateAliasesForKey(key)) {
        if (!BLOCKED_CITY_STATE_KEYS[pair]) {
          map[pair] = key;
        }
      }
    }
    return map;
  })();

export type PilotCoverageTier =
  | "neon"
  | "engine_only"
  | "blocked_partnership";

export function getPilotCoverageTier(key: string): PilotCoverageTier {
  if (BLOCKED_CITY_STATE_KEYS[key as keyof typeof BLOCKED_CITY_STATE_KEYS]) {
    return "blocked_partnership";
  }
  if (JURISDICTIONS[key]) return "neon";
  if ((ENGINE_CORPUS_JURISDICTION_KEYS as readonly string[]).includes(key)) {
    return "engine_only";
  }
  return "engine_only";
}

export function resolveCentralTexasJurisdictionKey(
  cityStatePair: string,
): string | null {
  if (BLOCKED_CITY_STATE_KEYS[cityStatePair]) return null;
  return CENTRAL_TEXAS_CITY_STATE_TO_KEY[cityStatePair] ?? null;
}

export function listPilotJurisdictionManifest(): Array<{
  key: string;
  displayName: string;
  tier: PilotCoverageTier;
}> {
  const keys = new Set<string>([
    ...ENGINE_CORPUS_JURISDICTION_KEYS,
    ...Object.keys(JURISDICTIONS),
  ]);
  return [...keys]
    .sort()
    .map((key) => ({
      key,
      displayName: JURISDICTIONS[key]?.displayName ?? displayNameFromKey(key),
      tier: getPilotCoverageTier(key),
    }));
}
