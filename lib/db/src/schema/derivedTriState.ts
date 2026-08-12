/**
 * Tri-state derivation for manifest rail signals.
 * Distinguishes confirmed true/false from "could not determine" (indeterminate).
 */
export type DerivedTriState = true | false | "indeterminate";

export function isDerivedIndeterminate(v: DerivedTriState): v is "indeterminate" {
  return v === "indeterminate";
}

/** Map to county_rail.has_writer — only true when derivation is confidently true. */
export function hasWriterBooleanForStorage(v: DerivedTriState): boolean {
  return v === true;
}

export function isAnyDerivationIndeterminate(
  ...states: DerivedTriState[]
): boolean {
  return states.some((s) => s === "indeterminate");
}

/** Alias used by railManifestDerivation and reconciliation gate callers. */
export const isIndeterminate = isDerivedIndeterminate;

export function isConfirmedTrue(v: DerivedTriState): v is true {
  return v === true;
}

export function isConfirmedFalse(v: DerivedTriState): v is false {
  return v === false;
}

/** Map tri-state to boolean for storage; indeterminate → null (caller must fail closed). */
export function triStateToConfirmedBoolean(
  v: DerivedTriState,
): boolean | null {
  if (v === "indeterminate") return null;
  return v;
}
