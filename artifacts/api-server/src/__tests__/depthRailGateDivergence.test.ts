/**
 * DEPTH-RAIL DISPLAY GATE — divergence test between the two implementations.
 *
 * One rule, two copies:
 *   lib/db/src/manifestGridRead.ts                   applyDepthRailDisplayGate
 *   artifacts/api-server/src/countyLedgerCompute.ts  applyDepthRailDisplayGate
 *
 * DEV_PROCESS 2.4, the CTRL-1 shape: when one rule has two implementations,
 * the divergence test IS the control. The dispatch compiler and the canon-gate
 * hook were two implementations of one rule and drifted silently for an entire
 * plan. These two are one edit away from the same failure and nothing was
 * comparing them.
 *
 * Both copies run BOTH gates for real — the lib/db one through its own public
 * entry point `readManifestGridFromPool`, driven by a stub pool, so no copy of
 * its logic is restated here and no test can pass by testing one
 * implementation twice. (The two hand-maintained copies of the manifest-grid
 * SQL itself remain outside this test's reach; noted so the residual exposure
 * is visible rather than implied.)
 *
 * WHAT THE GATE DOES, and why lane SS-W13 declined to change it. A
 * jurisdiction-depth cell claiming `satisfied-present` while its coverage sits
 * below its threshold is demoted to `not-yet`. Measured live 2026-08-19: the
 * store holds 19 zoning rows at `satisfied-present`, of which exactly one
 * (Bastrop 48021, 99.77% against a 95% bar) clears its threshold; the other 18
 * read 0.00% to 33.98%. Since NOTHING checked into this repo writes
 * `county_facet_coverage.rail_state`, that column is set by one-off scripts
 * with no consistency constraint against the coverage columns — so this gate
 * is the only thing standing between a 0.00% row and a customer-facing
 * "satisfied". Its refusal is load-bearing safety, not over-strictness.
 *
 * ITS DEFECT, AND THE RULING THAT FIXED IT. The gate used to demote to
 * `not-yet` and clear `isPartial`, so "measured at 33.98% below a 95% bar" and
 * "never scored at all" rendered identically. All 18 partial cells in the
 * entire ledger are zoning cells, so the ledger summary's
 * `satisfiedPresentPartialCells` — the field built to surface exactly that
 * class — read 0 while the store held 18. Lane SS-W13 filed that rather than
 * shipping it, because moving a reported number is an operator ruling.
 *
 * OPERATOR RULING 4 (2026-08-19, OPS-16 A-020) IS THAT RULING, and lane SS-W15
 * executed it: the gate now demotes to `measured-below-bar`, and a cell with no
 * ledger row at all renders `not-measured`. One is a coverage gap, the other an
 * instrument gap, and they no longer look the same. The demotion target is
 * `DEPTH_GATE_DEMOTION_STATE` in `lib/db/src/manifestDisplayState.ts` — a single
 * constant both copies read, so the value can no longer be changed in one of
 * them. `isPartial` is still cleared on demotion, and that is now correct
 * rather than lossy: the display state itself carries what `isPartial` used to
 * have to encode.
 */

import { describe, it, expect } from "vitest";
import { applyDepthRailDisplayGate as gateLedgerCompute } from "../countyLedgerCompute";
import {
  DEPTH_GATE_DEMOTION_STATE,
  readManifestGridFromPool,
} from "@workspace/db/manifest";

interface GateCase {
  label: string;
  railKey: string;
  displayState: string;
  isPartial: boolean;
  honestCoveragePct: number | null;
  thresholdPct: number | null;
}

const CASES: readonly GateCase[] = [
  // The live shapes, named.
  { label: "Bastrop 48021 zoning above bar", railKey: "zoning", displayState: "satisfied-present", isPartial: false, honestCoveragePct: 99.77, thresholdPct: 95 },
  { label: "Williamson 48491 zoning below bar", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 33.98, thresholdPct: 95 },
  { label: "Travis 48453 zoning at zero", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 0, thresholdPct: 95 },
  { label: "null coverage", railKey: "zoning", displayState: "satisfied-present", isPartial: false, honestCoveragePct: null, thresholdPct: 95 },
  { label: "null threshold falls back to the rail default", railKey: "zoning", displayState: "satisfied-present", isPartial: false, honestCoveragePct: 50, thresholdPct: null },
  { label: "already not-yet", railKey: "zoning", displayState: "not-yet", isPartial: false, honestCoveragePct: 0, thresholdPct: 95 },
  { label: "satisfied-absent is untouched", railKey: "zoning", displayState: "satisfied-absent", isPartial: false, honestCoveragePct: 0, thresholdPct: 95 },
  // statewide-uniform rails are NOT gated: per OPS-14 the gate is a depth rule.
  { label: "geometry below bar is not demoted", railKey: "geometry", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 80, thresholdPct: 95 },
  { label: "mud below bar is not demoted", railKey: "mud", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 12, thresholdPct: 90 },
  // other depth rails share the rule
  { label: "landuse below bar", railKey: "landuse", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 45.96, thresholdPct: 90 },
  { label: "cad above bar", railKey: "cad", displayState: "satisfied-present", isPartial: false, honestCoveragePct: 100, thresholdPct: 95 },
];

/** Drive the REAL lib/db gate through its own entry point with a stub pool. */
async function runLibDbGate(
  cases: readonly GateCase[],
): Promise<Array<{ displayState: string; isPartial: boolean }>> {
  const rows = cases.map((c, i) => ({
    county_fips: String(48000 + i),
    rail_key: c.railKey,
    // NULL so the lib/db fallback `cell_threshold ?? rail_default_threshold`
    // cannot silently hand one side a threshold the other never saw. Both
    // implementations must receive byte-identical inputs or the comparison
    // proves nothing.
    rail_default_threshold: null,
    atom_family_state: "present",
    has_writer: true,
    rail_state: c.displayState,
    honest_coverage_pct: c.honestCoveragePct,
    cell_threshold: c.thresholdPct,
    verified_by_instrument: null,
    display_state: c.displayState,
    is_partial: c.isPartial,
  }));
  const stubPool = { query: async () => ({ rows }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cells = await readManifestGridFromPool(stubPool as any);
  return cells.map((c) => ({
    displayState: c.displayState,
    isPartial: c.isPartial,
  }));
}

function runLedgerComputeGate(
  c: GateCase,
): { displayState: string; isPartial: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = gateLedgerComputeAny({
    countyFips: "48000",
    railKey: c.railKey,
    displayState: c.displayState,
    isPartial: c.isPartial,
    honestCoveragePct: c.honestCoveragePct,
    thresholdPct: c.thresholdPct,
  });
  return { displayState: r.displayState, isPartial: r.isPartial };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gateLedgerComputeAny = gateLedgerCompute as unknown as (c: any) => any;

describe("depth-rail display gate: two implementations, one rule", () => {
  it("both implementations agree on every case", async () => {
    const libDb = await runLibDbGate(CASES);
    CASES.forEach((c, i) => {
      const compute = runLedgerComputeGate(c);
      expect(compute.displayState, `${c.label}: displayState`).toBe(
        libDb[i]?.displayState,
      );
      expect(compute.isPartial, `${c.label}: isPartial`).toBe(
        libDb[i]?.isPartial,
      );
    });
  });

  it("the comparison itself can FAIL — proven, not assumed", async () => {
    // DEV_PROCESS 2.2: a gate that cannot fail for the right reason is a
    // defect, not a test. Feed the two sides DIFFERENT inputs and confirm the
    // comparison detects it. Without this, an agreement result proves only
    // that the assertion ran.
    const libDb = await runLibDbGate([
      { label: "x", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 0, thresholdPct: 95 },
    ]);
    const divergent = runLedgerComputeGate({
      label: "x", railKey: "geometry", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 0, thresholdPct: 95,
    });
    expect(libDb[0]?.displayState).toBe(DEPTH_GATE_DEMOTION_STATE);
    expect(divergent.displayState).toBe("satisfied-present");
    expect(divergent.displayState).not.toBe(libDb[0]?.displayState);
  });

  it("DEMOTES a depth cell below its threshold — the load-bearing refusal", () => {
    const r = runLedgerComputeGate({
      label: "Travis at zero", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 0, thresholdPct: 95,
    });
    expect(r.displayState).toBe(DEPTH_GATE_DEMOTION_STATE);
    // The refusal must still REFUSE. A rename that accidentally demoted to a
    // satisfied-looking state would pass a `toBe(CONSTANT)` assertion while
    // publishing a 0.00% cell as covered, so the state is also pinned by NAME.
    expect(r.displayState).toBe("measured-below-bar");
    expect(r.displayState).not.toBe("satisfied-present");
  });

  it("EXECUTES ruling 4: a demoted cell is measured-below-bar, not not-yet", async () => {
    const r = runLedgerComputeGate({
      label: "Williamson below bar", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 33.98, thresholdPct: 95,
    });
    expect(r.displayState).toBe("measured-below-bar");
    expect(r.isPartial).toBe(false);
    const libDb = await runLibDbGate([
      { label: "same", railKey: "zoning", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 33.98, thresholdPct: 95 },
    ]);
    expect(libDb[0]?.isPartial).toBe(false);
  });

  it("holds its fire on a statewide-uniform rail, for the right reason", () => {
    const r = runLedgerComputeGate({
      label: "geometry below bar", railKey: "geometry", displayState: "satisfied-present", isPartial: true, honestCoveragePct: 80, thresholdPct: 95,
    });
    expect(r.displayState).toBe("satisfied-present");
    expect(r.isPartial).toBe(true);
  });
});
