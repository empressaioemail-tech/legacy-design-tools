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
