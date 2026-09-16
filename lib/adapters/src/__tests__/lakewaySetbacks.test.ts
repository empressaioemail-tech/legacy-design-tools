/**
 * Lakeway, TX setback table (P-258 lane-e, no-table half, researched
 * 2026-09-16).
 *
 * Source: City of Lakeway Code of Ordinances, Ch. 30 Zoning, Article 30.03
 * "Zoning Use Regulations" (§ 30.03.001 – § 30.03.023), read at
 * https://ecode360.com/39617034. That article page DOES render its full
 * section text and flattened setback blocks to a plain fetch, so no print
 * endpoint or browser render was needed for this one.
 *
 * Lakeway matters because it is the one lane-e city that already HAS a staged
 * zoning layer: 8,202 of its 8,259 census parcels carry a district stamp and
 * zero carried a setback value, so this table is the whole of the gap. No
 * code-section atom corpus exists for this jurisdiction, so every value is
 * primary-source-verified.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

describe("lakeway-tx", () => {
  it("routes and carries all 22 codified districts", () => {
    const table = getSetbackTableForZoning("lakeway-tx", "R-1")!;
    expect(table).not.toBeNull();
    expect(table.jurisdictionKey).toBe("lakeway-tx");
    expect(table.districts).toHaveLength(22);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("lakeway-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("every value is primary-source-verified and cites the article's section", () => {
    const table = getSetbackTable("lakeway-tx")!;
    for (const d of table.districts) {
      for (const [field, entry] of Object.entries(d.provenance ?? {})) {
        expect(entry.verification_state, `${d.district_name}.${field}`).toBe(
          "primary-source-verified",
        );
        expect(entry.section_number, `${d.district_name}.${field}`).toMatch(/^30\.03\./);
      }
    }
  });

  it("codes the R-1 side yard at the base 5 ft. and keeps the golf-course conditional", () => {
    const table = getSetbackTable("lakeway-tx")!;
    const r1 = table.districts.find((d) => d.district_name.startsWith("R-1 and R-1*"))!;
    expect(r1.front_ft).toBe(25);
    expect(r1.side_ft).toBe(5);
    expect(r1.max_height_ft).toBe(32);
    expect(r1.provenance!.side_ft!.quote).toMatch(/golf course 25/);
  });

  it("refuses to flatten the tiered C-1 setbacks into one number", () => {
    const table = getSetbackTable("lakeway-tx")!;
    const c1 = table.districts.find((d) => d.district_name.startsWith("C-1"))!;
    // The smallest-footprint, nonresidential-abutting column is codified...
    expect(c1.side_ft).toBe(10);
    expect(c1.rear_ft).toBe(40);
    // ...and the other three columns are quoted, not dropped.
    expect(c1.provenance!.side_ft!.quote).toMatch(/50,000 and greater/);
    expect(c1.provenance!.side_ft!.quote).toMatch(/100/);
    expect(c1.provenance!.side_ft!.quote).toMatch(/TIERED SETBACKS/);
  });

  it("codes C-4's perimeter rule as an honest gap rather than forcing it into a yard slot", () => {
    const table = getSetbackTable("lakeway-tx")!;
    const c4 = table.districts.find((d) => d.district_name.startsWith("C-4"))!;
    expect(c4.front_ft).toBe(999);
    expect(c4.side_ft).toBe(999);
    expect(c4.rear_ft).toBe(999);
    expect(c4.max_height_ft).toBe(37);
    expect(c4.max_impervious_pct).toBe(40);
    expect(c4.provenance!.front_ft!.not_specified).toBe(true);
    expect(c4.provenance!.front_ft!.quote).toMatch(/perimeter/i);
  });

  it("records the MMC corner-lot side yard as the one real corner figure in the table", () => {
    const table = getSetbackTable("lakeway-tx")!;
    const mmc = table.districts.find((d) => d.district_name.startsWith("MMC"))!;
    expect(mmc.side_corner_ft).toBe(20);
    expect(mmc.side_corner_ft).not.toBe(999);
    // MMC's height was not stated in the dimensional subsections read, and is
    // recorded as a gap rather than borrowed from another district.
    expect(mmc.max_height_ft).toBe(999);
    expect(mmc.provenance!.max_height_ft!.not_specified).toBe(true);
  });

  it("marks P-1 and P-2 as honest absences: the sections carry no setback subsection", () => {
    const table = getSetbackTable("lakeway-tx")!;
    for (const prefix of ["P-1", "P-2"]) {
      const d = table.districts.find((x) => x.district_name.startsWith(prefix))!;
      expect(d.front_ft, prefix).toBe(999);
      expect(d.provenance!.front_ft!.quote).toMatch(/no "Minimum building setbacks" subsection/);
      expect(d.max_height_ft, prefix).toBe(32);
    }
  });

  it("omits PUD, VPCO and GB deliberately, with the reason in the note", () => {
    const table = getSetbackTable("lakeway-tx")!;
    const names = table.districts.map((d) => d.district_name);
    expect(names.some((n) => /\bPUD\b/.test(n))).toBe(false);
    expect(names.some((n) => /VPCO/.test(n))).toBe(false);
    expect(names.some((n) => /\bGB\b/.test(n))).toBe(false);
    expect(table.note).toMatch(/PUD is expressly a negotiated district/);
  });

  it("names the amending ordinance that dates the text, read at source", () => {
    const table = getSetbackTable("lakeway-tx")!;
    expect(table.note).toMatch(/2026-06-15-02/);
    expect(table.districts[0].citation_url).toBe("https://ecode360.com/39617034");
  });
});
