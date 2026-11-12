/**
 * Jarrell setback table (P-258 lane-f; re-verified 2026-11-12 against the City's own eCode360 download).
 *
 * Jarrell's dimensional standards are the UDC's Table 4-11 (Lot Design
 * Standards), Sec. 4.11.03.E. The values were first read through a third-party
 * mirror; on 2026-11-12 they were re-read from the City's own eCode360 JA6361
 * downloads (sha256s in the table's note) and all 75 matched, so the table now
 * carries primary-source-verified provenance. These tests pin that state, the
 * ETJ non-binding clause, the residential-adjacency figures, the absent-coverage
 * rows and the PUD district that Table 4-11 deliberately does not carry.
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

  it("is sourced from the City's own download, with hashes, and no mirror", () => {
    const note = getSetbackTable("jarrell-tx")!.note!;
    expect(note).toMatch(/eCode360/);
    expect(note).toMatch(/JA6361/);
    expect(note).toMatch(/26618dead18213dea19d703b0bf2767b2ed688cca959d96255c26368ed8cb16d/);
    expect(note).toMatch(/dabf1af33e5189a3f4db8ccc722d051a274d0023ae36c50e03d0ddaacd1ad406/);
    expect(note).not.toMatch(/zoneomics/i);
    for (const d of getSetbackTable("jarrell-tx")!.districts) {
      for (const p of Object.values(d.provenance ?? {}) as { verification_state: string; confidence: number; section_number: string }[]) {
        expect(p.verification_state).toBe("primary-source-verified");
        expect(p.confidence).toBeGreaterThan(0.75);
        expect(p.section_number).toBe("Sec. 4.11.03.E, Table 4-11");
      }
    }
  });

  it("pins every Table 4-11 value for all 15 districts", () => {
    // code: [front, side, rear, corner, height]
    const official: Record<string, number[]> = {
      AG: [50, 50, 50, 50, 35], "SF-1": [20, 10, 20, 15, 35], "SF-2": [20, 5, 10, 10, 35],
      "SF-3": [20, 0, 5, 5, 40], "MF-1": [15, 10, 10, 15, 35], "MF-2": [15, 20, 10, 20, 45],
      MH: [25, 10, 10, 20, 35], "C-1": [15, 5, 0, 15, 40], "C-2": [15, 5, 0, 15, 60],
      "C-3": [25, 15, 15, 25, 90], MU: [15, 15, 10, 15, 90], BP: [25, 10, 10, 25, 60],
      "I-1": [25, 10, 10, 25, 60], "I-2": [25, 15, 10, 25, 60], PF: [25, 10, 10, 10, 60],
    };
    for (const d of getSetbackTable("jarrell-tx")!.districts) {
      const code = d.district_name.split(" ")[0]!;
      expect([d.front_ft, d.side_ft, d.rear_ft, d.side_corner_ft, d.max_height_ft], code).toEqual(official[code]);
    }
  });

  it("does not pass off the ETJ guideline or the adjacency buffers as plain district minima", () => {
    const table = getSetbackTable("jarrell-tx")!;
    expect(table.note).toMatch(/non-binding guidelines in the ETJ/);
    const c1 = table.districts.find((d) => d.district_name.startsWith("C-1"))!;
    const p = c1.provenance as unknown as Prov;
    expect(p.rear_ft!.quote).toMatch(/Min. Rear Setback Adjacent to Residential/);
    expect(p.rear_ft!.quote).toMatch(/: 20 feet/);
    expect(p.side_ft!.quote).toMatch(/Min. Side Setback Adjacent to Residential", column C-1: 15 feet/);
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
    expect(table.note).toMatch(/not_specified/);
  });

  it("records that the PUD district is outside Table 4-11 by design", () => {
    const table = getSetbackTable("jarrell-tx")!;
    expect(table.note).toMatch(/routes to the PUD refusal/);
    expect(table.note).toMatch(/Sec\. 4\.08\.01\.D/);
    expect(table.note).toMatch(/Sec\. 3\.07\.05/);
    expect(
      table.districts.some((d) => /PUD|Planned Unit/i.test(d.district_name)),
    ).toBe(false);
  });
});
