/**
 * P-258 lane-d, McLennan County batch 2 (researched 2026-09-16).
 *
 * Four McLennan County cities whose ordinances carry a real Euclidean
 * dimensional block: Hewitt (Appendix A Parts 5/6/7), Robinson (Zoning
 * Ordinance Article 6 district tables), Bellmead (Zoning Ordinance
 * Sections V-IX) and West (Zoning Ordinance Sec. 20 schedule).
 *
 * No code-section atom corpus exists for any of these four jurisdictions, so
 * every value is primary-source-verified rather than asserted/human-verified,
 * and every entry's quote is a verbatim fragment of what was actually read
 * (see each table file's own `note` for the read route, including which
 * authoritative source was attempted and failed).
 *
 * Real end-to-end proof, same shape as beltonSeguinCiboloSetbacks.test.ts:
 * run the actual acceptance gate against each table with an empty atom corpus
 * and confirm zero blocks, not merely that the JSON parses.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

const MCLENNAN: Array<[key: string, districts: number]> = [
  ["robinson-tx", 14],
  ["hewitt-tx", 11],
  ["bellmead-tx", 5],
  ["west-tx", 10],
  ["woodway-tx", 9],
  ["beverly-hills-tx", 4],
  ["moody-tx", 7],
  ["riesel-tx", 8],
];

describe("McLennan batch-2 setback tables (lane-d)", () => {
  for (const [key, count] of MCLENNAN) {
    it(`${key} registers, routes and carries its ${count} codified districts`, () => {
      const table = getSetbackTableForZoning(key, "SF-1");
      expect(table).not.toBeNull();
      expect(table!.jurisdictionKey).toBe(key);
      expect(table!.districts).toHaveLength(count);
    });

    it(`${key} passes the acceptance gate with zero blocks against an empty atom corpus`, () => {
      const table = getSetbackTable(key) as unknown as GatedSetbackTable;
      const report = runSetbackGate({ table, atoms: [] });
      expect(report.counts.block, JSON.stringify(report.results.filter((r) => r.level === "block"))).toBe(0);
      expect(report.passed).toBe(true);
      expect(report.gated).toBe(true);
    });

    it(`${key} claims no atom backing anywhere (no corpus exists for these jurisdictions)`, () => {
      const table = getSetbackTable(key) as unknown as GatedSetbackTable;
      for (const district of table.districts) {
        const prov = district.provenance as Record<string, { verification_state: string; atom_did?: string }>;
        for (const [field, entry] of Object.entries(prov)) {
          expect(entry.verification_state, `${district.district_name}.${field}`).toBe(
            "primary-source-verified",
          );
          expect(entry.atom_did, `${district.district_name}.${field}`).toBeUndefined();
        }
      }
    });
  }
});

describe("Hewitt's non-scalar cells are flagged, not invented", () => {
  it("R-1-G's coverage is not_specified with the drafting defect quoted", () => {
    const table = getSetbackTable("hewitt-tx")!;
    const r1g = table.districts.find((d) => d.district_name.startsWith("R-1-G"))!;
    const prov = (r1g as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(prov.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(prov.max_lot_coverage_pct!.quote).toMatch(/drafting defect/i);
  });

  it("R-1-G's height is the stated 37 ft 6 in, not a stories conversion", () => {
    const table = getSetbackTable("hewitt-tx")!;
    const r1g = table.districts.find((d) => d.district_name.startsWith("R-1-G"))!;
    expect(r1g.max_height_ft).toBe(37.5);
  });

  it("M's zero yards carry the R-district adjacency condition in the quote", () => {
    const table = getSetbackTable("hewitt-tx")!;
    const m = table.districts.find((d) => d.district_name === "M Industrial District")!;
    const prov = (m as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(m.front_ft).toBe(0);
    expect(prov.front_ft!.quote).toMatch(/abuts a lot in an R district/);
  });
});

describe("Bellmead's proportional yard rules are not coded as scalars", () => {
  it("R-2's side and rear yards are flagged and quote the proportion", () => {
    const table = getSetbackTable("bellmead-tx")!;
    const r2 = table.districts.find((d) => d.district_name.startsWith("R-2"))!;
    const prov = (r2 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(prov.side_ft!.not_specified).toBe(true);
    expect(prov.side_ft!.quote).toMatch(/ten \(10\) percent of the width of the lot/);
    expect(prov.rear_ft!.not_specified).toBe(true);
    expect(prov.rear_ft!.quote).toMatch(/twenty-five \(25\) percent of the depth of the lot/);
  });

  it("R-1A is absent rather than interpolated from R-1", () => {
    const table = getSetbackTable("bellmead-tx")!;
    expect(table.districts.some((d) => d.district_name.includes("R-1A"))).toBe(false);
    expect(table.note).toMatch(/R-1A/);
  });
});

describe("West's schedule gaps are sentinels, and its impervious figure is not a coverage cap", () => {
  it("every row carries a real impervious figure and a not_specified coverage figure", () => {
    const table = getSetbackTable("west-tx")!;
    for (const d of table.districts) {
      const prov = (d as unknown as GatedSetbackTable["districts"][number]).provenance!;
      expect(prov.max_impervious_pct!.not_specified, d.district_name).toBeUndefined();
      expect(prov.max_lot_coverage_pct!.not_specified, d.district_name).toBe(true);
      expect(prov.side_corner_ft!.not_specified, d.district_name).toBe(true);
    }
  });

  it("the schedule's 'Depends on Bldg. Ht.' cells are flagged, not read as 7 ft entitlements", () => {
    const table = getSetbackTable("west-tx")!;
    for (const name of ["C-2 General Commercial District", "M-1 Light Manufacturing/Industrial District"]) {
      const d = table.districts.find((x) => x.district_name === name)!;
      const prov = (d as unknown as GatedSetbackTable["districts"][number]).provenance!;
      expect(prov.side_ft!.not_specified, name).toBe(true);
      expect(prov.rear_ft!.not_specified, name).toBe(true);
      expect(prov.side_ft!.quote).toMatch(/Depends on Bldg\. Ht\./);
    }
  });
});

describe("Robinson's conditional height and coverage cells are preserved", () => {
  it("the industrial row keeps its graduated 45/90/170 ft envelope in the quote", () => {
    const table = getSetbackTable("robinson-tx")!;
    const ind = table.districts.find((d) => d.district_name === "I Industrial District")!;
    const prov = (ind as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(ind.max_height_ft).toBe(45);
    expect(prov.max_height_ft!.quote).toMatch(/170 feet in height/);
  });

  it("C-1's zero side yard keeps its 15 ft residential-adjacency condition in the quote", () => {
    const table = getSetbackTable("robinson-tx")!;
    const c1 = table.districts.find((d) => d.district_name === "C-1 Light Commercial District")!;
    const prov = (c1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(c1.side_ft).toBe(0);
    expect(prov.side_ft!.quote).toMatch(/15 ft\. min\. to Residential Use/);
  });

  it("AG's rear-half-of-lot coverage cell is flagged, not read as a percent-of-lot cap", () => {
    const table = getSetbackTable("robinson-tx")!;
    const ag = table.districts.find((d) => d.district_name.startsWith("AG "))!;
    const prov = (ag as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(prov.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(prov.max_lot_coverage_pct!.quote).toMatch(/50% for rear half of lot/);
  });
});
