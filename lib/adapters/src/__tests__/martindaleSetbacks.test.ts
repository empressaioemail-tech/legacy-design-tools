/**
 * Martindale setback table (P-258 lane-f, researched 2026-09-16).
 *
 * The authoritative code host for Martindale is American Legal Publishing's
 * codelibrary.amlegal.com, which returns HTTP 403 (Cloudflare bot challenge)
 * to every fetch this lane tried. The route actually used -- and recorded in
 * the table's own note -- is the City's official zoning page, which
 * reproduces Sec. 155.076 - Sec. 155.084 verbatim. These tests pin that
 * disclosure, the currency caveat that follows from it, and the three places
 * where the ordinance is silent or mis-drafted.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

type Prov = GatedSetbackTable["districts"][number]["provenance"];

describe("martindale-tx", () => {
  it("routes and carries all 9 Chapter 155 districts", () => {
    const table = getSetbackTableForZoning("martindale-tx", "R-1")!;
    expect(table.jurisdictionKey).toBe("martindale-tx");
    expect(table.districts).toHaveLength(9);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("martindale-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("discloses the amlegal 403 wall and the currency caveat it creates", () => {
    const note = getSetbackTable("martindale-tx")!.note!;
    expect(note).toMatch(/codelibrary\.amlegal\.com/);
    expect(note).toMatch(/403/);
    expect(note).toMatch(/martindale\.texas\.gov/);
    expect(note).toMatch(/CURRENCY RISK REMAINS AND IS NOT HIDDEN/);
  });

  it("codes impervious cover as the real value and leaves building coverage not_specified", () => {
    const table = getSetbackTable("martindale-tx")!;
    const r1 = table.districts.find((d) => d.district_name.startsWith("R-1 "))!;
    const p = r1.provenance as unknown as Prov;
    expect(r1.max_impervious_pct).toBe(35);
    expect(p.max_impervious_pct!.not_specified).toBeUndefined();
    expect(r1.max_lot_coverage_pct).toBe(100);
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
  });

  it("MU carries no invented scalar: its standard is per-parcel context", () => {
    const table = getSetbackTable("martindale-tx")!;
    const mu = table.districts.find((d) => d.district_name.startsWith("MU"))!;
    const p = mu.provenance as unknown as Prov;
    for (const f of [
      "front_ft",
      "rear_ft",
      "side_ft",
      "side_corner_ft",
      "max_height_ft",
      "max_lot_coverage_pct",
      "max_impervious_pct",
    ] as const) {
      expect(p[f]!.not_specified, f).toBe(true);
    }
    expect(p.front_ft!.quote).toMatch(/limited district-based property development standards/);
  });

  it("the Industrial district's missing height standard is not_specified with the G7 sentinel", () => {
    const table = getSetbackTable("martindale-tx")!;
    const ind = table.districts.find((d) => d.district_name.startsWith("I Industrial"))!;
    const p = ind.provenance as unknown as Prov;
    expect(p.max_height_ft!.not_specified).toBe(true);
    expect(ind.max_height_ft).toBe(999);
    expect(p.max_height_ft!.quote).toMatch(/states NO height standard/);
  });

  it("R-2's mis-drafted cross-reference is preserved in the quote rather than silently corrected", () => {
    const table = getSetbackTable("martindale-tx")!;
    const r2 = table.districts.find((d) => d.district_name.startsWith("R-2"))!;
    const p = r2.provenance as unknown as Prov;
    expect(p.side_corner_ft!.quote).toMatch(/DRAFTING ERROR IN THE SOURCE, PRESERVED/);
    expect(p.side_corner_ft!.quote).toMatch(/R-1A district/);
    expect(p.side_corner_ft!.confidence).toBeLessThan(0.85);
  });
});
