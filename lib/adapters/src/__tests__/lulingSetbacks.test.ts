/**
 * Luling setback table (P-258 lane-f, researched 2026-09-16).
 *
 * No code-section atom corpus exists for luling_tx, so every value is
 * primary-source-verified rather than asserted/human-verified -- the state
 * gate.ts added for exactly this shape of table (see
 * docs/setback-extraction-acceptance-gate.md). Real end-to-end proof: run
 * the actual acceptance gate against the table with an empty atom corpus
 * and confirm it passes with zero blocks, not just that the JSON parses.
 *
 * Two conflicts inside the ordinance are carried in the table (documented in
 * the file's own note and in each affected field's provenance quote) rather
 * than silently resolved:
 *   - C-3: Table 1's Rear/Side columns are transposed relative to Sec. 3.09(E).
 *   - MH: lot coverage is 40% in Table 1 and 55% in Sec. 3.06(F)(1).
 * This test pins both so a later edit cannot quietly "clean them up".
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

describe("luling-tx", () => {
  it("routes and carries all 12 codified Appendix B districts", () => {
    const table = getSetbackTableForZoning("luling-tx", "R-1")!;
    expect(table.jurisdictionKey).toBe("luling-tx");
    expect(table.districts).toHaveLength(12);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("luling-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("carries the adoption date read at source (Ord. No. 2013-O-04, adopted March 14, 2013)", () => {
    const table = getSetbackTable("luling-tx")!;
    expect(table.effectiveDate).toBe("2013-03-14");
    expect(table.note).toMatch(/2013-O-04/);
  });

  it("C-3's Table 1 / Sec. 3.09 column transposition is coded from the section and flagged, not silently resolved", () => {
    const table = getSetbackTable("luling-tx")!;
    const c3 = table.districts.find((d) => d.district_name.startsWith("C-3"))!;
    const p = (c3 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(c3.side_ft).toBe(10);
    expect(c3.rear_ft).toBe(25);
    expect(p.side_ft!.quote).toMatch(/CONFLICT, FLAGGED NOT RESOLVED/);
    expect(p.side_ft!.confidence).toBeLessThan(0.7);
    expect(p.rear_ft!.quote).toMatch(/CONFLICT, FLAGGED NOT RESOLVED/);
  });

  it("MH's Table 1 (40%) vs Sec. 3.06(F)(1) (55%) lot-coverage conflict is carried at reduced confidence", () => {
    const table = getSetbackTable("luling-tx")!;
    const mh = table.districts.find((d) => d.district_name.startsWith("MH"))!;
    const p = (mh as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(mh.max_lot_coverage_pct).toBe(40);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/CONFLICT, FLAGGED NOT RESOLVED/);
    expect(p.max_lot_coverage_pct!.confidence).toBeLessThan(0.7);
    expect(p.max_impervious_pct!.quote).toMatch(/fifty-five \(55\)/);
  });

  it("P&I's reserved dimensions are not_specified, not invented numbers", () => {
    const table = getSetbackTable("luling-tx")!;
    const pi = table.districts.find((d) => d.district_name.startsWith("P&I"))!;
    const p = (pi as unknown as GatedSetbackTable["districts"][number]).provenance!;
    for (const field of ["front_ft", "rear_ft", "side_ft", "max_height_ft"] as const) {
      expect(p[field]!.not_specified, field).toBe(true);
    }
    expect(p.side_ft!.quote).toMatch(/case by case basis/);
    // G7: the corpus gate makes 999 the ONE canonical max_height_ft sentinel.
    expect(pi.max_height_ft).toBe(999);
  });

  it("RHD's deferred lot coverage (Table 1 -> Sec. 3.05 F) is not_specified because Sec. 3.05(F) states no coverage cap", () => {
    const table = getSetbackTable("luling-tx")!;
    const rhd = table.districts.find((d) => d.district_name.startsWith("RHD"))!;
    const p = (rhd as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/no numeric lot-coverage cap/);
  });

  it("R-1's dwelling corner-side yard is not asserted (the code states a corner yard for accessory buildings only)", () => {
    const table = getSetbackTable("luling-tx")!;
    const r1 = table.districts.find((d) => d.district_name.startsWith("R-1"))!;
    const p = (r1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.side_corner_ft!.not_specified).toBe(true);
    expect(p.side_corner_ft!.quote).toMatch(/accessory buildings/i);
  });
});
