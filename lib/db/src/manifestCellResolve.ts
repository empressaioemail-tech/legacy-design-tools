/**
 * Shared manifest cell display resolution after rail-field overlay.
 */
import type { AtomFamilyState } from "./schema/countyRailDimension";
import type { ManifestDisplayState } from "./manifestDisplayState";

export type { ManifestDisplayState };

const ATOM_FAMILY_STRICTNESS: Record<string, number> = {
  missing: 0,
  partial: 1,
  unpublished: 2,
  present: 3,
};

/** Stricter atom-family signal wins — store negatives are not upgraded by derivation. */
export function mergeAtomFamilyState(
  storeValue: string,
  derivedValue: string,
): string {
  const storeRank = ATOM_FAMILY_STRICTNESS[storeValue] ?? 3;
  const derivedRank = ATOM_FAMILY_STRICTNESS[derivedValue] ?? 3;
  return storeRank <= derivedRank ? storeValue : derivedValue;
}

/** false wins — a confirmed no-writer is never upgraded to true by derivation. */
export function mergeHasWriter(storeValue: boolean, derivedValue: boolean): boolean {
  return storeValue && derivedValue;
}

export function mergeEffectiveRailFields(
  storeAtomFamilyState: string,
  storeHasWriter: boolean,
  derivedAtomFamilyState: string | undefined,
  derivedHasWriter: boolean | undefined,
): { atomFamilyState: string; hasWriter: boolean } {
  const atomFamilyState =
    derivedAtomFamilyState === undefined
      ? storeAtomFamilyState
      : mergeAtomFamilyState(storeAtomFamilyState, derivedAtomFamilyState);
  const hasWriter =
    derivedHasWriter === undefined
      ? storeHasWriter
      : mergeHasWriter(storeHasWriter, derivedHasWriter);
  return { atomFamilyState, hasWriter };
}

/**
 * Mirrors `MANIFEST_DISPLAY_STATE_SQL` (`./manifestDisplayState.ts`)
 * exactly, for the overlay path where a live-probed `effectiveByKey` value
 * differs from what's stored and the display state has to be recomputed in
 * TypeScript rather than re-queried. Composing ruling 4 (the
 * not-measured/measured-below-bar split) surfaced that this function had
 * never been taught it: it predates the split, still returned `not-yet` for
 * a null railState, and silently clobbered the SQL CASE's own
 * ruling-4-aware `not-measured` back down to `not-yet` for every cell this
 * overlay path touches. `__tests__/manifestCellResolve.test.ts` pins the
 * exact mapping so a future split cannot re-diverge the same way without
 * failing loudly.
 */
export function resolveManifestDisplayState(
  atomFamilyState: AtomFamilyState | string,
  hasWriter: boolean,
  railState: string | null,
): ManifestDisplayState {
  if (atomFamilyState !== "present") return "no-atom";
  if (!hasWriter) return "no-writer";
  if (railState === null) return "not-measured";
  if (railState === "not-yet") return "measured-below-bar";
  if (
    railState === "satisfied-present" ||
    railState === "satisfied-absent"
  ) {
    return railState;
  }
  // Unreachable given rail_state's own CHECK constraint (NULL |
  // satisfied-present | satisfied-absent | not-yet) — but mirrors the SQL
  // CASE's own `ELSE c.rail_state` passthrough rather than guessing a
  // different literal for a value that should never arrive.
  return railState as ManifestDisplayState;
}

export function resolveManifestIsPartial(
  atomFamilyState: AtomFamilyState | string,
  hasWriter: boolean,
  railState: string | null,
  honestCoveragePct: number | null,
  thresholdPct: number | null,
): boolean {
  return (
    atomFamilyState === "present" &&
    hasWriter &&
    railState === "satisfied-present" &&
    honestCoveragePct !== null &&
    thresholdPct !== null &&
    honestCoveragePct < thresholdPct
  );
}
