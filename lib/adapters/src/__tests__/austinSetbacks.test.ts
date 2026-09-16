/**
 * Austin (austin-tx) — P-258 lane-a rows, added 2026-09-16.
 *
 * The table already carried 9 rows (SF-1/2/3 + MF-1..MF-6, "asserted",
 * WDLL 51). This lane added 28 more rows covering the austin-tx
 * district-miss worklist (41,178 parcels), read from the Land Development
 * Code Chapter 25-2 Subchapter C §25-2-492 (Site Development Regulations)
 * Subsection (D) site development regulation table, on Municode
 * (library.municode.com/tx/austin — the code is "Codified through Ordinance
 * No. 20260122-059, effective February 2, 2026, Supp. No. 173"; the table's
 * own Source line ends "Ord. No. 20251023-063, Pt. 1, 11-3-25", the
 * amendment that gave CBD its 350 ft maximum height). Municode returns no
 * server-rendered text to a plain fetch, so the table was read from its
 * rendered DOM in a browser, cross-checked against a stale elaws.us mirror
 * of the same section.
 *
 * No code-section atom corpus is supplied for Austin here (the gate takes
 * its atom list from the caller; this suite supplies an empty one, exactly
 * as the Belton/Seguin/Cibolo suite does), so every new value is
 * `primary-source-verified`, never `asserted`/`human-verified`.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

/** Codes this lane added, largest parcel count first (lane priority order). */
const LANE_A_CODES = [
  "SF-4A",
  "CS",
  "SF-6",
  "GR",
  "LI",
  "RR",
  "P",
  "LO",
  "LA",
  "LR",
  "MH",
  "DR",
  "CBD",
  "GO",
  "DMU",
  "NO",
  "CS-1",
  "IP",
  "SF-5",
  "W/LO",
  "CH",
  "AV",
  "MI",
  "AG",
  "R&D",
  "CR",
  "L",
  "SF-4B",
];

/** Districts in the worklist that deliberately get NO row (see the table note). */
const NOT_A_ROW = ["TOD", "NBG", "ERC", "TND", "UNZ"];

/**
 * The 9 pre-existing rows. They are `asserted` with atom_dids that do not
 * resolve against the empty atom corpus this suite supplies (G2), and they
 * also flag `not_specified` on max_height_ft while carrying real heights
 * (G7) — so the gate blocks them: 9 x 7 G2 blocks + 9 G7 blocks = 72 on the
 * full table. That pre-existing gap is reported upward by this lane and
 * deliberately NOT touched here (the brief: do not disturb those rows); the
 * assertions below only pin that lane-a's own rows never block.
 */
const PRE_EXISTING_PREFIXES = ["SF-1", "SF-2", "SF-3", "MF-1", "MF-2", "MF-3", "MF-4", "MF-5", "MF-6"];

const NUMERIC_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_height_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

type GatedDistrict = GatedSetbackTable["districts"][number];

function austin() {
  const table = getSetbackTable("austin_tx");
  expect(table).not.toBeNull();
  expect(table!.jurisdictionKey).toBe("austin-tx");
  return table!;
}

function laneADistricts() {
  const codes = new Set(LANE_A_CODES);
  return austin().districts.filter((d) => codes.has(d.district_name.split(" ")[0] ?? ""));
}

function byCode(code: string) {
  const row = laneADistricts().find((d) => d.district_name.startsWith(`${code} `));
  expect(row, code).toBeDefined();
  return row!;
}

function prov(d: unknown) {
  return (d as GatedDistrict).provenance!;
}

const laneATable = (): GatedSetbackTable =>
  ({
    ...austin(),
    districts: laneADistricts() as unknown as GatedSetbackTable["districts"],
  }) as unknown as GatedSetbackTable;

describe("austin-tx — P-258 lane-a rows", () => {
  it("routes as a table (no Bastrop/Elgin-style special case) and carries 9 + 28 = 37 rows", () => {
    expect(getSetbackTableForZoning("austin-tx", "SF-4A")).toBe(getSetbackTable("austin-tx"));
    expect(austin().districts).toHaveLength(37);
    expect(laneADistricts()).toHaveLength(28);
  });

  it("carries every lane-a code exactly once", () => {
    const names = austin().districts.map((d) => d.district_name);
    for (const code of LANE_A_CODES) {
      expect(names.filter((n) => n.startsWith(`${code} `)), code).toHaveLength(1);
    }
  });

  it("gives the form-based / unzoned / em-dash codes NO invented row", () => {
    const names = austin().districts.map((d) => d.district_name);
    for (const code of NOT_A_ROW) {
      expect(names.some((n) => n.startsWith(`${code} `)), code).toBe(false);
    }
    // ...and says so, naming where those codes ARE governed, in the table note.
    expect(austin().note).toMatch(/Subchapter E/);
    expect(austin().note).toMatch(/UNZ is unzoned/);
    expect(austin().note).toMatch(/MH column/);
  });

  it("passes the acceptance gate with zero blocks across its own 28 rows (no atom corpus)", () => {
    const report = runSetbackGate({ table: laneATable(), atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
    // Every one of the 28 x 7 values is primary-source-verified, so G2 reports
    // its own honest category rather than resolving an atom.
    const g2 = report.results.filter((r) => r.rule === "G2");
    expect(g2).toHaveLength(28 * 7);
    expect(g2.every((r) => r.level === "pass")).toBe(true);
    // The only non-G3 flag is the informational "expectedDistricts not supplied".
    expect(report.results.filter((r) => r.level === "flag" && r.rule !== "G3")).toHaveLength(1);
  });

  it("flags exactly the three values outside the gate's sanity bands, and blocks none of them", () => {
    const report = runSetbackGate({ table: laneATable(), atoms: [] });
    const g3 = report.results.filter((r) => r.rule === "G3");
    expect(g3.every((r) => r.level === "flag")).toBe(true);
    // CBD's 350 ft maximum height is the Ord. 20251023-063 amendment (above the
    // gate's 300 ft band); AG's 100 ft side and street-side yards are the
    // ordinance's own §25-2-621(B) figures (above the 75 ft band). All three are
    // real codified values, so they FLAG for human review rather than being bent
    // into the band or hidden behind a not_specified flag.
    expect(g3.map((r) => `${r.district!.split(" ")[0]}/${r.field}`)).toEqual([
      "CBD/max_height_ft",
      "AG/side_ft",
      "AG/side_corner_ft",
    ]);
  });

  it("never blocks one of its own rows, even though the 9 pre-existing asserted rows do block", () => {
    const report = runSetbackGate({
      table: austin() as unknown as GatedSetbackTable,
      atoms: [],
    });
    const blockedDistricts = report.results
      .filter((r) => r.level === "block")
      .map((r) => r.district!);
    // 63 observed here: 9 pre-existing rows x 7 fields, all G2 "cited atom_did
    // not found in corpus" (those rows are `asserted` and the atom corpus is
    // empty). This repo's gate has no G7 rule; the copy ported into
    // hauska-setback-corpus does, and would add 9 more blocks there because
    // those same rows flag not_specified on max_height_ft while carrying a real
    // height. That is exactly why every not_specified height this lane writes is
    // the canonical 999 sentinel, never a real height.
    expect(blockedDistricts).toHaveLength(63);
    for (const district of blockedDistricts) {
      expect(
        PRE_EXISTING_PREFIXES.some((p) => district.startsWith(`${p} `)),
        `lane-a row ${district} must not block`,
      ).toBe(true);
    }
  });

  it("codes em-dash cells as canonical not_specified sentinels, and keeps every not_specified height at 999 (G7)", () => {
    for (const d of laneADistricts()) {
      const p = prov(d).max_height_ft!;
      if (p.not_specified) expect(d.max_height_ft, d.district_name).toBe(999);
    }
    // Whole-column em-dash districts (MH's entire column; AV and P, whose only
    // referral is a per-site or per-adjacent-district rule) stay honest gaps.
    for (const code of ["MH", "AV", "P"]) {
      expect(byCode(code)).toMatchObject({
        front_ft: 0,
        rear_ft: 0,
        side_ft: 0,
        side_corner_ft: 0,
        max_height_ft: 999,
        max_lot_coverage_pct: 100,
        max_impervious_pct: 100,
      });
      for (const f of NUMERIC_FIELDS) {
        expect(prov(byCode(code))[f]!.not_specified, `${code}.${f}`).toBe(true);
      }
    }
    // Partial em-dash rows: the dashes are gaps, the stated cells are real numbers.
    expect(byCode("DMU")).toMatchObject({ front_ft: 0, max_height_ft: 120, max_impervious_pct: 100 });
    expect(byCode("CS")).toMatchObject({ side_ft: 0, rear_ft: 0, max_height_ft: 60 });
    // DR's coverage cells are square-foot figures in the table, not percentages.
    expect(byCode("DR").max_lot_coverage_pct).toBe(100);
    expect(byCode("DR").max_impervious_pct).toBe(100);
    expect(prov(byCode("DR")).max_lot_coverage_pct!.quote).toMatch(/12,000/);
    expect(prov(byCode("DR")).max_impervious_pct!.quote).toMatch(/15,000/);
  });

  it("carries adjacency- and gradient-graded cells as flagged most-restrictive tiers, never as silent district-wide values", () => {
    const graded: Array<[string, (typeof NUMERIC_FIELDS)[number], number]> = [
      ["LI", "side_ft", 50],
      ["IP", "rear_ft", 50],
      ["R&D", "side_corner_ft", 100],
      ["AG", "max_lot_coverage_pct", 20],
      ["AG", "max_impervious_pct", 25],
      ["LA", "max_impervious_pct", 20],
    ];
    for (const [code, field, value] of graded) {
      const p = prov(byCode(code))[field]!;
      expect(byCode(code)[field], `${code}.${field}`).toBe(value);
      expect(p.not_specified, `${code}.${field}`).toBe(true);
      expect(p.confidence, `${code}.${field}`).toBeLessThanOrEqual(0.5);
      expect(p.quote.length, `${code}.${field}`).toBeGreaterThan(40);
    }
    expect(prov(byCode("LI")).side_ft!.quote).toMatch(/adjacency-graded/i);
    expect(prov(byCode("LA")).max_impervious_pct!.quote).toMatch(/gradient-graded/i);
    expect(prov(byCode("AG")).max_lot_coverage_pct!.quote).toMatch(/lesser of/);
    // CH's height IS graded by the site's impervious cover, but 60 ft is a real
    // tier: quoted, low-confidence, and deliberately NOT flagged not_specified —
    // gate G7 reserves that flag on max_height_ft for the 999 sentinel.
    const ch = prov(byCode("CH")).max_height_ft!;
    expect(ch.confidence).toBeLessThanOrEqual(0.5);
    expect(ch.not_specified).toBeUndefined();
    expect(ch.quote).toMatch(/graded by the site's impervious cover/);
  });

  it("carries per-value provenance with a section number, quote and confidence for all seven fields", () => {
    for (const d of laneADistricts()) {
      const p = prov(d);
      for (const f of NUMERIC_FIELDS) {
        expect(p[f], `${d.district_name}.${f}`).toBeTruthy();
        expect(p[f]!.verification_state, `${d.district_name}.${f}`).toBe("primary-source-verified");
        expect(p[f]!.quote.length, `${d.district_name}.${f}`).toBeGreaterThan(40);
        expect(p[f]!.section_number.length, `${d.district_name}.${f}`).toBeGreaterThan(0);
        expect(p[f]!.confidence, `${d.district_name}.${f}`).toBeGreaterThan(0);
        expect(p[f]!.confidence, `${d.district_name}.${f}`).toBeLessThanOrEqual(1);
        // No atom-backing claim may be made where no atom corpus is supplied.
        expect(p[f]!.atom_did, `${d.district_name}.${f}`).toBeUndefined();
      }
      expect(d.citation_url).toContain("library.municode.com");
      expect(d.citation_url).toContain("25-2-492");
    }
  });

  it("reads footnote-referred cells from the section the footnote names", () => {
    // SF-4A is not in the table as numbers at all (fn 4 -> 25-2-779).
    expect(prov(byCode("SF-4A")).front_ft!.section_number).toBe("25-2-779(D)(4)");
    expect(prov(byCode("SF-4A")).side_ft!.section_number).toBe("25-2-779(D)(6)");
    expect(prov(byCode("SF-4A")).max_impervious_pct!.section_number).toBe("25-2-779(D)(10)");
    // SF-4B (fn 5 -> 25-2-558).
    expect(prov(byCode("SF-4B")).front_ft!.section_number).toBe("25-2-558(I)(1)");
    expect(prov(byCode("SF-4B")).rear_ft!.section_number).toBe("25-2-558(K)");
    // IP/MI/LI (fn 13 -> 25-2-601 adjacency-graded yards), R&D (fn 14 -> 25-2-603),
    // AV (fn 15 -> 25-2-623), P (fn 17 -> 25-2-625), CH (fn 12 -> 25-2-582).
    expect(prov(byCode("LI")).side_ft!.section_number).toBe("25-2-601(B)");
    expect(prov(byCode("MI")).rear_ft!.section_number).toBe("25-2-601(B)");
    expect(prov(byCode("IP")).side_ft!.section_number).toBe("25-2-601(B)");
    expect(prov(byCode("R&D")).side_corner_ft!.section_number).toBe("25-2-603(G)(1)");
    expect(prov(byCode("AV")).front_ft!.section_number).toBe("25-2-623");
    expect(prov(byCode("P")).front_ft!.section_number).toBe("25-2-625");
    expect(prov(byCode("CH")).max_height_ft!.section_number).toBe("25-2-582(B)");
    // LA's impervious cover lives in the Lake Austin district regulations (fn 1).
    expect(prov(byCode("LA")).max_impervious_pct!.section_number).toBe("25-2-551(C)(2)");
  });

  it("carries the values the table actually states for the largest units", () => {
    // SF-4A (15,664 parcels): the small-lot dimensional standards of 25-2-779(D).
    expect(byCode("SF-4A")).toMatchObject({
      front_ft: 15,
      rear_ft: 5,
      side_ft: 3.5,
      side_corner_ft: 10,
      max_height_ft: 35,
      max_lot_coverage_pct: 55,
      max_impervious_pct: 65,
    });
    // CS (4,111 parcels): 10 ft front, 60 ft height, 95% coverage and impervious.
    expect(byCode("CS")).toMatchObject({
      front_ft: 10,
      side_corner_ft: 10,
      max_lot_coverage_pct: 95,
      max_impervious_pct: 95,
    });
    expect(byCode("SF-6")).toMatchObject({
      front_ft: 25,
      rear_ft: 10,
      side_ft: 5,
      side_corner_ft: 15,
      max_height_ft: 35,
    });
    // RR (2,917 parcels, Rural Residence — a real district, not a typo).
    expect(byCode("RR")).toMatchObject({
      front_ft: 40,
      rear_ft: 20,
      side_ft: 10,
      side_corner_ft: 25,
      max_lot_coverage_pct: 20,
    });
    // CBD's 350 ft maximum height is the 2025-11-03 amendment, quoted with it.
    expect(byCode("CBD").max_height_ft).toBe(350);
    expect(prov(byCode("CBD")).max_height_ft!.quote).toMatch(/20251023-063/);
  });

  it("keeps the conflict with the pre-existing MF-2/MF-3 front_ft rows visible instead of silently matching it", () => {
    // Pre-existing rows: 15 ft. The current §25-2-492(D) table says 25 ft for
    // both. Untouched by this lane, and called out in the table note.
    expect(austin().districts.find((d) => d.district_name.startsWith("MF-2 "))!.front_ft).toBe(15);
    expect(austin().districts.find((d) => d.district_name.startsWith("MF-3 "))!.front_ft).toBe(15);
    expect(austin().note).toMatch(/KNOWN CONFLICT NOT TOUCHED/);
  });

  it("keeps the reproduction route for the §25-2-492(D) read, because a plain fetch of the citation URL returns only the Municode shell", () => {
    // F-1 (wave planner, 2026-09-16T21:05Z): a citation a successor lane cannot
    // reproduce is the defect this assertion pins shut. The route was a browser
    // render of the Municode page, so the note must keep saying that plainly,
    // keep naming the plain-fetch limitation that reproduces it, and keep the
    // plain-fetch mirror labelled a corroborator rather than a citation.
    expect(austin().note).toMatch(/BROWSER RENDER/);
    expect(austin().note).toMatch(
      /a plain fetch of this URL returns only the Municode application shell/,
    );
    expect(austin().note).toMatch(/NO plain-fetch URL returns the CURRENT table/);
    expect(austin().note).toMatch(/PLAIN-FETCH CORROBORATOR, NOT A CITATION/);
    expect(austin().note).toMatch(/austin-tx\.elaws\.us/);
  });
});
