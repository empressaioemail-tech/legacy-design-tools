/**
 * RAIL STATE DERIVATION — the half of the ledger cell this scorer was not
 * writing.
 *
 * `countyFloodScoreCli.ts` and `countyGeometryScoreCli.ts` both write
 * `rail_state` and `threshold_pct` next to their coverage.
 * `countyCoverageScoreCli.ts` wrote only the coverage, so for the zoning,
 * envelope and land-use facets the NUMBER and the FIELD THE DISPLAY READS had
 * different authors and nothing reconciled them. Measured live 2026-08-19:
 * Travis 48453 held `rail_state='satisfied-present'` with
 * `honest_coverage_pct=0.00` and `verified_by_instrument NULL`, and 19 zoning
 * rows carried `satisfied-present` of which exactly one clears its threshold.
 *
 * Three sibling scorers, two writing the pair and one writing half of it, is
 * the CTRL-1 shape at the instrument level (DEV_PROCESS 2.4).
 */

import { describe, it, expect } from "vitest";
import {
  deriveRailState,
  railThresholdPct,
  LANDUSE_JOIN_FACET_KEY,
} from "./countyCoverageScoreCli";

describe("railThresholdPct", () => {
  it("reads the rail declaration rather than a local constant", () => {
    expect(railThresholdPct("zoning")).toBe(95);
    expect(railThresholdPct("envelope")).toBe(90);
  });

  it("returns null for a non-rail facet", () => {
    expect(railThresholdPct(LANDUSE_JOIN_FACET_KEY)).toBeNull();
    expect(railThresholdPct("wetlands")).toBeNull();
  });
});

describe("deriveRailState", () => {
  it("at or above threshold is satisfied-present", () => {
    expect(deriveRailState("zoning", 95)).toBe("satisfied-present");
    expect(deriveRailState("zoning", 99.77)).toBe("satisfied-present");
    expect(deriveRailState("envelope", 90)).toBe("satisfied-present");
  });

  it("REFUSES satisfied-present below threshold — the Travis and Bastrop cases", () => {
    // Travis re-measures at 33.32%, Bastrop at 15.22%. Neither may claim
    // satisfied on a number that cannot support it; both carry their real
    // coverage into a not-yet cell.
    expect(deriveRailState("zoning", 33.32)).toBe("not-yet");
    expect(deriveRailState("zoning", 15.22)).toBe("not-yet");
    expect(deriveRailState("zoning", 0)).toBe("not-yet");
    expect(deriveRailState("zoning", 94.99)).toBe("not-yet");
  });

  it("never emits satisfied-absent — an absence needs a positive determination", () => {
    // A stamp-rate scorer has neither the determination nor the basis, and the
    // schema CHECK requires absence_basis whenever rail_state is
    // satisfied-absent. Making that unreachable here is the fail-closed choice.
    for (const pct of [0, 1, 50, 99.99, 100]) {
      expect(deriveRailState("zoning", pct)).not.toBe("satisfied-absent");
      expect(deriveRailState("envelope", pct)).not.toBe("satisfied-absent");
    }
  });

  it("returns null for the diagnostic facet so it can never occupy a cell", () => {
    expect(deriveRailState(LANDUSE_JOIN_FACET_KEY, 98.01)).toBeNull();
    expect(deriveRailState(LANDUSE_JOIN_FACET_KEY, 0)).toBeNull();
  });

  it("the boundary is inclusive, and is proven on both sides", () => {
    // DEV_PROCESS 2.2: an indicator is trusted once it is shown to fire AND to
    // hold its fire, on adjacent inputs rather than distant ones.
    expect(deriveRailState("envelope", 89.99)).toBe("not-yet");
    expect(deriveRailState("envelope", 90)).toBe("satisfied-present");
  });
});
