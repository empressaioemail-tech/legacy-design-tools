/**
 * Pilot jurisdictions surfaced to architects in the Site Context tab.
 *
 * The empty-pilot banner (Task #177) explains *that* a project is out of
 * pilot, but until Task #188 it never named the jurisdictions that *are*
 * supported. Architects scoping a Boulder CO project had to dig through
 * docs to discover the dead-end was systemic and not specific to their
 * project. This module exports the pilot list so the banner can render
 * the actual supported set inline.
 *
 * The list is *derived* from {@link ALL_ADAPTERS} so it cannot drift from
 * the server's `appliesTo` gate. The server filters `ALL_ADAPTERS` on
 * `appliesTo(ctx)`; this module collects the same set of `localKey`s
 * (and `stateKey`s) from each adapter's `jurisdictionGate`. Adding a
 * new local adapter to the registry automatically extends the visible
 * pilot list — see the unit test in `__tests__/pilotJurisdictions.test.ts`
 * which fails closed if a localKey appears in the registry without a
 * matching label here.
 *
 * The friendly labels (e.g. `"Moab, UT (Grand County)"`) are the only
 * piece that has to be edited by hand when a new pilot jurisdiction
 * lands. The unit test enforces that every `localKey` in the registry
 * has a label, so a half-wired adapter cannot ship without surfacing
 * the gap to the test author.
 */

import type { AdapterLocalKey, AdapterStateKey } from "./types";
import { ALL_ADAPTERS } from "./registry";

/**
 * One row in the pilot-jurisdictions list as the FE renders it.
 *
 * `shortLabel` is the city/state the architect would recognize from
 * the brief ("Moab, UT"). `label` keeps the county qualifier in
 * parentheses so an architect who knows the county name (but not the
 * city) can still match it.
 */
export interface PilotJurisdiction {
  /** Local key from the adapter registry (e.g. `"grand-county-ut"`). */
  localKey: AdapterLocalKey;
  /** State this local key sits inside (e.g. `"utah"`). */
  stateKey: AdapterStateKey;
  /** Human-readable label, e.g. `"Moab, UT (Grand County)"`. */
  label: string;
  /** Short label, e.g. `"Moab, UT"`. */
  shortLabel: string;
}

/**
 * Hand-maintained labels keyed by `AdapterLocalKey`. The mapping is
 * exhaustive on the union (a new key in `types.ts` triggers a TS
 * error here until it is filled in), and the unit test additionally
 * asserts every key actually present in {@link ALL_ADAPTERS} has a
 * label so a registry-only addition cannot silently leave the banner
 * out of date.
 */
const LOCAL_KEY_LABELS: Record<
  AdapterLocalKey,
  { label: string; shortLabel: string; stateKey: AdapterStateKey }
> = {
  "bastrop-tx": {
    label: "Bastrop, TX",
    shortLabel: "Bastrop, TX",
    stateKey: "texas",
  },
  "grand-county-ut": {
    label: "Moab, UT (Grand County)",
    shortLabel: "Moab, UT",
    stateKey: "utah",
  },
  "lemhi-county-id": {
    label: "Salmon, ID (Lemhi County)",
    shortLabel: "Salmon, ID",
    stateKey: "idaho",
  },
};

/**
 * Stable display order — alphabetical by short label so the banner
 * reads predictably regardless of the order adapters were registered
 * in.
 */
function sortByShortLabel(a: PilotJurisdiction, b: PilotJurisdiction): number {
  return a.shortLabel.localeCompare(b.shortLabel);
}

/**
 * The union of `localKey`s present anywhere in {@link ALL_ADAPTERS}'s
 * `jurisdictionGate.local`. This is the canonical "what local
 * jurisdictions does the Generate Layers run actually support" list —
 * the same set the server's `appliesTo` gate filters to.
 */
export const PILOT_LOCAL_KEYS: ReadonlyArray<AdapterLocalKey> = Array.from(
  new Set(
    ALL_ADAPTERS.map((a) => a.jurisdictionGate.local).filter(
      (k): k is AdapterLocalKey => Boolean(k),
    ),
  ),
);

/**
 * Same derivation for state-tier coverage. Federal adapters gate on
 * `stateKey !== null`, so the set of pilot states is the union of every
 * state-bearing adapter's `jurisdictionGate.state` plus the state implied
 * by every local adapter's `jurisdictionGate.local`.
 */
export const PILOT_STATE_KEYS: ReadonlyArray<AdapterStateKey> = Array.from(
  new Set<AdapterStateKey>([
    ...ALL_ADAPTERS.map((a) => a.jurisdictionGate.state).filter(
      (k): k is AdapterStateKey => Boolean(k),
    ),
    ...PILOT_LOCAL_KEYS.map((k) => LOCAL_KEY_LABELS[k].stateKey),
  ]),
);

/**
 * The pilot-jurisdictions list the FE renders in the empty-pilot
 * banner. Each entry carries the localKey (so tests can pin to the
 * registry) plus the friendly label.
 */
export const PILOT_JURISDICTIONS: ReadonlyArray<PilotJurisdiction> =
  PILOT_LOCAL_KEYS.map((localKey) => {
    const meta = LOCAL_KEY_LABELS[localKey];
    return {
      localKey,
      stateKey: meta.stateKey,
      label: meta.label,
      shortLabel: meta.shortLabel,
    };
  })
    .slice()
    .sort(sortByShortLabel);
