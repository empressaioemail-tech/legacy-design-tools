/**
 * Belton, Seguin, and Cibolo setback tables (SETBACK TABLE OWED gap fill,
 * researched 2026-09-06/07). No code-section atom corpus exists yet for any
 * of these three (live-verified zero against the real atoms store), so
 * every value is primary-source-verified rather than asserted/human-verified
 * -- gate.ts's new state (legacy-design-tools#628) exists specifically for
 * this shape of table. Real end-to-end proof: run the actual acceptance
 * gate against each table with an empty atom corpus and confirm it passes
 * with zero blocks, not just that the JSON parses.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

describe("belton-tx", () => {
  it("routes and carries all 22 codified districts", () => {
    const table = getSetbackTableForZoning("belton-tx", "SF-1")!;
    expect(table.jurisdictionKey).toBe("belton-tx");
    expect(table.districts).toHaveLength(22);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("belton-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("O-2's ambiguous side-yard clause is coded at reduced confidence, not silently resolved", () => {
    const table = getSetbackTable("belton-tx")!;
    const o2 = table.districts.find((d) => d.district_name.startsWith("O-2"))!;
    expect(o2.side_ft).toBe(0);
    const p = (o2 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.side_ft!.confidence).toBeLessThan(0.6);
    expect(p.side_ft!.quote).toMatch(/ambiguous/i);
  });
});

describe("seguin-tx", () => {
  it("routes and carries all 11 codified districts", () => {
    const table = getSetbackTableForZoning("seguin-tx", "R-1")!;
    expect(table.jurisdictionKey).toBe("seguin-tx");
    expect(table.districts).toHaveLength(11);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("seguin-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });
});

describe("cibolo-tx", () => {
  it("routes and carries the 4 codified SF districts", () => {
    const table = getSetbackTableForZoning("cibolo-tx", "SF-1")!;
    expect(table.jurisdictionKey).toBe("cibolo-tx");
    expect(table.districts).toHaveLength(4);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("cibolo-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("SF-5 and SF-6 are honestly omitted (live GIS codes, no dimensional-standards subsection in the current code)", () => {
    const table = getSetbackTable("cibolo-tx")!;
    const names = table.districts.map((d) => d.district_name);
    expect(names.some((n) => n.startsWith("SF-5"))).toBe(false);
    expect(names.some((n) => n.startsWith("SF-6"))).toBe(false);
    expect(table.note).toMatch(/SF-6/);
  });
});
