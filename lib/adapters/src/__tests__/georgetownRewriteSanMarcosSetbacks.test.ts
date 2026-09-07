/**
 * Georgetown rewrite merge + San Marcos relabel (2026-09-07).
 *
 * Georgetown: the table's 3 original single-family districts (RE/RL/RS,
 * current code) were replaced with 4 districts from the adopted-but-not-
 * yet-effective UDC rewrite (effective 2026-11-01) -- a MERGE, not a
 * replacement: the 9 non-SF districts (still accurate under current law)
 * are preserved unchanged. No valid atom-corpus round trip exists for the
 * rewrite text (confirmed live: the real corpus only contains
 * currently-in-force text), so the 4 new districts are
 * primary-source-verified, not human-verified.
 *
 * San Marcos: same district set and same numeric values as before --
 * this was a relabeling-only fix (human-verified/asserted with fabricated
 * atom_did, predating gate.ts's primary-source-verified state -- san_marcos_tx
 * has zero real code-section atoms, live-confirmed). Landing gated on a
 * real, live GIS check (area-weighted, not raw polygon count) confirming
 * the covered current-code districts (SF-6 + SF-4.5) dominate the legacy
 * Chapter 9 system they supersede by roughly 14:1.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

describe("georgetown-tx (post-merge)", () => {
  it("carries all 13 districts: 9 preserved (current code) + 4 replaced (rewrite)", () => {
    const table = getSetbackTable("georgetown-tx")!;
    expect(table.districts).toHaveLength(13);
    const names = table.districts.map((d) => d.district_name);
    for (const preserved of ["TF Two-Family", "TH Townhouse", "MF-1 Low Density Multifamily", "MF-2 High Density Multifamily", "CN Neighborhood Commercial", "C-1 Local Commercial", "C-3 General Commercial", "OF Office", "IN Industrial"]) {
      expect(names).toContain(preserved);
    }
    for (const replaced of ["RE Residential Estate District", "RT Residential Traditional District", "RS Residential Suburban District", "RM Residential Mix District"]) {
      expect(names).toContain(replaced);
    }
    // The old pre-rewrite SF district names must not survive the merge.
    expect(names).not.toContain("RE Residential Estate");
    expect(names).not.toContain("RL Residential Low Density");
    expect(names).not.toContain("RS Residential Single-Family");
  });

  it("routes RS to the new rewrite district, not the old one", () => {
    const table = getSetbackTableForZoning("georgetown-tx", "RS")!;
    const rs = table.districts.find((d) => d.district_name.startsWith("RS"))!;
    expect(rs.district_name).toBe("RS Residential Suburban District");
    expect(rs.side_ft).toBe(5); // rewrite value, not the old code's 6
  });

  it("the 4 new districts are primary-source-verified with no atom_did (no valid round trip against a pre-rewrite-only corpus)", () => {
    const table = getSetbackTable("georgetown-tx") as unknown as GatedSetbackTable;
    for (const name of ["RE Residential Estate District", "RT Residential Traditional District", "RS Residential Suburban District", "RM Residential Mix District"]) {
      const d = table.districts.find((x) => x.district_name === name)!;
      for (const field of Object.keys(d.provenance!)) {
        const p = d.provenance![field as keyof typeof d.provenance]!;
        expect(p.verification_state).toBe("primary-source-verified");
        expect(p.atom_did).toBeUndefined();
      }
    }
  });

  it("the 4 new districts pass the acceptance gate with zero blocks (atoms: [] is the correct input for them, not the whole table)", () => {
    const full = getSetbackTable("georgetown-tx") as unknown as GatedSetbackTable;
    const newDistrictNames = new Set([
      "RE Residential Estate District",
      "RT Residential Traditional District",
      "RS Residential Suburban District",
      "RM Residential Mix District",
    ]);
    const onlyNew: GatedSetbackTable = {
      ...full,
      districts: full.districts.filter((d) => newDistrictNames.has(d.district_name)),
    };
    const report = runSetbackGate({ table: onlyNew, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("the 9 preserved districts still carry their pre-existing (out-of-scope) fabricated atom_did convention -- known, not fixed here per explicit instruction to keep them as-is", () => {
    const table = getSetbackTable("georgetown-tx") as unknown as GatedSetbackTable;
    const cn = table.districts.find((d) => d.district_name.startsWith("CN"))!;
    // Same fabricated "georgetown_tx/udc/<section>" convention that needed
    // fixing everywhere else tonight -- this one predates tonight's work
    // and is intentionally left alone per the merge instruction.
    expect(cn.provenance!.front_ft!.atom_did).toBe("georgetown_tx/udc/7.02.020");
    expect(cn.provenance!.front_ft!.verification_state).toBe("human-verified");
  });
});

describe("san-marcos-tx (post-relabel)", () => {
  it("carries the same 8 districts as before, same numeric values", () => {
    const table = getSetbackTableForZoning("san-marcos-tx", "SF-6")!;
    expect(table.districts).toHaveLength(8);
    const sf6 = table.districts.find((d) => d.district_name.startsWith("SF-6"))!;
    expect(sf6.front_ft).toBe(25);
  });

  it("every value is primary-source-verified with no atom_did (zero real atoms for this jurisdiction)", () => {
    const table = getSetbackTable("san-marcos-tx") as unknown as GatedSetbackTable;
    for (const d of table.districts) {
      for (const field of Object.keys(d.provenance!)) {
        const p = d.provenance![field as keyof typeof d.provenance]!;
        expect(p.verification_state).toBe("primary-source-verified");
        expect(p.atom_did).toBeUndefined();
      }
    }
  });

  it("passes the acceptance gate with zero blocks", () => {
    const table = getSetbackTable("san-marcos-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });
});
