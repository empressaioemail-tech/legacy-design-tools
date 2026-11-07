/**
 * P-257 — a planned-development code is not a Euclidean district.
 *
 * `PUD`/`PDD`/`PD`/`PC` codes are not districts: A-164 routes them to the
 * "your setbacks come from your PUD ordinance" message. A planned unit
 * development's dimensional standards live in the development's own ordinance
 * and development plan, so a district table emitted for one is a value
 * computed without its required input — the thing that must refuse rather than
 * be served.
 *
 * WHY THIS FILE EXISTS AT ALL. The rule is already in this repo, in
 * `lib/cad-ingest/src/txgio/zoning-base-code.ts`, which classifies such a value
 * `planned-development` with base null. It did not reach the setback resolver,
 * whose ONLY matching step is the loose prefix fallback in `mapDistrict` — so
 * the rule was never consulted where it would have mattered. This module is
 * that rule at the point of emission; it imports the pattern from the one
 * definition rather than re-typing it.
 *
 * MEASURED, NOT ASSUMED — why the ordering is load-bearing. A sweep of all 44
 * shipped tables under `lib/adapters/src/local/setbacks/` found exactly 2 whose
 * districts row a code the pattern matches:
 *
 *   - `grand-county-ut`  — "PUD Planned Unit Development" (a real district row)
 *   - `smithville-tx`    — "PD-Z Zero Lot Line Garden Home District" (Sec. 2.2.17)
 *
 * Both are REAL districts. A gate that fires on the code alone would falsely
 * refuse both, and Smithville is the very jurisdiction the measured defect is
 * in: `48021:70907` (district `PD`) served 20/100/100/100.
 *
 * WHERE THOSE NUMBERS CAME FROM, because it decides where the gate must sit.
 * They are Smithville's `PD-Z` row — front 20, rear 100, side 100, corner 100 —
 * crossed into by the REVERSE prefix direction in `isSafePrefixMatch`
 * (`districtCode.startsWith(zoningCode)`, "PDZ".startsWith("PD")), whose own
 * doc comment scopes the rule to the forward case ("suffix variants such as
 * `R-1A` against a table's `R-1` row"). Three of those four numbers are the
 * corpus's `not_specified` SENTINEL 100 read as real feet. So the code alone
 * was enough to serve a table, and the gate must therefore key on the code.
 *
 * THE ORDER, in one sentence: a district the table really rows resolves as a
 * district (`districtCodeHasExactRow`), and only a code with no row of its own
 * is read as a planned-development code. This mirrors `zoning-base-code.ts`'s
 * own recorded divergence from P-255's census — "this parser checks the base
 * vocabulary FIRST, so a city whose table really rows a PD/PC/PUD district
 * resolves it as a district". A code that is neither an exact row nor a
 * planned-development code is untouched: it keeps today's decline. THIS GATE
 * ADDS A REFUSAL; IT NEVER ADDS A VALUE.
 */

import {
  PLANNED_DEVELOPMENT_FLAGS,
  PLANNED_DEVELOPMENT_PATTERN,
} from "@workspace/cad-ingest/zoning-layers";

export { PLANNED_DEVELOPMENT_FLAGS, PLANNED_DEVELOPMENT_PATTERN };

const PLANNED_DEVELOPMENT_RE = new RegExp(
  PLANNED_DEVELOPMENT_PATTERN,
  PLANNED_DEVELOPMENT_FLAGS,
);

/** The published value, trimmed. Shared with `mapDistrict`'s own normalization step. */
export function trimDistrictCode(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

/**
 * Is this published zoning value a planned-development code? Pattern test only:
 * it answers "what kind of code is this", never "may a table be served". Callers
 * must consult the exact-row test first (see
 * {@link plannedDevelopmentSetbackRefusalFor}), or they will refuse
 * Smithville's real `PD-Z` row and Grand County's real `PUD` row.
 */
export function isPlannedDevelopmentCode(
  raw: string | null | undefined,
): boolean {
  const code = trimDistrictCode(raw);
  if (!code) return false;
  // The shared pattern carries no `g` flag; `lastIndex` is reset anyway so a
  // future flags change cannot make this stateful.
  PLANNED_DEVELOPMENT_RE.lastIndex = 0;
  return PLANNED_DEVELOPMENT_RE.test(code);
}

/**
 * The refusal, in one string. Copied verbatim from P-256's `PUD_REFUSAL_REASON`
 * (`src/jobs/parcel-setback-cells.mjs`) so the ledger writer, the card and the
 * draw route cannot mean different things by the refused state.
 */
export const PUD_SETBACK_REFUSAL_REASON =
  "setbacks for this parcel are set by its planned-development ordinance, " +
  "not a district schedule";

/**
 * The customer-facing disclosure for a planned-development refusal: names the
 * class, names the parcel's own district, says why no table exists, and says
 * what to do instead.
 *
 * THIS STRING IS PINNED IN TWO REPOS. hauska-map composes the same sentence in
 * `apps/property-explorer/api/_lib/planned-development-district.ts` and its
 * suite asserts the pinned literal byte-for-byte, as this repo's suite does.
 * Change one and the other repo's suite fails on the pin.
 */
export function plannedDevelopmentDisclosure(input: {
  districtCode: string;
  jurisdictionKey?: string | null;
}): string {
  const where = trimDistrictCode(input.jurisdictionKey);
  return (
    `${input.districtCode} is a planned-development code, not a Euclidean ` +
    "district: its dimensional standards are set by the development's own " +
    "ordinance and development plan, not by a district schedule, so no " +
    "setback table is served" +
    (where ? ` for ${where}` : "") +
    ". " +
    PUD_SETBACK_REFUSAL_REASON.charAt(0).toUpperCase() +
    PUD_SETBACK_REFUSAL_REASON.slice(1) +
    ". Verify the development plan's own standards with the city."
  );
}

export type PlannedDevelopmentSetbackRefusal = {
  /** Wire reason token. Additive; every consumer falls back to the disclosure it travels beside. */
  declineReason: "planned-development";
  districtCode: string;
  jurisdictionKey: string | null;
  /** The full customer-facing sentence. */
  disclosure: string;
  /** The pinned P-256 sentence, for callers that want the refusal alone. */
  refusalReason: string;
};

/**
 * THE GATE. Returns the refusal when this parcel's district must not be served
 * a setback table, and null when it may.
 *
 * `districtCodeHasExactRow` is injected rather than imported so the ordering
 * can be exercised in this module's test against the real 44-table corpus, and
 * so this module never grows a second copy of the row matcher.
 */
export function plannedDevelopmentSetbackRefusalFor(
  args: {
    jurisdictionKey: string | null | undefined;
    districtCode: string | null | undefined;
  },
  districtCodeHasExactRow: (districtCode: string) => boolean,
): PlannedDevelopmentSetbackRefusal | null {
  const districtCode = trimDistrictCode(args.districtCode);
  if (!districtCode) return null;
  if (!isPlannedDevelopmentCode(districtCode)) return null;
  // A district the table really rows is this parcel's own district. Only a code
  // with no row of its own is read as planned development.
  if (districtCodeHasExactRow(districtCode)) return null;
  return {
    declineReason: "planned-development",
    districtCode,
    jurisdictionKey: trimDistrictCode(args.jurisdictionKey) || null,
    disclosure: plannedDevelopmentDisclosure({
      districtCode,
      jurisdictionKey: args.jurisdictionKey,
    }),
    refusalReason: PUD_SETBACK_REFUSAL_REASON,
  };
}
