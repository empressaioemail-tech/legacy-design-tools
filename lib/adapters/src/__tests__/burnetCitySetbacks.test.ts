/**
 * Burnet County (48053) stage 6 city setback tables -- OPS-24, W3 (2026-10-09).
 *
 * Tables for the districts the ordinance register (burnet-tx-ordinance-register.json, LDT
 * #800) marks verified-browser-read / SETBACK_EDITION_CURRENT, built from the pack-C
 * person-paced browser read (doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv).
 * Before this table existed, a cleared Burnet district fell through getSetbackTableForZoning to a
 * silent null (see countyEditionCurrency.test.ts's prior "not-yet-done task" assertions); this
 * suite is the real end-to-end proof that the five served cities now resolve to a real, gated
 * table instead.
 *
 * No code-section atom corpus exists yet for any Burnet city, so every value here is
 * primary-source-verified (gate.ts's state for a value read directly off a primary source with
 * no atom to round-trip against) -- the same shape as belton-tx / seguin-tx / cibolo-tx.
 */
import { describe, expect, it } from "vitest";
import {
  getSetbackTable,
  getSetbackTableForZoning,
  assertTableVendoredForClearedVerdict,
  SETBACK_TABLE_ABSENT,
  SETBACK_EDITION_CURRENT,
  SETBACK_EDITION_UNVERIFIED,
  checkSetbackEditionCurrency,
  burnetOrdinanceRegister,
  type EditionCurrencyVerdict,
} from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

function gateReport(key: string) {
  const table = getSetbackTable(key) as unknown as GatedSetbackTable;
  return runSetbackGate({ table, atoms: [] });
}

describe("burnet-tx", () => {
  it("carries exactly the 16 districts the register clears (of 27 total)", () => {
    const table = getSetbackTable("burnet-tx")!;
    expect(table.districts).toHaveLength(16);
  });

  it("passes the acceptance gate with zero blocks (no atom corpus)", () => {
    const report = gateReport("burnet-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it("R-1 E (a clean, non-conditional row) carries the pack-C quoted numbers", () => {
    const table = getSetbackTable("burnet-tx")!;
    const r1e = table.districts.find((d) => d.district_name.includes("(R-1 E)"))!;
    expect(r1e.front_ft).toBe(30);
    expect(r1e.side_ft).toBe(15);
    expect(r1e.rear_ft).toBe(15);
    expect(r1e.side_corner_ft).toBe(15);
    expect(r1e.max_height_ft).toBe(30);
    expect(r1e.max_lot_coverage_pct).toBe(10);
  });

  it("district A's internally-ambiguous Chart 2 coverage (10% AND 40%) is not_specified, never a guessed number", () => {
    const table = getSetbackTable("burnet-tx")!;
    const a = table.districts.find((d) => d.district_name.includes("(A)"))!;
    expect(a.max_lot_coverage_pct).toBe(100); // canonical not_specified sentinel
    const p = (a as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/10%.*40%|ambiguous/i);
  });

  it("getSetbackTableForZoning resolves burnet-tx/R-1 E to the real table, not null", () => {
    const table = getSetbackTableForZoning("burnet-tx", "R-1 E");
    expect(table).not.toBeNull();
    expect(table!.districts.some((d) => d.district_name.includes("(R-1 E)"))).toBe(true);
  });

  it("the 11 refused Burnet districts (conditional / ambiguous / no-dimensional-standards) still throw and still get no row", () => {
    const table = getSetbackTable("burnet-tx")!;
    for (const code of ["R-1", "R-2", "R-2 A", "R-3", "R-6", "R-6-13", "M-1", "M-2", "NC", "C-3", "PUD"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
      expect(() => getSetbackTableForZoning("burnet-tx", code)).toThrow();
    }
  });
});

describe("granite-shoals-tx", () => {
  it("carries exactly the 3 districts the register clears (of 8 total)", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    expect(table.districts).toHaveLength(3);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("granite-shoals-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("R-1's word-number yards (\"not less than five/ten feet\") are coded to their numeric value", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    const r1 = table.districts.find((d) => d.district_name.includes("(R-1)"))!;
    expect(r1.front_ft).toBe(20);
    expect(r1.side_ft).toBe(5);
    expect(r1.rear_ft).toBe(5);
    expect(r1.side_corner_ft).toBe(10);
    expect(r1.max_height_ft).toBe(35);
    expect(r1.max_lot_coverage_pct).toBe(100); // not_specified -- no coverage cap stated
  });

  it("M-1's unstated height carries the canonical 999 sentinel, correctly flagged", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    const m1 = table.districts.find((d) => d.district_name.includes("(M-1)"))!;
    expect(m1.max_height_ft).toBe(999);
    const p = (m1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_height_ft!.not_specified).toBe(true);
  });

  it("the 5 refused Granite Shoals districts still get no row", () => {
    const table = getSetbackTable("granite-shoals-tx")!;
    for (const code of ["M-2", "GB-1", "GB-2", "I", "AG"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
    }
  });
});

describe("cottonwood-shores-tx", () => {
  it("carries all 18 districts (the register clears every one)", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    expect(table.districts).toHaveLength(18);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("cottonwood-shores-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("C-1's building/impervious split is coded into the two separate fields", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    const c1 = table.districts.find((d) => d.district_name.includes("(C-1)"))!;
    expect(c1.max_lot_coverage_pct).toBe(60);
    expect(c1.max_impervious_pct).toBe(70);
  });

  it("R-1's lot-size-tiered coverage schedule is not_specified rather than one guessed tier", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    const r1 = table.districts.find((d) => d.district_name.includes("(R-1)"))!;
    expect(r1.max_lot_coverage_pct).toBe(100);
    expect(r1.max_impervious_pct).toBe(100);
    const p = (r1 as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_lot_coverage_pct!.not_specified).toBe(true);
    expect(p.max_lot_coverage_pct!.quote).toMatch(/lot size|tier/i);
  });

  it("the PUD family's dual-zone height marker (\"****\") is not_specified, never the one-zone 25 ft", () => {
    const table = getSetbackTable("cottonwood-shores-tx")!;
    for (const code of ["PUD", "PUD - R", "PUD - M", "PUD - C", "CUD"]) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_height_ft, code).toBe(999);
    }
  });
});

describe("bertram-tx", () => {
  it("carries exactly the 19 districts the register clears (of 21 total; H reclassified SETBACK_NO_DIMENSIONAL_STANDARDS 2026-10-09)", () => {
    const table = getSetbackTable("bertram-tx")!;
    expect(table.districts).toHaveLength(19);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("bertram-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("R-1-A (the conditional side-yard district) still gets no row", () => {
    const table = getSetbackTable("bertram-tx")!;
    expect(table.districts.some((d) => d.district_name.includes("(R-1-A)"))).toBe(false);
  });

  it("R-4-1/2/3's main-vs-main-plus-accessory coverage codes the lower, main-only figure", () => {
    const table = getSetbackTable("bertram-tx")!;
    for (const code of ["R-4-1", "R-4-2", "R-4-3"]) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_lot_coverage_pct, code).toBe(40);
      expect(d.max_impervious_pct, code).toBe(100); // not_specified -- no distinct impervious stated
    }
  });

  it("CBD, whose Chart 1 yard cells are bare footnote references to the base-use district, carries not_specified yards -- never the footnote NUMBER read as feet -- but its own stated coverage split is coded", () => {
    const table = getSetbackTable("bertram-tx")!;
    const cbd = table.districts.find((d) => d.district_name.includes("(CBD)"))!;
    expect(cbd.front_ft).toBe(100);
    expect(cbd.side_ft).toBe(100);
    expect(cbd.rear_ft).toBe(100);
    expect(cbd.side_corner_ft).toBe(100);
    // CBD's coverage IS stated (main-vs-accessory split) even though its yards are deferred.
    expect(cbd.max_lot_coverage_pct).toBe(60);
  });

  it("H (Historic Overlay) is NOT in this table -- 2026-10-09 W3 review reclassified it SETBACK_NO_DIMENSIONAL_STANDARDS in the register (every Chart-1 cell for H, unlike CBD/PUD, is the same base-use deferral with no surviving base case)", () => {
    const table = getSetbackTable("bertram-tx")!;
    expect(table.districts.some((d) => d.district_name.includes("(H)"))).toBe(false);
    expect(() => getSetbackTableForZoning("bertram-tx", "H")).toThrow();
    try {
      getSetbackTableForZoning("bertram-tx", "H");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe("SETBACK_NO_DIMENSIONAL_STANDARDS");
    }
  });

  it("PUD's directly-stated corner yard (15 ft) and height (45 ft) are coded normally despite its deferred front/side/rear", () => {
    const table = getSetbackTable("bertram-tx")!;
    const pud = table.districts.find((d) => d.district_name.includes("(PUD)"))!;
    expect(pud.front_ft).toBe(100); // deferred to base-use district, footnote (9)
    expect(pud.side_corner_ft).toBe(15);
    expect(pud.max_height_ft).toBe(45);
  });
});

describe("highland-haven-tx", () => {
  it("carries exactly the 4 districts the register clears (of 8 total)", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    expect(table.districts).toHaveLength(4);
  });

  it("passes the acceptance gate with zero blocks", () => {
    const report = gateReport("highland-haven-tx");
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
  });

  it("GB/LI/GUI's abbreviated \"X% / Y%\" coverage is read as the SAME main-vs-accessory split as O's spelled-out figure, not a buildings/impervious split", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    const expected: Record<string, number> = { O: 50, GB: 60, LI: 50, GUI: 60 };
    for (const [code, cov] of Object.entries(expected)) {
      const d = table.districts.find((x) => x.district_name.includes(`(${code})`))!;
      expect(d.max_lot_coverage_pct, code).toBe(cov);
      expect(d.max_impervious_pct, code).toBe(100); // not_specified
    }
  });

  it("R1, R2, A and B (conditional / no-dimensional-standards) still get no row", () => {
    const table = getSetbackTable("highland-haven-tx")!;
    for (const code of ["R1", "R2", "A", "B"]) {
      expect(table.districts.some((d) => d.district_name.includes(`(${code})`)), code).toBe(false);
    }
  });
});

describe("Marble Falls, Horseshoe Bay and Meadowlakes remain untabled (separate task / see PR report)", () => {
  it("Meadowlakes has no served district at all, so every code still throws SETBACK_NO_DIMENSIONAL_STANDARDS", () => {
    expect(() => getSetbackTableForZoning("meadowlakes-tx", "R-1")).toThrow();
  });
});

/**
 * BEFORE / AFTER, 2026-10-09 W3 review of this PR -- the Marble Falls / Horseshoe Bay silent-null
 * gap. BEFORE (origin/main as of #805's first revision): Marble Falls' register marked most
 * districts "transcribed" and Horseshoe Bay's marked most "source: city GIS layer..."; both states
 * passed isUsableVerification, so checkSetbackEditionCurrency returned SETBACK_EDITION_CURRENT, and
 * getSetbackTableForZoning fell through `SETBACK_TABLES[normalized] ?? null` to a bare `null` --
 * indistinguishable from "no codified rules exist," which was false (a current ordinance DOES exist
 * for these districts; nobody had keyed its numbers in). AFTER (this revision): two independent
 * fixes close the gap from both directions --
 *   (1) the register downgrade below: neither source was ordinance-quality (a third-party mirror
 *       for Marble Falls, un-cross-checked GIS attributes for Horseshoe Bay), so both are now
 *       "unverified" and refuse SETBACK_EDITION_UNVERIFIED -- their OWN correct code -- before ever
 *       reaching the table lookup;
 *   (2) GATE 3 (SETBACK_TABLE_ABSENT, see index.ts) as a general backstop for the shape itself: ANY
 *       future cleared verdict with no vendored table -- not just these two cities, not just
 *       Burnet -- refuses by name instead of returning null. Demonstrated below with a synthetic
 *       verdict, since no real cleared-but-untabled row exists anymore today.
 */
describe("the Marble Falls / Horseshoe Bay silent-null gap (2026-10-09 W3 review)", () => {
  it("BEFORE/AFTER, real end-to-end: a Marble Falls parcel's ENZ.2 district used to resolve to a silent null and now throws SETBACK_EDITION_UNVERIFIED by name", () => {
    // AFTER: real call, no synthetic register -- this IS today's production behavior.
    expect(() => getSetbackTableForZoning("marble-falls-tx", "ENZ.2")).toThrow();
    try {
      getSetbackTableForZoning("marble-falls-tx", "ENZ.2");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_UNVERIFIED);
    }
    // BEFORE, reconstructed: the same district, with its verification value restored to the
    // pre-downgrade "transcribed" string the register carried before this review, clears the gate
    // and (since no table exists for marble-falls-tx) returns a bare null -- exactly the silent
    // shape this review closed. This does not mutate the real register; it passes a synthetic one.
    const realRow = burnetOrdinanceRegister().find(
      (r) => r.city === "Marble Falls" && r.district_code === "ENZ.2",
    )!;
    const beforeRegister = burnetOrdinanceRegister().map((r) =>
      r.city === "Marble Falls" && r.district_code === "ENZ.2"
        ? { ...realRow, verification: "transcribed" }
        : r,
    );
    const beforeVerdict = checkSetbackEditionCurrency({
      city: "Marble Falls",
      districtCode: "ENZ.2",
      register: beforeRegister,
    });
    expect(beforeVerdict.code).toBe(SETBACK_EDITION_CURRENT);
    // GATE 3 catches exactly this reconstructed "before" verdict and refuses by name instead of
    // falling through to null -- the second, general half of the fix.
    expect(() =>
      assertTableVendoredForClearedVerdict({
        normalizedJurisdictionKey: "marble-falls-tx",
        verdict: beforeVerdict,
        sourceLabel: "Marble Falls's ordinance register",
      }),
    ).toThrow();
  });

  it("Horseshoe Bay's downgrade is the same shape: a live-stamped district (R-1) now refuses SETBACK_EDITION_UNVERIFIED instead of resolving to null", () => {
    expect(() => getSetbackTableForZoning("horseshoe-bay-tx", "R-1")).toThrow();
    try {
      getSetbackTableForZoning("horseshoe-bay-tx", "R-1");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_UNVERIFIED);
    }
  });

  it("Horseshoe Bay's genuinely-non-dimensional GIS labels (n/a: MOR, LA, CA, UNK) were left untouched by the downgrade -- still n/a, still SETBACK_EDITION_UNVERIFIED", () => {
    const row = burnetOrdinanceRegister().find(
      (r) => r.city === "Horseshoe Bay" && r.district_code === "MOR",
    )!;
    expect(row.verification).toBe("n/a");
  });
});

/**
 * GATE 3 -- SETBACK_TABLE_ABSENT, the general mechanism. Unit-tested directly against
 * assertTableVendoredForClearedVerdict (rather than only through getSetbackTableForZoning) so the
 * three required shapes are each provable in isolation: cleared-but-untabled refuses with the new
 * code; a real tabled district still serves; a district the gate itself refuses keeps refusing with
 * ITS OWN code (GATE 3 never fires for it -- it is a no-op for every non-cleared verdict).
 */
describe("GATE 3 (SETBACK_TABLE_ABSENT) -- general, not Burnet-specific", () => {
  const clearedVerdict: EditionCurrencyVerdict = {
    verdict: "pass",
    code: SETBACK_EDITION_CURRENT,
    city: "Some Future County Town",
    districtCode: "R-9",
    detail: "Some Future County Town R-9 cites a real ordinance, verification \"verified-browser-read\".",
    ordinance: "Ord. 2099-01",
    effectiveDate: "2099-01-01",
    citation: "Ch. 1 Sec. 1",
    verification: "verified-browser-read",
  };

  it("a register-served jurisdiction with no vendored table refuses SETBACK_TABLE_ABSENT -- any jurisdiction key, not just a Burnet one", () => {
    expect(() =>
      assertTableVendoredForClearedVerdict({
        normalizedJurisdictionKey: "some-future-county-town-tx",
        verdict: clearedVerdict,
        sourceLabel: "Some Future County's ordinance register",
      }),
    ).toThrow(/SETBACK_TABLE_ABSENT|no SETBACK_TABLES entry/);
    try {
      assertTableVendoredForClearedVerdict({
        normalizedJurisdictionKey: "some-future-county-town-tx",
        verdict: clearedVerdict,
        sourceLabel: "Some Future County's ordinance register",
      });
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_TABLE_ABSENT);
    }
  });

  it("a jurisdiction that DOES have a vendored table is a no-op, even for the same cleared-verdict shape", () => {
    expect(() =>
      assertTableVendoredForClearedVerdict({
        normalizedJurisdictionKey: "burnet-tx",
        verdict: { ...clearedVerdict, city: "Burnet" },
        sourceLabel: "Burnet's ordinance register",
      }),
    ).not.toThrow();
  });

  it("a non-cleared verdict is a no-op regardless of table presence -- GATE 3 never overrides GATE 2's own refusal code", () => {
    const refusedVerdict: EditionCurrencyVerdict = {
      ...clearedVerdict,
      verdict: "fail",
      code: SETBACK_EDITION_UNVERIFIED,
    };
    expect(() =>
      assertTableVendoredForClearedVerdict({
        normalizedJurisdictionKey: "some-future-county-town-tx",
        verdict: refusedVerdict,
        sourceLabel: "Some Future County's ordinance register",
      }),
    ).not.toThrow();
  });
});
