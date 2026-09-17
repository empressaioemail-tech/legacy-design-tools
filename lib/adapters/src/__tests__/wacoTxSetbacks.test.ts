/**
 * Waco, TX setback table -- P-258 lane-b (2026-09-16), the district-miss
 * fill on the existing CTX-B (2026-09-07) port.
 *
 * That port shipped 5 of the 21 zoning codes the City of Waco's own GIS
 * layer carries (R-E, R-1A, R-1B, R-1C, R-2). This lane added the other 16
 * (R-3A..R-3E, O-1..O-3, C-1..C-5, M-1..M-3) from Code of Ordinances
 * Chapter 28 Article IV Divisions 7-22, and left the five pre-existing rows
 * untouched. As with Belton/Seguin/Cibolo, no code-section atom corpus
 * exists for waco_tx, so every value makes no atom claim and the
 * real proof is running the actual acceptance gate against the table with
 * an empty atom corpus -- not just that the JSON parses.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import {
  SETBACK_NUMERIC_FIELDS,
  runSetbackGate,
  TRANSCRIPTION_READ,
  type GatedSetbackTable,
} from "../local/setbacks/gate.js";

/** The 16 rows this lane added: [front, rear, side, side_corner, height, cov, impervious]. */
const ADDED: Record<string, [number, number, number, number, number, number, number]> = {
  "R-3A": [25, 25, 5, 15, 35, 100, 75],
  "R-3B": [25, 25, 5, 15, 35, 100, 75],
  "R-3C": [25, 25, 5, 15, 35, 100, 75],
  "R-3D": [25, 25, 5, 15, 45, 100, 75],
  "R-3E": [25, 25, 5, 15, 999, 100, 75],
  "O-1": [25, 25, 5, 15, 35, 100, 85],
  "O-2": [25, 25, 5, 15, 999, 100, 85],
  "O-3": [15, 25, 5, 15, 35, 100, 85],
  "C-1": [20, 0, 0, 10, 35, 100, 90],
  "C-2": [20, 0, 0, 10, 35, 100, 90],
  "C-3": [10, 0, 0, 10, 60, 100, 90],
  "C-4": [0, 0, 0, 0, 999, 100, 100],
  "C-5": [10, 0, 0, 10, 60, 100, 90],
  "M-1": [35, 35, 15, 15, 45, 100, 90],
  "M-2": [25, 0, 0, 10, 90, 100, 90],
  "M-3": [25, 0, 0, 10, 999, 100, 90],
};

/** Codes whose ordinance section states no height limit -> canonical sentinel. */
const NO_HEIGHT_LIMIT = ["R-3E", "O-2", "C-4", "M-3"];

function row(code: string) {
  const table = getSetbackTable("waco-tx")!;
  const district = table.districts.find((d) => d.district_name.startsWith(`${code} `))!;
  expect(district, `no row for ${code}`).toBeTruthy();
  return district as unknown as GatedSetbackTable["districts"][number];
}

describe("waco-tx", () => {
  it("routes and carries all 21 codes the City of Waco zoning layer stamps", () => {
    const table = getSetbackTableForZoning("waco-tx", "C-3")!;
    expect(table.jurisdictionKey).toBe("waco-tx");
    expect(table.districts).toHaveLength(21);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus for waco_tx)", () => {
    const table = getSetbackTable("waco-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("carries each added district's ordinance scalars", () => {
    for (const [code, expected] of Object.entries(ADDED)) {
      const d = row(code);
      expect(
        [d.front_ft, d.rear_ft, d.side_ft, d.side_corner_ft, d.max_height_ft, d.max_lot_coverage_pct, d.max_impervious_pct],
        code,
      ).toEqual(expected);
    }
  });

  it("gives every added value a full provenance entry, transcription-read (P-299: read through a copy)", () => {
    for (const code of Object.keys(ADDED)) {
      const prov = row(code).provenance!;
      expect(prov, code).toBeTruthy();
      for (const field of SETBACK_NUMERIC_FIELDS) {
        const p = prov[field];
        expect(p, `${code}/${field}`).toBeTruthy();
        expect(typeof p!.section_number, `${code}/${field}`).toBe("string");
        expect(p!.section_number.length, `${code}/${field}`).toBeGreaterThan(0);
        expect(p!.quote.length, `${code}/${field}`).toBeGreaterThan(0);
        expect(p!.confidence, `${code}/${field}`).toBeGreaterThan(0);
        expect(p!.confidence, `${code}/${field}`).toBeLessThanOrEqual(1);
        expect(p!.verification_state, `${code}/${field}`).toBe(TRANSCRIPTION_READ);
      }
    }
  });

  it("sentinels the four districts whose ordinance states no height limit (999, not a fabricated number)", () => {
    for (const code of NO_HEIGHT_LIMIT) {
      const d = row(code);
      expect(d.max_height_ft, code).toBe(999);
      expect(d.provenance!.max_height_ft!.not_specified, code).toBe(true);
      expect(d.provenance!.max_height_ft!.quote, code).toMatch(/no height limit/i);
    }
    // The other twelve added districts carry a real feet-based cap.
    for (const code of Object.keys(ADDED)) {
      if (NO_HEIGHT_LIMIT.includes(code)) continue;
      expect(row(code).provenance!.max_height_ft!.not_specified, code).toBeUndefined();
    }
  });

  it("codes section 28-216's site-coverage cap to max_impervious_pct, and C-4's express exclusion as the sentinel", () => {
    expect(row("C-3").max_impervious_pct).toBe(90);
    expect(row("M-2").max_impervious_pct).toBe(90);
    expect(row("O-1").max_impervious_pct).toBe(85);
    expect(row("R-3A").max_impervious_pct).toBe(75);
    // C-4 is the district section 28-216 names as an exception.
    expect(row("C-4").max_impervious_pct).toBe(100);
    expect(row("C-4").provenance!.max_impervious_pct!.not_specified).toBe(true);
    // No building-footprint-only coverage scalar exists for any of them.
    for (const code of Object.keys(ADDED)) {
      expect(row(code).max_lot_coverage_pct, code).toBe(100);
      expect(row(code).provenance!.max_lot_coverage_pct!.not_specified, code).toBe(true);
    }
  });

  it("preserves the conditional exceptions verbatim rather than folding them into the scalar", () => {
    expect(row("C-3").provenance!.side_ft!.quote).toMatch(
      /abutting an R-1 or R-2 district shall not be less than 25 feet/,
    );
    expect(row("M-1").provenance!.max_height_ft!.quote).toMatch(/120 feet/);
    expect(row("M-1").provenance!.max_height_ft!.quote).toMatch(/200,000 square feet/);
    expect(row("O-1").provenance!.side_ft!.quote).toMatch(/abutting an R-1 or R-2 district/);
    expect(row("R-3A").provenance!.side_corner_ft!.quote).toMatch(/less than 75 feet in width/);
    expect(row("C-5").provenance!.max_height_ft!.quote).toMatch(/five stories or 75 feet/);
  });

  it("keeps O-2's non-standard section 28-904 cross-reference on the record, not silently corrected", () => {
    const quote = row("O-2").provenance!.side_corner_ft!.quote;
    expect(quote).toMatch(/28-904\(c\)/);
    expect(quote).toMatch(/codification quirk/i);
  });

  it("cites the authoritative instrument (Municode) on every added row, never the dead elaws host (P-258 lane-b correction, 2026-09-16)", () => {
    for (const code of Object.keys(ADDED)) {
      const url = row(code).citation_url;
      expect(url, code).toMatch(/^https:\/\/library\.municode\.com\/tx\/waco/);
      expect(url, code).not.toMatch(/elaws\.us/);
    }
    // ...and the note states the corrected citation chain and the currency gap.
    const note = getSetbackTable("waco-tx")!.note;
    expect(note).toMatch(/CORRECTED 2026-09-16/);
    expect(note).toMatch(/THE CURRENCY DATE WAS NOT READ AT SOURCE/);
    expect(note).toMatch(/MUNICODE RETURNED HTTP 403 TO A PLAIN AUTOMATED FETCH/);
  });

  it("keeps the five pre-existing rows' own citation and does not disturb them", () => {
    const unchanged: Record<string, [number, number, number, number, number]> = {
      "R-E": [35, 50, 25, 15, 35],
      "R-1A": [30, 30, 10, 15, 35],
      "R-1B": [25, 25, 5, 15, 35],
      "R-1C": [25, 25, 6, 15, 35],
      "R-2": [25, 25, 5, 15, 35],
    };
    for (const [code, expected] of Object.entries(unchanged)) {
      const d = row(code);
      expect([d.front_ft, d.rear_ft, d.side_ft, d.side_corner_ft, d.max_height_ft], code).toEqual(expected);
    }
    // ...and the extension is recorded in the table's own note.
    expect(getSetbackTable("waco-tx")!.note).toMatch(/EXTENDED 2026-09-16/);
  });

  it("resolves through the jurisdiction-key helper as well as the zoning router", () => {
    const table = getSetbackTableForZoning("waco_tx", "M-2")!;
    expect(table.jurisdictionKey).toBe("waco-tx");
    const m2 = table.districts.find((d) => d.district_name.startsWith("M-2 "))!;
    expect(m2.max_height_ft).toBe(90);
  });
});
