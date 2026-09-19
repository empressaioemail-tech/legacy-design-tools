/**
 * P-372 (2026-09-19). The draw route's four-way machine status, and the ONE
 * mapping from the derivation's own empty class to it.
 *
 * WHY THIS IS ITS OWN MODULE. It is the same extraction reason
 * `envelopeDrawOutcome.ts` (P-339) and `composeBuildableEnvelopeDerivation.ts`
 * (P-153 Step A) exist: `composeBuildableEnvelopeDerivation.ts` imports the
 * setback-corpus resolver and the atom-reconcile chain, so a test that only
 * wants to check a four-line decision would inherit that whole graph. Here the
 * decision is pure, dependency-free, and directly testable — which matters,
 * because the class that had to be told apart from "validation" is one no
 * parcel fixture reaches any more (see below).
 *
 * THE DEFECT THIS NAMES. A boolean LIBRARY failure and a GATE verdict are
 * different facts, and the wire carried one name for both. Measured 2026-09-19
 * on Kyle 48209:145880 (151 Fender Dr, Kyle TX, R-1-A): the district resolved
 * and the route emitted a full 25/10/15/10 table, then
 * `polygon-clipping@0.15.7`'s `difference` dead-ended on two VALID operands
 * ("Unable to complete output ring starting at [...]") and the payload answered
 * `geometry-validation-failed` — a verdict about geometry that has no defect,
 * served for an instrument that could not subtract. The reason string inside the
 * payload already said "boolean clip error"; the machine status did not.
 *
 * THE FOUR VALUES.
 *  - `ok`: an envelope was derived.
 *  - `no-buildable-area`: a MEASUREMENT — the clip ran and returned nothing, so
 *    the setbacks genuinely consume the lot. The only class that supports that
 *    claim.
 *  - `geometry-validation-failed`: a ring was produced and a gate judged it
 *    (or the input could not be used at all). A verdict about geometry.
 *  - `geometry-clip-failed`: no ring was ever produced and no gate ever ran
 *    because the boolean clip could not be executed, on the operands as
 *    constructed or on their quantised retry. An INSTRUMENT failure at a named
 *    stage, never dressed up as a verdict.
 *
 * An absent or unknown class lands on the validation names: an unclassified
 * empty fails closed, and is never silently promoted to a measurement.
 */

/**
 * The class set is NOT restated in this module: it is `InsetEmptyKind`,
 * imported from the module that produces it, so a class cannot be added on one
 * side alone.
 */
import type { InsetEmptyKind } from "./geometry";

/**
 * The machine status the drawing route serves for one derivation.
 *
 * Kept as a closed union so a consumer (and the surface probe) can name the
 * stage a decline belongs to rather than treating every non-ok answer as one
 * thing. All three non-ok values are declines; only the stage differs.
 */
export type BuildableEnvelopeWireStatus =
  | "ok"
  | "no-buildable-area"
  | "geometry-validation-failed"
  | "geometry-clip-failed";

/**
 * The ONE mapping from the derivation's own empty class to the wire status.
 *
 * Pure and total: `empty: false` is `ok` regardless of any class left behind by
 * an earlier branch, and every class has exactly one status.
 */
export function wireStatusForEmptyKind(
  empty: boolean,
  emptyKind: InsetEmptyKind | undefined,
): BuildableEnvelopeWireStatus {
  if (!empty) return "ok";
  if (emptyKind === "consumed") return "no-buildable-area";
  if (emptyKind === "clip-failed") return "geometry-clip-failed";
  return "geometry-validation-failed";
}
