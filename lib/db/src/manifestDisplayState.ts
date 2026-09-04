/**
 * MANIFEST DISPLAY STATE — one rule, one home.
 *
 * WHAT THIS FIXES, operator ruling 4 of 2026-08-19 (OPS-16 A-020, lane
 * SS-W15): a county MEASURED at 60% and a county NEVER MEASURED both rendered
 * `not-yet`. They are completely different states. One is a coverage gap and
 * the answer is acquisition; the other is an instrument gap and the answer is
 * wiring. Collapsing them made the console unable to say which of the two any
 * cell was, and on the zoning rail that is not a corner case: only 23 city
 * zoning layers are wired across 10 counties against 1,222 incorporated Texas
 * municipalities, so after lane SS-W15's refusal rule MOST counties are
 * not-measurable and every one of them used to read the same as a county we
 * had measured and found short. This is the absent-covered versus
 * absent-uncovered distinction already ruled for the parcel card, one level up.
 *
 * WHY THIS FILE EXISTS AT ALL, rather than two more careful edits. The display
 * CASE and the depth-rail demotion were each written out TWICE, in
 * `lib/db/src/manifestGridRead.ts` and
 * `artifacts/api-server/src/countyLedgerCompute.ts`, with nothing tying them
 * together except discipline. That is the CTRL-1 shape (DEV_PROCESS 2.4): one
 * rule, two implementations, and the planner taught one of them about `G-`
 * rows and never touched the other for an entire plan. The fix there was not a
 * patch to both, it was a single source of truth plus a divergence test, and
 * that is what this is. `manifestDisplayStateDivergence.test.ts` asserts both
 * consumers use THIS expression and neither carries its own copy.
 *
 * NO MIGRATION, and that is a design result rather than a convenience. The
 * never-measured case has NO `county_facet_coverage` ROW — lane SS-W13 ruled
 * that a refused facet leaves the ledger silent, and SS-W15 extends the same
 * refusal to the rail-scoring capability. So the distinction is already in the
 * data as `c.rail_state IS NULL`, and needs a display rule rather than a
 * stored enum value. `rail_state`'s CHECK constraint is untouched, and the
 * third concurrent migration that two open sibling PRs would have made a
 * merge-order hazard is not needed.
 *
 * ARITHMETIC-NEUTRAL BY CONSTRUCTION. `isSatisfiedCell` counts
 * `satisfied-present && !isPartial` or `satisfied-absent`; both of the states
 * this split produces were unsatisfied before and are unsatisfied after, so
 * `texasCompletenessPct` cannot move. `manifestDisplayState.test.ts` proves
 * that rather than asserting it, because a display change that quietly moved
 * the launch-gate number would be the worst possible outcome of a lane whose
 * whole subject is numbers that mean what they say.
 */

/**
 * The states a manifest cell can render in.
 *
 * `not-yet` is deliberately RETAINED as a value even though the CASE below no
 * longer produces it: `county_facet_coverage.rail_state` still stores it, the
 * scorers still write it, and a display union that dropped it would make a
 * stored value unrepresentable. What changed is only what the GRID shows.
 */
export const MANIFEST_DISPLAY_STATES = [
  "derivation-indeterminate",
  "no-atom",
  "no-writer",
  /** No ledger row at all: this cell was never measured. An INSTRUMENT gap. */
  "not-measured",
  /** A row exists, it was measured, and it sits below its bar. A COVERAGE gap. */
  "measured-below-bar",
  /** Retained for stored `rail_state` values; not produced by the grid CASE. */
  "not-yet",
  "satisfied-present",
  "satisfied-absent",
] as const;

export type ManifestDisplayState = (typeof MANIFEST_DISPLAY_STATES)[number];

/**
 * The display CASE, as SQL, verbatim and shared.
 *
 * PRECEDENCE IS UNCHANGED above the split: `atom_family_state <> 'present'`
 * wins, then `has_writer = false`, then the stored state. Only the last two
 * branches are new, and they partition exactly what `not-yet` used to cover:
 *
 *   c.rail_state IS NULL           -> `not-measured`      (no row: never scored)
 *   c.rail_state = 'not-yet'       -> `measured-below-bar` (a row: scored, short)
 *
 * Every other stored `rail_state` passes through as before.
 */
export const MANIFEST_DISPLAY_STATE_SQL = `      CASE
        WHEN r.atom_family_state <> 'present' THEN 'no-atom'
        WHEN r.has_writer = false THEN 'no-writer'
        WHEN c.rail_state IS NULL THEN 'not-measured'
        WHEN c.rail_state = 'not-yet' THEN 'measured-below-bar'
        ELSE c.rail_state
      END AS display_state`;

/**
 * The `is_partial` CASE, shared for the same reason: it is the other half of
 * one rule and lived in the same two files. Unchanged in behaviour.
 */
export const MANIFEST_IS_PARTIAL_SQL = `      CASE
        WHEN r.atom_family_state = 'present'
         AND r.has_writer = true
         AND c.rail_state = 'satisfied-present'
         AND c.honest_coverage_pct < COALESCE(c.threshold_pct, r.threshold_pct)
        THEN true
        ELSE false
      END AS is_partial`;

/**
 * Where the depth-rail gate demotes a cell to.
 *
 * It fires only on a cell that HAS a row and HAS a coverage number below its
 * threshold, which is the definition of measured-below-bar. Sending it to
 * `not-yet` is what erased the distinction inside the gate itself, so the two
 * halves of ruling 4 are fixed together: lane SS-W13 pinned this erasure in
 * `depthRailGateDivergence.test.ts` and declined to change it because moving a
 * reported number is an operator ruling. Ruling 4 is that ruling.
 */
export const DEPTH_GATE_DEMOTION_STATE: ManifestDisplayState =
  "measured-below-bar";

/** True for the two states that mean "not satisfied, and here is which kind". */
export function isUnsatisfiedDisplayState(state: string): boolean {
  return (
    state === "not-measured" ||
    state === "measured-below-bar" ||
    state === "not-yet"
  );
}
