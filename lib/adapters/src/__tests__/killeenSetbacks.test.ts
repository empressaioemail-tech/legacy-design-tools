/**
 * Killeen setback table (SETBACK TABLE OWED gap fill, researched 2026-09-06,
 * corrected 2026-09-07). Unlike Belton/Seguin/Cibolo, a real code-section
 * atom corpus already exists for Killeen
 * (killeen_tx/killeen-development-regulations-current-supplement/*) --
 * confirmed live against the real atoms store, not assumed from a nonzero
 * count. Round-tripping the original research's quotes against the real
 * bodyText (fetched live, read-only session) surfaced two real
 * transcription errors, now corrected (see killeen-tx.json's own note for
 * the full record): R-1 front_ft/side_ft and SF-2 front_ft were coded
 * wrong. The ATOMS fixture below is the real bodyText captured directly
 * from that live query (trimmed, not paraphrased) for every section this
 * table cites, so this test proves the corrected file actually round-trips
 * against the real corpus content -- not a synthetic stand-in.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable, type SourceAtom } from "../local/setbacks/gate.js";

const PREFIX = "killeen_tx/killeen-development-regulations-current-supplement/";

// Real bodyText, fetched live 2026-09-07 from the real atoms store
// (entity_type='code-section'), trimmed to the operative yard/height
// paragraphs. Not synthesized -- this is what the real corpus contains.
const REAL_ATOMS: SourceAtom[] = [
  {
    entityId: `${PREFIX}31-173`,
    sectionNumber: "31-173",
    bodyText:
      'No structure shall be erected in a district "A-R1" agricultural single-family residential district having a height in excess of forty-five (45) feet, or three (3)',
  },
  {
    entityId: `${PREFIX}31-174`,
    sectionNumber: "31-174",
    bodyText:
      '(a) Size of yards. The size of yards in the district "A-R1" agricultural single-family residential district shall be as follows: (1) Front yards. There shall be a front yard having a depth of not less than thirty (30) feet. (2) Side yards. There shall be a side yard on each side of the lot having a width of not less than twenty (20) feet. A side yard adjacent to a side street shall not be less than twenty-five (25) feet. (3) Rear yards. There shall be a rear yard having a depth of not less than forty (40) feet.',
  },
  {
    entityId: `${PREFIX}31-180`,
    sectionNumber: "31-180",
    bodyText:
      'No structure shall be erected in a "SR-1" suburban residential single-family district having a height in excess of thirty-five (35) feet, or two and one-half (2½) stories.',
  },
  {
    entityId: `${PREFIX}31-181`,
    sectionNumber: "31-181",
    bodyText:
      '(a) Size of yards. The size of yards in the "SR-1" suburban residential single-family district shall be as follows: (1) Front yards. There shall be a front yard having a depth of not less than twenty-five (25) feet. (2) Side yards. There shall be a minimum of twenty (20) feet between structures on adjacent lots, with a minimum side yard of ten (10) feet. No side yard for allowable nonresidential uses shall be less than twenty-five (25) feet. (3) Rear yards. There shall be a rear yard having a depth of not less than twenty-five (25) feet.',
  },
  {
    entityId: `${PREFIX}31-185-3`,
    sectionNumber: "31-185-3",
    bodyText:
      'No structure shall be erected in a "SR-2" suburban residential single-family district having a height in excess of three (3) stories.',
  },
  {
    entityId: `${PREFIX}31-185-4`,
    sectionNumber: "31-185-4",
    bodyText:
      '(a) Size of yards. The size of yards in the "SR-2" suburban residential single-family district shall be as follows: (1) Front yards. There shall be a front yard having a depth of not less than thirty-five (35) feet. (2) Side yards. There shall be a minimum side yard of ten (10) feet. A side yard adjacent to a side street shall not be less than twenty (20) feet. No side yard for allowable nonresidential uses shall be less than twenty-five (25) feet. (3) Rear yards. There shall be a rear yard having a depth of not less than ten (10) feet.',
  },
  {
    entityId: `${PREFIX}31-187`,
    sectionNumber: "31-187",
    bodyText:
      'No building in a district "R-1" single-family residential district shall exceed thirty-five (35) feet or two and one-half (2½) stories in height.',
  },
  {
    entityId: `${PREFIX}31-188`,
    sectionNumber: "31-188",
    bodyText:
      '(a) Size of yards. The yards in the district "R-1" single-family residential district shall conform to the following: (1) Front yard. There shall be a front yard having a depth of not less than twenty (20) feet. Where lots have double frontage running through from one (1) street to another, the required front yard shall be provided on both streets. No parking shall be allowed within the required front yard. (2) Side yard. There shall be a side yard on each side of the lot having a width of not less than five (5) feet. A side yard adjacent to a side street shall not be less than fifteen (15) feet. Rear yard. There shall be a rear yard having a depth of not less than twenty-five (25) feet measured from the centerline of the easement as in the subdivision ordinance.',
  },
  {
    entityId: `${PREFIX}31-194`,
    sectionNumber: "31-194",
    bodyText:
      'No building in the "SF-2" single-family residential district shall exceed thirty-five (35) feet or two and one-half (2½) stories in height.',
  },
  {
    entityId: `${PREFIX}31-195`,
    sectionNumber: "31-195",
    bodyText:
      '(b) Size of yards. The yards in the "SF-2" single-family residential district shall conform to the following: (1) Front yard. There shall be a front yard having a depth of not less than twenty (20) feet. Where lots have double frontage running through from one street to another, the required front yard shall be provided on both streets. (2) Side yard. There shall be a side yard on each side of the lot having a width of not less than five (5) feet. A side yard adjacent to a side street shall not be less than fifteen (15) feet. (3) Rear yard. There shall be a rear yard having a depth of not less than twenty (20) feet.',
  },
];

describe("killeen-tx", () => {
  it("routes and carries all 5 codified districts", () => {
    const table = getSetbackTableForZoning("killeen-tx", "R-1")!;
    expect(table.jurisdictionKey).toBe("killeen-tx");
    expect(table.districts).toHaveLength(5);
  });

  it("passes the acceptance gate against the real atom corpus with zero blocks", () => {
    const table = getSetbackTable("killeen-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: REAL_ATOMS });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("R-1's corrected front_ft/side_ft match the real ordinance text (not the original research's wrong values)", () => {
    const table = getSetbackTable("killeen-tx")!;
    const r1 = table.districts.find((d) => d.district_name.startsWith("R-1"))!;
    expect(r1.front_ft).toBe(20); // was miscoded 25
    expect(r1.side_ft).toBe(5); // was miscoded 7
    expect(r1.side_corner_ft).toBe(15);
    expect(r1.rear_ft).toBe(25);
  });

  it("SF-2's corrected front_ft matches the real ordinance text", () => {
    const table = getSetbackTable("killeen-tx")!;
    const sf2 = table.districts.find((d) => d.district_name.startsWith("SF-2"))!;
    expect(sf2.front_ft).toBe(20); // was miscoded 25
    expect(sf2.rear_ft).toBe(20);
    expect(sf2.side_ft).toBe(5);
  });

  it("would have BLOCKED on G5 before the correction (proves the fixture is real, not a rubber stamp)", () => {
    const table = getSetbackTable("killeen-tx") as unknown as GatedSetbackTable;
    const clone = structuredClone(table);
    const r1 = clone.districts.find((d) => d.district_name.startsWith("R-1"))!;
    r1.front_ft = 25; // the original (wrong) research value
    r1.provenance!.front_ft!.quote =
      "Front yard. There shall be a front yard having a depth of not less than twenty-five (25) feet.";
    const report = runSetbackGate({ table: clone, atoms: REAL_ATOMS });
    expect(report.counts.block).toBeGreaterThan(0);
    expect(
      report.results.some((r) => r.rule === "G5" && r.level === "block" && r.field === "front_ft"),
    ).toBe(true);
  });

  it("SR-2's stories-only height is honestly not_specified (confirmed: the real section states no feet value)", () => {
    const table = getSetbackTable("killeen-tx")!;
    const sr2 = table.districts.find((d) => d.district_name.startsWith("SR-2"))!;
    const p = (sr2 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_height_ft!.not_specified).toBe(true);
  });
});
