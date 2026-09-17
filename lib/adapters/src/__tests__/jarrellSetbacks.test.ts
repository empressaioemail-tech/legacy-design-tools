/**
 * Jarrell setback table (P-258 lane-f, researched 2026-09-16).
 *
 * Jarrell's dimensional standards are the UDC's Table 4-11 (Lot Design
 * Standards), reached through eCode360 (JA6361), the platform the 2026-08-04
 * scrape decision moved to the engineering track. eCode360's section body is
 * client-rendered and could not be extracted from this lane, so the quotes come
 * from the Zoneomics mirror of the same text -- a fact the table's note states
 * and these tests pin, along with the ETJ non-binding clause, the two
 * residential-adjacency columns, the absent-coverage rows and the PUD district
 * that Table 4-11 deliberately does not carry.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

type Prov = GatedSetbackTable["districts"][number]["provenance"];

describe("jarrell-tx", () => {
  it("routes and carries all 15 Table 4-11 districts", () => {
    const table = getSetbackTableForZoning("jarrell-tx", "SF-1")!;
    expect(table.jurisdictionKey).toBe("jarrell-tx");
    expect(table.districts).toHaveLength(15);
    expect(table.districts.map((d) => d.district_name.split(" ")[0])).toEqual([
      "AG",
      "SF-1",
      "SF-2",
      "SF-3",
      "MF-1",
      "MF-2",
      "MH",
      "C-1",
      "C-2",
      "C-3",
      "MU",
      "BP",
      "I-1",
      "I-2",
      "PF",
    ]);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("jarrell-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("reads Table 4-11's numbers and its 2024 amendment date", () => {
    const table = getSetbackTable("jarrell-tx")!;
    expect(table.effectiveDate).toBe("2024-02-06");
    const sf1 = table.districts.find((d) => d.district_name.startsWith("SF-1"))!;
    expect(sf1.front_ft).toBe(20);
    expect(sf1.side_ft).toBe(10);
    expect(sf1.side_corner_ft).toBe(15);
    expect(sf1.max_height_ft).toBe(35);
    const ag = table.districts.find((d) => d.district_name.startsWith("AG"))!;
    expect(ag.front_ft).toBe(50);
    expect(ag.side_ft).toBe(50);
    const c3 = table.districts.find((d) => d.district_name.startsWith("C-3"))!;
    expect(c3.max_height_ft).toBe(90);
  });

  it("keeps source zeros as zeros", () => {
    const table = getSetbackTable("jarrell-tx")!;
    const sf3 = table.districts.find((d) => d.district_name.startsWith("SF-3"))!;
    expect(sf3.side_ft).toBe(0);
    const c2 = table.districts.find((d) => d.district_name.startsWith("C-2"))!;
    expect(c2.rear_ft).toBe(0);
  });

  it("states the route limits: eCode360 is authoritative, the mirror supplied the quotes", () => {
    const note = getSetbackTable("jarrell-tx")!.note!;
    expect(note).toMatch(/eCode360/);
    expect(note).toMatch(/JA6361/);
    expect(note).toMatch(/zoneomics\.com\/code\/jarrell-TX\/chapter_4/);
    expect(note).toMatch(/client-rendered/);
  });

  it("does not pass off the ETJ guideline or the adjacency buffers as plain district minima", () => {
    const table = getSetbackTable("jarrell-tx")!;
    expect(table.note).toMatch(/nonbinding guidelines for development in the ETJ/);
    const c1 = table.districts.find((d) => d.district_name.startsWith("C-1"))!;
    const p = c1.provenance as unknown as Prov;
    expect(p.rear_ft!.quote).toMatch(/Min. Rear Setback Adjacent to Residential/);
    expect(p.rear_ft!.quote).toMatch(/is 20 feet/);
    // residential districts state no adjacency column, so their quotes carry none
    const sf2 = table.districts.find((d) => d.district_name.startsWith("SF-2"))!;
    expect(sf2.provenance!.side_ft!.quote).not.toMatch(/Adjacent to Residential/);
  });

  it("leaves coverage not_specified with the sentinel instead of inventing a limit", () => {
    const table = getSetbackTable("jarrell-tx")!;
    for (const d of table.districts) {
      expect(d.max_impervious_pct).toBe(100);
      expect(d.max_lot_coverage_pct).toBe(100);
      expect(d.provenance!.max_impervious_pct!.not_specified).toBe(true);
      expect(d.provenance!.max_lot_coverage_pct!.not_specified).toBe(true);
    }
    expect(table.note).toMatch(/Chapter 6\.00/);
  });

  it("records that the PUD district is outside Table 4-11 by design", () => {
    const table = getSetbackTable("jarrell-tx")!;
    expect(table.note).toMatch(/routes to the PUD refusal/);
    expect(
      table.districts.some((d) => /PUD|Planned Unit/i.test(d.district_name)),
    ).toBe(false);
  });
});
