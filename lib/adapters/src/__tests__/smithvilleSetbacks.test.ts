/**
 * Smithville setback table (P-258 lane-f, researched 2026-09-16).
 *
 * Smithville is one of CP1's two named traps: it falls under the eCode360
 * scrape ruling (_decisions/2026-08-04_ecode360_partnership_retired_scrape_posture.md),
 * so the acquisition route matters as much as the numbers. The route used is
 * recorded in the table's own note and asserted here: a live fetch of
 * https://ecode360.com/39658868 with the PublicLawTextFetcher UA profile,
 * byte-compared against the 2026-07-30 B1 eCode360 scrape artifact.
 *
 * No code-section atom corpus exists for smithville_tx, so every value is
 * primary-source-verified, and the acceptance gate is run with an empty atom
 * corpus to prove the table passes with zero blocks rather than merely parsing.
 */

import { describe, expect, it } from "vitest";
import { getSetbackTable, getSetbackTableForZoning } from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

type Prov = GatedSetbackTable["districts"][number]["provenance"];

describe("smithville-tx", () => {
  it("routes and carries all 16 dimensional districts of Sec. 2.2", () => {
    const table = getSetbackTableForZoning("smithville-tx", "SF-1")!;
    expect(table.jurisdictionKey).toBe("smithville-tx");
    expect(table.districts).toHaveLength(16);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const table = getSetbackTable("smithville-tx") as unknown as GatedSetbackTable;
    const report = runSetbackGate({ table, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("dates the instrument at source: Ordinance 2018-555, adopted 2018-10-16", () => {
    const table = getSetbackTable("smithville-tx")!;
    expect(table.effectiveDate).toBe("2018-10-16");
    expect(table.note).toMatch(/Ordinance 2018-555/);
    expect(table.note).toMatch(/Sec\. 14\.02\.001/);
  });

  it("records the eCode360 scrape route (UA profile, live re-verify, artifact cross-check)", () => {
    const table = getSetbackTable("smithville-tx")!;
    expect(table.note).toMatch(/eCODE360 SCRAPE RULING/);
    expect(table.note).toMatch(/PublicLawTextFetcher/);
    expect(table.note).toMatch(/2026-07-30T03:36:52\.351Z/);
    expect(table.note).toMatch(/Cloudflare 403/);
  });

  it("omits the planned-development and overlay districts instead of inventing rows for them", () => {
    const names = getSetbackTable("smithville-tx")!.districts.map((d) => d.district_name);
    expect(names.some((n) => /Planned Development/.test(n))).toBe(false);
    expect(names.some((n) => /Historic Overlay/.test(n))).toBe(false);
    expect(names.some((n) => /Historic Commercial Overlay/.test(n))).toBe(false);
    const note = getSetbackTable("smithville-tx")!.note!;
    expect(note).toMatch(/PDD \(2\.2\.16\)/);
    expect(note).toMatch(/HD \(2\.2\.18\) and HCD \(2\.2\.19\)/);
  });

  it("cites each district's own subsection, and the two self-references that prove the numbering", () => {
    const table = getSetbackTable("smithville-tx")!;
    const cbd = table.districts.find((d) => d.district_name.startsWith("CBD"))!;
    const cf = table.districts.find((d) => d.district_name.startsWith("CF"))!;
    expect(cbd.provenance?.front_ft?.section_number).toMatch(/2\.2\.11/);
    expect(cf.provenance?.front_ft?.section_number).toMatch(/2\.2\.15/);
  });

  it("CBD's 'Not required' front and side yards are coded 0 as a stated standard, not as a gap", () => {
    const table = getSetbackTable("smithville-tx")!;
    const cbd = table.districts.find((d) => d.district_name.startsWith("CBD"))!;
    const p = cbd.provenance as unknown as Prov;
    expect(cbd.front_ft).toBe(0);
    expect(cbd.side_ft).toBe(0);
    expect(p.front_ft!.not_specified).toBeUndefined();
    expect(p.front_ft!.quote).toMatch(/Not required/);
  });

  it("I and P, which state no yard standard at all, are not_specified rather than a permissive 0", () => {
    const table = getSetbackTable("smithville-tx")!;
    for (const prefix of ["I Industrial", "P Parks"]) {
      const d = table.districts.find((x) => x.district_name.startsWith(prefix))!;
      const p = d.provenance as unknown as Prov;
      for (const f of ["front_ft", "rear_ft", "side_ft"] as const) {
        expect(p[f]!.not_specified, `${prefix}.${f}`).toBe(true);
      }
    }
  });

  it("MH's site-plan-dependent yards are coded at reduced confidence with the alternative quoted", () => {
    const table = getSetbackTable("smithville-tx")!;
    const mh = table.districts.find((d) => d.district_name.startsWith("MH Manufactured"))!;
    const p = mh.provenance as unknown as Prov;
    expect(p.front_ft!.confidence).toBeLessThan(0.8);
    expect(p.front_ft!.quote).toMatch(/internal \(private\) street/);
  });

  it("PD-Z's combined two-unit side yard is not scalarised", () => {
    const table = getSetbackTable("smithville-tx")!;
    const pdz = table.districts.find((d) => d.district_name.startsWith("PD-Z"))!;
    const p = pdz.provenance as unknown as Prov;
    expect(p.side_ft!.not_specified).toBe(true);
    expect(p.side_ft!.quote).toMatch(/combined side yard/i);
  });

  it("no district claims a separate impervious standard the ordinance does not state", () => {
    const table = getSetbackTable("smithville-tx")!;
    for (const d of table.districts) {
      const p = d.provenance as unknown as Prov;
      expect(p.max_impervious_pct!.not_specified, d.district_name).toBe(true);
    }
  });
});
