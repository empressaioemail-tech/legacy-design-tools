/**
 * THE DISPLAY-STATE SPLIT (operator ruling 4, 2026-08-19) — three things
 * proven, not asserted.
 *
 *   1. The split FIRES: a cell with no ledger row and a cell measured below
 *      its bar produce different display states (DEV_PROCESS 2.2).
 *   2. It is ARITHMETIC-NEUTRAL: `texasCompletenessPct` and every satisfied
 *      count are byte-identical before and after. A display change that
 *      quietly moved the launch-gate number would be the worst possible
 *      outcome of a lane whose subject is numbers meaning what they say.
 *   3. It cannot DIVERGE: the CASE and the demotion target live in one file
 *      and neither consumer carries a private copy (DEV_PROCESS 2.4, the
 *      CTRL-1 shape).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  DEPTH_GATE_DEMOTION_STATE,
  MANIFEST_DISPLAY_STATES,
  MANIFEST_DISPLAY_STATE_SQL,
  MANIFEST_IS_PARTIAL_SQL,
  isUnsatisfiedDisplayState,
  readManifestGridFromPool,
} from "@workspace/db/manifest";
import { computeTexasRollup, isSatisfiedCell } from "../countyLedgerCompute";

const repoFile = (rel: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../../${rel}`, import.meta.url)),
    "utf8",
  );

interface GridRow {
  county_fips: string;
  rail_key: string;
  atom_family_state: string;
  has_writer: boolean;
  rail_state: string | null;
  honest_coverage_pct: number | null;
  cell_threshold: number | null;
}

async function grid(rows: GridRow[]) {
  const stubPool = {
    query: async () => ({
      rows: rows.map((r) => ({
        ...r,
        rail_default_threshold: null,
        verified_by_instrument: null,
        // The stub stands in for the DATABASE evaluating the shared CASE, so
        // the CASE's own branches are reproduced here ONCE, from the shared
        // constant's documented semantics, and the assertions below check the
        // constant's TEXT separately. A stub cannot run SQL.
        display_state:
          r.atom_family_state !== "present"
            ? "no-atom"
            : r.has_writer === false
              ? "no-writer"
              : r.rail_state === null
                ? "not-measured"
                : r.rail_state === "not-yet"
                  ? "measured-below-bar"
                  : r.rail_state,
        is_partial:
          r.atom_family_state === "present" &&
          r.has_writer === true &&
          r.rail_state === "satisfied-present" &&
          (r.honest_coverage_pct ?? 0) < (r.cell_threshold ?? 0),
      })),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await readManifestGridFromPool(stubPool as any);
}

describe("manifest display state: the split ruling 4 asked for", () => {
  it("SEPARATES a never-measured cell from a measured-below-bar cell", async () => {
    const cells = await grid([
      // Travis zoning before this lane: no row at all for the corrected rule.
      { county_fips: "48453", rail_key: "zoning", atom_family_state: "present", has_writer: true, rail_state: null, honest_coverage_pct: null, cell_threshold: null },
      // Bastrop zoning on the corrected denominator: 79.60% against a 95 bar.
      { county_fips: "48021", rail_key: "zoning", atom_family_state: "present", has_writer: true, rail_state: "not-yet", honest_coverage_pct: 79.6, cell_threshold: 95 },
    ]);
    expect(cells[0]?.displayState).toBe("not-measured");
    expect(cells[1]?.displayState).toBe("measured-below-bar");
    expect(cells[0]?.displayState).not.toBe(cells[1]?.displayState);
  });

  it("the depth gate demotes a satisfied-looking cell into the MEASURED class, not the unmeasured one", async () => {
    // A stored `satisfied-present` at 0.00% is a real live shape: Bexar 48029
    // holds exactly that. It was measured; it is simply nowhere near its bar.
    const cells = await grid([
      { county_fips: "48029", rail_key: "zoning", atom_family_state: "present", has_writer: true, rail_state: "satisfied-present", honest_coverage_pct: 0, cell_threshold: 95 },
    ]);
    expect(cells[0]?.displayState).toBe("measured-below-bar");
    expect(cells[0]?.displayState).toBe(DEPTH_GATE_DEMOTION_STATE);
    // Composed with R-09 (PR #447, live since 2026-08-21): isPartial
    // survives demotion rather than being cleared. See
    // depthRailGateDivergence.test.ts for the full reasoning.
    expect(cells[0]?.isPartial).toBe(true);
  });

  it("leaves no-atom and no-writer precedence untouched", async () => {
    const cells = await grid([
      { county_fips: "48001", rail_key: "roads", atom_family_state: "missing", has_writer: true, rail_state: null, honest_coverage_pct: null, cell_threshold: null },
      { county_fips: "48001", rail_key: "easement", atom_family_state: "present", has_writer: false, rail_state: null, honest_coverage_pct: null, cell_threshold: null },
    ]);
    expect(cells[0]?.displayState).toBe("no-atom");
    expect(cells[1]?.displayState).toBe("no-writer");
  });

  it("is ARITHMETIC-NEUTRAL: neither new state is ever satisfied", () => {
    for (const state of ["not-measured", "measured-below-bar", "not-yet"]) {
      expect(
        isSatisfiedCell({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          displayState: state as any,
          isPartial: false,
          source: null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      ).toBe(false);
      expect(isUnsatisfiedDisplayState(state)).toBe(true);
    }
  });

  it("is ARITHMETIC-NEUTRAL: the Texas rollup is identical under the old and new labels", () => {
    // The same grid, once with the pre-ruling labels and once with the new
    // ones. If the rollup moves, the split changed a reported number and this
    // fails loudly rather than shipping.
    const shape = (unsatisfiedLabel: string, neverMeasuredLabel: string) =>
      [
        { countyFips: "48021", railKey: "zoning", displayState: unsatisfiedLabel, isPartial: false, source: null },
        { countyFips: "48021", railKey: "flood", displayState: "satisfied-present", isPartial: false, source: null },
        { countyFips: "48453", railKey: "zoning", displayState: neverMeasuredLabel, isPartial: false, source: null },
        { countyFips: "48453", railKey: "flood", displayState: "satisfied-absent", isPartial: false, source: "x" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any[];
    const weights = new Map<string, number | null>([
      ["48021", 63357],
      ["48453", 828773],
    ]);
    const before = computeTexasRollup(shape("not-yet", "not-yet"), weights);
    const after = computeTexasRollup(
      shape("measured-below-bar", "not-measured"),
      weights,
    );
    expect(after.texasPct).toBe(before.texasPct);
    expect(after.totalParcelWeight).toBe(before.totalParcelWeight);
  });

  it("keeps `not-yet` representable, because the ledger still STORES it", () => {
    // The grid no longer produces it, but `county_facet_coverage.rail_state`
    // still holds it and its CHECK constraint is untouched. A union that
    // dropped it would make a stored value unrepresentable.
    expect(MANIFEST_DISPLAY_STATES).toContain("not-yet");
    expect(MANIFEST_DISPLAY_STATES).toContain("not-measured");
    expect(MANIFEST_DISPLAY_STATES).toContain("measured-below-bar");
  });
});

describe("manifest display state: one rule, one home (divergence control)", () => {
  const GRID_READ = "lib/db/src/manifestGridRead.ts";
  const LEDGER_COMPUTE = "artifacts/api-server/src/countyLedgerCompute.ts";

  it("both consumers reference the SHARED constants", () => {
    for (const rel of [GRID_READ, LEDGER_COMPUTE]) {
      const src = repoFile(rel);
      expect(src, `${rel} must use the shared display CASE`).toContain(
        "MANIFEST_DISPLAY_STATE_SQL",
      );
      expect(src, `${rel} must use the shared is_partial CASE`).toContain(
        "MANIFEST_IS_PARTIAL_SQL",
      );
      expect(src, `${rel} must use the shared demotion target`).toContain(
        "DEPTH_GATE_DEMOTION_STATE",
      );
    }
  });

  it("NEITHER consumer carries a private copy of the CASE", () => {
    // This is the control. Two careful edits are not a control; a test that
    // fails when a copy reappears is (DEV_PROCESS 2.4).
    for (const rel of [GRID_READ, LEDGER_COMPUTE]) {
      const src = repoFile(rel);
      expect(src, `${rel} reintroduced a local display CASE`).not.toContain(
        "THEN 'no-atom'",
      );
      expect(src, `${rel} reintroduced a local demotion literal`).not.toContain(
        'displayState: "not-yet"',
      );
    }
  });

  it("the file-reading control can FAIL — proven, not assumed", () => {
    // DEV_PROCESS 2.2/2.3: prove the negative. If `repoFile` silently returned
    // an empty string, or if a missing file resolved to one, every assertion
    // above would pass vacuously and the divergence control would be decoration.
    // So: the reader is shown to return real content, and the SAME assertion
    // form used above is shown to actually throw when the content is present.
    const src = repoFile(GRID_READ);
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("readManifestGridFromPool");
    expect(() => expect(src).not.toContain("readManifestGridFromPool")).toThrow();
    // A path that does not exist must THROW, never resolve to an empty string
    // that would satisfy every `.not.toContain` check in this suite.
    expect(() => repoFile("lib/db/src/this-file-does-not-exist.ts")).toThrow();
  });

  it("the shared CASE actually encodes the split", () => {
    expect(MANIFEST_DISPLAY_STATE_SQL).toContain(
      "WHEN c.rail_state IS NULL THEN 'not-measured'",
    );
    expect(MANIFEST_DISPLAY_STATE_SQL).toContain(
      "WHEN c.rail_state = 'not-yet' THEN 'measured-below-bar'",
    );
    expect(MANIFEST_IS_PARTIAL_SQL).toContain("AS is_partial");
  });
});
