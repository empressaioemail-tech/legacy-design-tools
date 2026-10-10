/**
 * Burnet County (48053) stage 6 city setback tables -- OPS-24, W3 (2026-10-09).
 *
 * Tables for the districts the ordinance register (burnet-tx-ordinance-register.json, LDT
 * #800) marks verified-browser-read / SETBACK_EDITION_CURRENT, built from the pack-C
 * person-paced browser read (doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv).
 * Before this table existed, a cleared Burnet district fell through getSetbackTableForZoning to a
 * silent null (see countyEditionCurrency.test.ts's prior "not-yet-done task" assertions); this
 * suite is the real end-to-end proof that the five served cities now resolve to a real, gated
 * table instead.
 *
 * No code-section atom corpus exists yet for any Burnet city, so every value here is
 * primary-source-verified (gate.ts's state for a value read directly off a primary source with
 * no atom to round-trip against) -- the same shape as belton-tx / seguin-tx / cibolo-tx.
 */
import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

function gateReport(key: string) {
  const table = getSetbackTable(key) as unknown as GatedSetbackTable;
  return runSetbackGate({ table, atoms: [] });
}

describe("burnet-tx", () => {
  it("carries exactly the 16 districts the register clears (of 27 total)", () => {
    const table = getSetbackTable("burnet-tx")!;
    expect(table.districts).toHaveLength(16);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const report = gateReport("burnet-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("R-1 E (a clean, non-conditional row) carries the pack-C quoted numbers", () => {
    const table = getSetbackTable("burnet-tx")!;
    const r1e = table.districts.find((d) => d.district_name.includes("(R-1 E)"))!;
    expect(r1e.front_ft).toBe(30);
    expect(r1e.side_ft).toBe(15);
    expect(r1e.rear_ft).toBe(15);
    expect(r1e.side_corner_ft).toBe(15);
    expect(r1e.max_height_ft).toBe(30);
    expect(r1e.max_lot_coverage_pct).toBe(10);
  });

  it("district A's internally-ambiguous Chart 2 coverage (10% AND 40%) is not_specified, never a guessed number", () => {
    const table = getSetbackTable("burnet-tx")!;
    const a = table.districts.find((d) => d.district_name.includes("(A)"))!;
    expect(a.max_lot_coverage_pct).toBe(100); // canonical not_specified sentinel
    const p = (a as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/10%.*40%|ambiguous/i);
  });

  it("getSetbackTableForZoning resolves burnet-tx/R-1 E to the real table, not null", () => {
    const table = getSetbackTableForZoning("burnet-tx", "R-1 E");
    expect(table).not.toBeNull();
    expect(table!.districts.some((d) => d.district_name.includes("(R-1 E)"))).toBe(true);
  });

  it("the 11 refused Burnet districts (conditional / ambiguous / no-dimensional-standards) still throw and still get no row", () => {
    const table = getSetbackTable("burnet-tx")!;
    for (const code of ["R-1", "R-2", "R-2 A", "R-3", "R-6", "R-6-13", "M-1", "M-2", "NC", "C-3", "PUD"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
      expect(() => getSetbackTableForZoning("burnet-tx", code)).toThrow();
    }
  });
});

describe("granite-shoals-tx", () => {
  it("carries exactly the 3 districts the register clears (of 8 total)", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    expect(table.districts).toHaveLength(3);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("granite-shoals-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("R-1's word-number yards (\"not less than five/ten feet\") are coded to their numeric value", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    const r1 = table.districts.find((d) => d.district_name.includes("(R-1)"))!;
    expect(r1.front_ft).toBe(20);
    expect(r1.side_ft).toBe(5);
    expect(r1.rear_ft).toBe(5);
    expect(r1.side_corner_ft).toBe(10);
    expect(r1.max_height_ft).toBe(35);
    expect(r1.max_lot_coverage_pct).toBe(100); // not_specified -- no coverage cap stated
  });

  it("M-1's unstated height carries the canonical 999 sentinel, correctly flagged", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    const m1 = table.districts.find((d) => d.district_name.includes("(M-1)"))!;
    expect(m1.max_height_ft).toBe(999);
    const p = (m1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_height_ft!.not_specified).toBe(true);
  });

  it("the 5 refused Granite Shoals districts still get no row", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    for (const code of ["M-2", "GB-1", "GB-2", "I", "AG"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
    }
  });
});

describe("cottonwood-shores-tx", () => {
  it("carries all 18 districts (the register clears every one)", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    expect(table.districts).toHaveLength(18);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("cottonwood-shores-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("C-1's building/impervious split is coded into the two separate fields", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    const c1 = table.districts.find((d) => d.district_name.includes("(C-1)"))!;
    expect(c1.max_lot_coverage_pct).toBe(60);
    expect(c1.max_impervious_pct).toBe(70);
  });

  it("R-1's lot-size-tiered coverage schedule is not_specified rather than one guessed tier", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    const r1 = table.districts.find((d) => d.district_name.includes("(R-1)"))!;
    expect(r1.max_lot_coverage_pct).toBe(100);
    expect(r1.max_impervious_pct).toBe(100);
    const p = (r1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/lot size|tier/i);
  });

  it("the PUD family's dual-zone height marker (\"****\") is not_specified, never the one-zone 25 ft", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    for (const code of ["PUD", "PUD - R", "PUD - M", "PUD - C", "CUD"]) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_height_ft, code).toBe(999);
    }
  });
});

describe("bertram-tx", () => {
  it("carries exactly the 20 districts the register clears (of 21 total)", () => {
    const table = getSetbackTable("bertram-tx")!;
    expect(table.districts).toHaveLength(20);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("bertram-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("R-1-A (the conditional side-yard district) still gets no row", () => {
    const table = getSetbackTable("bertram-tx")!;
    expect(table.districts.some((d) => d.district_name.includes("(R-1-A)"))).toBe(false);
  });

  it("R-4-1/2/3's main-vs-main-plus-accessory coverage codes the lower, main-only figure", () => {
    const table = getSetbackTable("bertram-tx")!;
    for (const code of ["R-4-1", "R-4-2", "R-4-3"]) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_lot_coverage_pct, code).toBe(40);
      expect(d.max_impervious_pct, code).toBe(100); // not_specified -- no distinct impervious stated
    }
  });

  it("CBD and H (Historic Overlay), whose Chart 1 cells are bare footnote references to the base-use district, carry not_specified yards -- never the footnote NUMBER read as feet", () => {
    const table = getSetbackTable("bertram-tx")!;
    const cbd = table.districts.find((d) => d.district_name.includes("(CBD)"))!;
    const h = table.districts.find((d) => d.district_name.includes("(H)"))!;
    for (const d of [cbd, h]) {
      expect(d.front_ft).toBe(100);
      expect(d.side_ft).toBe(100);
      expect(d.rear_ft).toBe(100);
      expect(d.side_corner_ft).toBe(100);
    }
    // H has NO independently stated dimension at all -- every field not_specified.
    expect(h.max_height_ft).toBe(999);
    expect(h.max_lot_coverage_pct).toBe(100);
    // CBD's coverage IS stated (main-vs-accessory split) even though its yards are deferred.
    expect(cbd.max_lot_coverage_pct).toBe(60);
  });

  it("PUD's directly-stated corner yard (15 ft) and height (45 ft) are coded normally despite its deferred front/side/rear", () => {
    const table = getSetbackTable("bertram-tx")!;
    const pud = table.districts.find((d) => d.district_name.includes("(PUD)"))!;
    expect(pud.front_ft).toBe(100); // deferred to base-use district, footnote (9)
    expect(pud.side_corner_ft).toBe(15);
    expect(pud.max_height_ft).toBe(45);
  });
});

describe("highland-haven-tx", () => {
  it("carries exactly the 4 districts the register clears (of 8 total)", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    expect(table.districts).toHaveLength(4);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("highland-haven-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("GB/LI/GUI's abbreviated \"X% / Y%\" coverage is read as the SAME main-vs-accessory split as O's spelled-out figure, not a buildings/impervious split", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    const expected: Record<string, number> = { O: 50, GB: 60, LI: 50, GUI: 60 };
    for (const [code, cov] of Object.entries(expected)) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_lot_coverage_pct, code).toBe(cov);
      expect(d.max_impervious_pct, code).toBe(100); // not_specified
    }
  });

  it("R1, R2, A and B (conditional / no-dimensional-standards) still get no row", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    for (const code of ["R1", "R2", "A", "B"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
    }
  });
});

describe("Marble Falls, Horseshoe Bay and Meadowlakes remain untabled (separate task / see PR report)", () => {
  it("Marble Falls and Horseshoe Bay still fall through to null even though their own registers clear this gate for some districts", () => {
    expect(getSetbackTableForZoning("marble-falls-tx", "FR")).toBeNull();
    expect(getSetbackTableForZoning("horseshoe-bay-tx", "R-1")).toBeNull();
  });

  it("Meadowlakes has no served district at all, so every code still throws SETBACK_NO_DIMENSIONAL_STANDARDS", () => {
    expect(() => getSetbackTableForZoning("meadowlakes-tx", "R-1")).toThrow();
  });
});
