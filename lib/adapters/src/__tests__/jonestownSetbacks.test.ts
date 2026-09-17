/**
 * Jonestown, TX setback table (P-258 lane-e, no-table half, researched
 * 2026-09-16). Source: City of Jonestown Development Code, Ch. 3 UDC
 * Sec. 3.1.1 charts (Ordinance 2025-O-650 adopted 1/9/2025), read through
 * eCode360's PRINT endpoint -- the ordinary article page renders no body text
 * or tables. No code-section atom corpus exists for this jurisdiction, so
 * every value is transcription-read (P-299: a copy of the instrument) rather
 * than asserted/human-verified.
 * End-to-end proof: run the real acceptance gate against the table with an
 * empty atom corpus and confirm zero blocks, not just that the JSON parses.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import {
  runSetbackGate,
  TRANSCRIPTION_READ,
  type GatedSetbackTable,
} from "../local/setbacks/gate.js";

describe("jonestown-tx", () => {
  it("routes and carries all 11 codified districts", () => {
    const table = getSetbackTableForZoning("jonestown-tx", "R-1")!;
    expect(table).not.toBeNull();
    expect(table.jurisdictionKey).toBe("jonestown-tx");
    expect(table.districts).toHaveLength(11);
  });

  it("resolves the underscore form of the key", () => {
    expect(getSetbackTable("jonestown_tx")?.jurisdictionKey).toBe("jonestown-tx");
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("jonestown-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("every value makes no atom claim (transcription-read since P-299; no atom corpus exists)", () => {
    const table = getSetbackTable("jonestown-tx")!;
    for (const d of table.districts) {
      for (const [field, entry] of Object.entries(d.provenance ?? {})) {
        expect(
          (entry as { verification_state: string }).verification_state,
          `${d.district_name}.${field}`,
        ).toBe(TRANSCRIPTION_READ);
      }
    }
  });

  it("codifies the general lot chart (3.1.1-1), not the public-sewer chart", () => {
    const table = getSetbackTable("jonestown-tx")!;
    const b1 = table.districts.find((d) => d.district_name.startsWith("B-1"))!;
    // 30 ft. is Chart 3.1.1-1's front setback; Chart 3.1.1-2 states 25 ft.
    // when the lot is on public sewer, and that alternate is quoted, not coded.
    expect(b1.front_ft).toBe(30);
    expect(b1.provenance!.front_ft!.quote).toMatch(/PUBLIC SEWER/);
  });

  it("refuses to resolve the commercial Note-1 side yard to a single number", () => {
    const table = getSetbackTable("jonestown-tx")!;
    const i1 = table.districts.find((d) => d.district_name.startsWith("I-1"))!;
    expect(i1.side_ft).toBe(999);
    expect(i1.provenance!.side_ft!.not_specified).toBe(true);
    expect(i1.provenance!.side_ft!.quote).toMatch(/25 feet minimum from O, B-1, B-2, I-1/);
    // I-1's rear yard is Note 2, a different dependency from the side's Note 1.
    expect(i1.rear_ft).toBe(999);
    expect(i1.provenance!.rear_ft!.quote).toMatch(/100 feet minimum with 6' fence/);
  });

  it("codes 40% impervious cover for residential districts and delegates the commercial ones to LCRA", () => {
    const table = getSetbackTable("jonestown-tx")!;
    const rr = table.districts.find((d) => d.district_name.startsWith("R-R"))!;
    expect(rr.max_impervious_pct).toBe(40);
    const o = table.districts.find((d) => d.district_name.startsWith("O "))!;
    expect(o.max_impervious_pct).toBe(999);
    expect(o.provenance!.max_impervious_pct!.not_specified).toBe(true);
    expect(o.provenance!.max_impervious_pct!.quote).toMatch(/Highland Lakes Watershed Ordinance Manual/);
  });

  it("carries the 999 sentinel on every not_specified field so a dropped flag would FLAG, not pass", () => {
    const sentinelFields = ["side_ft", "rear_ft", "max_lot_coverage_pct", "max_impervious_pct"] as const;
    const table = getSetbackTable("jonestown-tx")!;
    for (const d of table.districts) {
      for (const f of sentinelFields) {
        if (d.provenance?.[f]?.not_specified) {
          expect(d[f], `${d.district_name}.${f}`).toBe(999);
        }
      }
    }
  });

  it("honestly omits RV and PUD (live district names with no dimensional row in any chart)", () => {
    const table = getSetbackTable("jonestown-tx")!;
    const names = table.districts.map((d) => d.district_name);
    expect(names.some((n) => /\bRV\b/.test(n))).toBe(false);
    expect(names.some((n) => /\bPUD\b/.test(n))).toBe(false);
    expect(table.note).toMatch(/RV \(Section 3\.1\.9\) and PUD/);
  });

  it("records the print-endpoint route, because a plain fetch of the article returns no table", () => {
    const table = getSetbackTable("jonestown-tx")!;
    expect(table.note).toMatch(/print\/JO6363\?guid=40446470/);
    expect(table.note).toMatch(/no dimensional standard at all/);
    expect(table.districts[0].citation_url).toBe("https://ecode360.com/print/JO6363?guid=40446470");
  });
});
