/**
 * Shared manifest cell display resolution after rail-field overlay.
 */
import type { AtomFamilyState } from "./schema/countyRailDimension";

export type ManifestDisplayState =
  | "no-atom"
  | "no-writer"
  | "not-yet"
  | "satisfied-present"
  | "satisfied-absent";

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

export function resolveManifestDisplayState(
  atomFamilyState: AtomFamilyState | string,
  hasWriter: boolean,
  railState: string | null,
): ManifestDisplayState {
  if (atomFamilyState !== "present") return "no-atom";
  if (!hasWriter) return "no-writer";
  if (railState === null) return "not-yet";
  if (
    railState === "satisfied-present" ||
    railState === "satisfied-absent"
  ) {
    return railState;
  }
  return "not-yet";
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
