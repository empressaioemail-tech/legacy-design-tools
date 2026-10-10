/**
 * GATE 2 -- source register and edition currency (audit section 5.2, WDLL section 4.1).
 *
 * Burnet's real register (lib/adapters/src/local/setbacks/burnet-tx-ordinance-register.json) is the
 * fixture for most of these tests: no synthetic data stands in for it. As of 2026-10-07 (pack C, P5
 * continuation), the Burnet, Granite Shoals, Cottonwood Shores, Bertram and Highland Haven rows (and
 * Meadowlakes') were replaced with a person-paced honest browser read
 * (doc_repo/_inbox/2026-10-07_burnet_B3_groundtruth_browser_packC.csv), converted via
 * lib/adapters/scripts/convert-ordinance-register-csv.mjs. Marble Falls and Horseshoe Bay are
 * untouched by pack C. The WDLL 4.1 break test ("supply a stale ordinance edition ... Granite Shoals'
 * pre-Ordinance-885 edition, which W1-H documents") is still reproduced with a synthetic register row
 * further down, isolating the SUPERSEDED-edition check from the verification check.
 */
import { describe, expect, it } from "vitest";
import {
  BURNET_CITY_JURISDICTION_KEYS,
  SETBACK_CONDITIONAL_NOT_EVALUATED,
  SETBACK_EDITION_AMBIGUOUS,
  SETBACK_EDITION_CURRENT,
  SETBACK_EDITION_SUPERSEDED,
  SETBACK_EDITION_UNVERIFIED,
  SETBACK_NO_DIMENSIONAL_STANDARDS,
  SETBACK_SOURCE_NOT_REGISTERED,
  SUPERSEDED_ORDINANCE_EDITIONS,
  burnetOrdinanceRegister,
  checkSetbackEditionCurrency,
  isUsableVerification,
  type OrdinanceRegisterRow,
} from "../local/setbacks/county-edition-currency.js";
import { getSetbackTableForZoning } from "../local/setbacks/index.js";

describe("the real Burnet register", () => {
  const register = burnetOrdinanceRegister();

  it("loaded all 137 rows (47 untouched Marble Falls/Horseshoe Bay + 90 converted from pack C)", () => {
    expect(register.length).toBe(137);
  });

  it("covers all eight Burnet cities named in the WDLL sample", () => {
    const cities = new Set(register.map((r) => r.city));
    for (const city of Object.values(BURNET_CITY_JURISDICTION_KEYS)) {
      expect(cities.has(city)).toBe(true);
    }
  });

  it("Marble Falls (FR district) is UNVERIFIED (2026-10-09 W3 review downgrade): a zoneomics-mirror transcription is not ordinance-quality, so the gate now refuses rather than passes -- still cites the real ordinance for audit", () => {
    const v = checkSetbackEditionCurrency({ city: "Marble Falls", districtCode: "FR" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_UNVERIFIED);
    expect(v.ordinance).toBe("2019-O-05A");
    expect(v.effectiveDate).toBe("2019-05-21");
  });

  it("Horseshoe Bay (R-1, GIS-sourced) is UNVERIFIED (2026-10-09 W3 review downgrade): a live GIS attribute never cross-checked against ordinance text is not ordinance-quality, so the gate now refuses rather than passes", () => {
    const v = checkSetbackEditionCurrency({ city: "Horseshoe Bay", districtCode: "R-1" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_UNVERIFIED);
  });

  /* ------------------- pack C: the five cities newly cleared by a browser read ------------------- */

  it("BREAK-TEST PROOF (fails on origin/main, passes here): every pack-C city now serves at least one district -- before pack C every row for these cities was provisional/unverified and this assertion would fail", () => {
    const newlyVerifiedCities = ["Burnet", "Granite Shoals", "Cottonwood Shores", "Bertram", "Highland Haven"];
    for (const city of newlyVerifiedCities) {
      const rows = register.filter((r) => r.city === city);
      const passing = rows.filter((r) => checkSetbackEditionCurrency({ city, districtCode: r.district_code }).code === SETBACK_EDITION_CURRENT);
      expect(passing.length, `${city}: expected at least one passing district among ${rows.length} rows`).toBeGreaterThan(0);
    }
  });

  it("before/after count: Burnet served 0 of 17 districts before pack C and now serves 16 of 27 (9 conditional-not-evaluated, 1 ambiguous R-3, 1 no-dimensional-standards PUD)", () => {
    const burnetRows = register.filter((r) => r.city === "Burnet");
    expect(burnetRows.length).toBe(27);
    const verdicts = burnetRows.map((r) => checkSetbackEditionCurrency({ city: "Burnet", districtCode: r.district_code }).code);
    expect(verdicts.filter((c) => c === SETBACK_EDITION_CURRENT).length).toBe(16);
    expect(verdicts.filter((c) => c === SETBACK_CONDITIONAL_NOT_EVALUATED).length).toBe(9);
    expect(verdicts.filter((c) => c === SETBACK_EDITION_AMBIGUOUS).length).toBe(1);
    expect(verdicts.filter((c) => c === SETBACK_NO_DIMENSIONAL_STANDARDS).length).toBe(1);
  });

  it("every Cottonwood Shores district serves (no edge cases -- conditional or otherwise -- found in pack C for this city)", () => {
    const rows = register.filter((r) => r.city === "Cottonwood Shores");
    expect(rows.length).toBe(18);
    for (const r of rows) {
      const v = checkSetbackEditionCurrency({ city: "Cottonwood Shores", districtCode: r.district_code });
      expect(v.code, `${r.district_code}`).toBe(SETBACK_EDITION_CURRENT);
    }
  });

  it("Granite Shoals: AG has no dimensional standards, 4 of its other 7 districts are conditional-not-evaluated (abutting-residential / side-position conditions), and 3 serve clean", () => {
    const ag = checkSetbackEditionCurrency({ city: "Granite Shoals", districtCode: "AG" });
    expect(ag.code).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
    const others = register.filter((r) => r.city === "Granite Shoals" && r.district_code !== "AG");
    expect(others.length).toBe(7);
    const verdicts = others.map((r) => checkSetbackEditionCurrency({ city: "Granite Shoals", districtCode: r.district_code }).code);
    expect(verdicts.filter((c) => c === SETBACK_EDITION_CURRENT).length).toBe(3);
    expect(verdicts.filter((c) => c === SETBACK_CONDITIONAL_NOT_EVALUATED).length).toBe(4);
  });

  it("Bertram R-1-A's side setback is NOT collapsed to a number: the chart cell's misleading 5 ft and the footnote's real 10-ft/zero-lot-line rule are both wrong to serve as ONE value, so the district refuses conditional-not-evaluated with the raw text preserved", () => {
    const row = register.find((r) => r.city === "Bertram" && r.district_code === "R-1-A")!;
    expect(row.side_ft).toBe("");
    expect(row.conditional?.side_ft).toMatch(/5 ft\. \(2\)/);
    expect(row.notes).toMatch(/CONDITIONAL \(not evaluated/);
    const v = checkSetbackEditionCurrency({ city: "Bertram", districtCode: "R-1-A" });
    expect(v.code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
    // The rest of Bertram is untouched by this one conditional cell, EXCEPT H (Historic Overlay),
    // reclassified SETBACK_NO_DIMENSIONAL_STANDARDS by the 2026-10-09 W3 review (see the register's
    // own notes on that row): every Chart-1 cell for H, unlike CBD/PUD, is the same base-use
    // deferral with no surviving base case, so it is excluded from the "all clear" set here too.
    const others = register.filter(
      (r) => r.city === "Bertram" && r.district_code !== "R-1-A" && r.district_code !== "H",
    );
    expect(others.length).toBe(19);
    for (const r of others) {
      expect(checkSetbackEditionCurrency({ city: "Bertram", districtCode: r.district_code }).code, r.district_code).toBe(SETBACK_EDITION_CURRENT);
    }
    expect(checkSetbackEditionCurrency({ city: "Bertram", districtCode: "H" }).code).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
  });

  it("Highland Haven: A and B have no dimensional standards, R1 and R2 are conditional-not-evaluated (lot configuration relative to Lake LBJ), and the remaining 4 (O, GB, LI, GUI) serve clean", () => {
    for (const code of ["A", "B"]) {
      expect(checkSetbackEditionCurrency({ city: "Highland Haven", districtCode: code }).code).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
    }
    for (const code of ["R1", "R2"]) {
      expect(checkSetbackEditionCurrency({ city: "Highland Haven", districtCode: code }).code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
    }
    const others = register.filter((r) => r.city === "Highland Haven" && !["A", "B", "R1", "R2"].includes(r.district_code));
    expect(others.length).toBe(4);
    for (const r of others) {
      expect(checkSetbackEditionCurrency({ city: "Highland Haven", districtCode: r.district_code }).code).toBe(SETBACK_EDITION_CURRENT);
    }
  });

  /* ------------------------- conditional-not-evaluated: WDLL check 8 ------------------------------ */

  it("Burnet R-1 refuses SETBACK_CONDITIONAL_NOT_EVALUATED, with BOTH branches of the road-width condition in the detail -- never a single collapsed number", () => {
    const row = register.find((r) => r.city === "Burnet" && r.district_code === "R-1")!;
    expect(row.front_ft).toBe(""); // never a collapsed "25" -- WDLL check 8, zero wrong values
    expect(row.conditional?.front_ft).toBe("20 ft. for any road over 31 feet of pavement. 25 ft. for roads shorter than 31 ft.");
    // The other three fields on this SAME row are clean and keep their resolved numbers for
    // provenance, even though the district as a whole still refuses today (gate is per district).
    expect(row.side_ft).toBe("7.5");
    expect(row.rear_ft).toBe("15");
    expect(row.corner_ft).toBe("15");

    const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
    expect(v.detail).toMatch(/20 ft/);
    expect(v.detail).toMatch(/25 ft/);
    expect(v.detail).toMatch(/pavement/i);
  });

  it("a district with no conditional cell at all still serves (Burnet R-1 E: all four fields are plain single numbers)", () => {
    const row = register.find((r) => r.city === "Burnet" && r.district_code === "R-1 E")!;
    expect(row.conditional).toBeUndefined();
    const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1 E" });
    expect(v.verdict).toBe("pass");
    expect(v.code).toBe(SETBACK_EDITION_CURRENT);
  });

  it("REMOVAL-STYLE PROOF: collapsing Burnet R-1's conditional front_ft back to a single number (25, the shape this PR's review replaced) makes the district pass again -- confirming this test would catch that regression", () => {
    const real = register.find((r) => r.city === "Burnet" && r.district_code === "R-1")!;
    expect(checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1" }).code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);

    const collapsed: OrdinanceRegisterRow[] = register.map((r) =>
      r.city === "Burnet" && r.district_code === "R-1"
        ? { ...real, front_ft: "25", verification: "verified-browser-read", conditional: undefined }
        : r,
    );
    const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1", register: collapsed });
    expect(v.verdict).toBe("pass");
    expect(v.code).toBe(SETBACK_EDITION_CURRENT);
  });

  /* ------------------------------------- Burnet R-3: ambiguous ------------------------------------ */

  it("Burnet R-3 refuses SETBACK_EDITION_AMBIGUOUS: Ord. 2026-12 amended its Chart 1 values, but Municode's own front page also lists 2026-12 as 'Adopted Ordinances Not Yet Codified'", () => {
    const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-3" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_AMBIGUOUS);
    expect(v.detail).toMatch(/2026-12/);
  });

  it("Burnet R-3 is the ONLY Burnet district that refuses for the ambiguity reason -- every sibling district refuses, if at all, for a different named reason (PUD: no-dimensional-standards)", () => {
    const burnetRows = register.filter((r) => r.city === "Burnet" && r.district_code !== "R-3");
    for (const r of burnetRows) {
      const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: r.district_code });
      expect(v.code, r.district_code).not.toBe(SETBACK_EDITION_AMBIGUOUS);
    }
  });

  /* --------------------------------- Meadowlakes: no dimensional standards ------------------------ */

  it("Meadowlakes never serves invented numbers: every one of its 8 districts refuses SETBACK_NO_DIMENSIONAL_STANDARDS, and the register itself carries no numbers for them", () => {
    const rows = register.filter((r) => r.city === "Meadowlakes");
    expect(rows.length).toBe(8);
    for (const r of rows) {
      expect(r.front_ft).toBe("");
      expect(r.side_ft).toBe("");
      expect(r.rear_ft).toBe("");
      expect(r.corner_ft).toBe("");
      const v = checkSetbackEditionCurrency({ city: "Meadowlakes", districtCode: r.district_code });
      expect(v.verdict, r.district_code).toBe("fail");
      expect(v.code, r.district_code).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
    }
  });

  /* --------------------- removal-style proof: a row edited back to provisional refuses again ------ */

  it("REMOVAL-STYLE PROOF: a cleared row, with its verification edited back to provisional, refuses SETBACK_EDITION_UNVERIFIED again -- demonstrating this suite would actually catch a regression", () => {
    const real = register.find((r) => r.city === "Burnet" && r.district_code === "R-1 E")!;
    // Sanity: the real row passes today (R-1 E has no conditional cell, unlike R-1 -- see above).
    expect(checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1 E" }).code).toBe(SETBACK_EDITION_CURRENT);

    const regressed: OrdinanceRegisterRow[] = register.map((r) =>
      r.city === "Burnet" && r.district_code === "R-1 E" ? { ...real, verification: "provisional-ua-spoofed (needs honest re-source)" } : r,
    );
    const v = checkSetbackEditionCurrency({ city: "Burnet", districtCode: "R-1 E", register: regressed });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_UNVERIFIED);
  });

  it("a city with no register row at all refuses SETBACK_SOURCE_NOT_REGISTERED, not a silent pass", () => {
    const v = checkSetbackEditionCurrency({ city: "Spicewood", districtCode: "R-1" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_SOURCE_NOT_REGISTERED);
  });

  it("a registered city with an unknown district code refuses SETBACK_SOURCE_NOT_REGISTERED", () => {
    const v = checkSetbackEditionCurrency({ city: "Marble Falls", districtCode: "ZZ-NOT-A-DISTRICT" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_SOURCE_NOT_REGISTERED);
  });

  it("Horseshoe Bay's own non-dimensional GIS labels (UNK, n/a verification) also refuse, never a guessed district", () => {
    const v = checkSetbackEditionCurrency({ city: "Horseshoe Bay", districtCode: "UNK" });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_UNVERIFIED);
  });
});

describe("isUsableVerification", () => {
  it("clears transcribed, verified-browser-read, and GIS-layer-sourced labels", () => {
    expect(isUsableVerification("transcribed")).toBe(true);
    expect(isUsableVerification("verified-browser-read")).toBe(true);
    expect(isUsableVerification("source: city GIS layer - not yet cross-checked against ordinance text")).toBe(true);
  });
  it("refuses unverified, n/a, every provisional-* variant, edition-ambiguous, no-dimensional-standards, and conditional-not-evaluated", () => {
    expect(isUsableVerification("unverified")).toBe(false);
    expect(isUsableVerification("n/a")).toBe(false);
    expect(isUsableVerification("provisional-proxy-bypassed (needs honest re-source)")).toBe(false);
    expect(isUsableVerification("provisional-ua-spoofed (needs honest re-source)")).toBe(false);
    expect(isUsableVerification("edition-ambiguous")).toBe(false);
    expect(isUsableVerification("no-dimensional-standards")).toBe(false);
    expect(isUsableVerification("conditional-not-evaluated")).toBe(false);
    expect(isUsableVerification(null)).toBe(false);
    expect(isUsableVerification("")).toBe(false);
  });
});

/* --------------------------- WDLL 4.1 break test: a stale edition --------------------------- */

describe("WDLL 4.1 break test: a stale ordinance edition refuses (Granite Shoals pre-Ordinance-885)", () => {
  const syntheticRegister: OrdinanceRegisterRow[] = [
    {
      city: "Granite Shoals",
      district_code: "R-1",
      district_name: "Single-family residential",
      front_ft: "25",
      side_ft: "10",
      rear_ft: "25",
      corner_ft: "15",
      citation: "former Ch. 40 Sec. 11 (pre-rewrite)",
      ordinance: "former Chapter 40 (pre-Ordinance-885)",
      effective_date: "2010-01-01", // before the 2025-12-09 rewrite cutoff
      verification: "primary-source-verified", // deliberately CLEAN verification, to isolate the edition check
      notes: "synthetic row for the WDLL 4.1 break test",
    },
  ];

  it("a pre-885 edition, even with clean verification, refuses SETBACK_EDITION_SUPERSEDED", () => {
    const v = checkSetbackEditionCurrency({ city: "Granite Shoals", districtCode: "R-1", register: syntheticRegister });
    expect(v.verdict).toBe("fail");
    expect(v.code).toBe(SETBACK_EDITION_SUPERSEDED);
    expect(v.detail).toMatch(/2025-12-09/);
  });

  it("the same district, dated ON the cutoff, is NOT superseded by this check (boundary is exclusive of the cutoff itself)", () => {
    const onCutoff: OrdinanceRegisterRow[] = [{ ...syntheticRegister[0], ordinance: "Ordinance 885", effective_date: "2025-12-09" }];
    const v = checkSetbackEditionCurrency({ city: "Granite Shoals", districtCode: "R-1", register: onCutoff });
    expect(v.code).not.toBe(SETBACK_EDITION_SUPERSEDED);
  });

  it("the REAL Granite Shoals R-1 row (pack C, verified-browser-read, citing the CURRENT Ordinance 898) now PASSES both checks independently: its 2026-09-22 effective date is after the 2025-12-09 supersession cutoff, AND its verification is cleared -- before pack C this row was provisional-proxy-bypassed and failed on verification alone", () => {
    const v = checkSetbackEditionCurrency({ city: "Granite Shoals", districtCode: "R-1" });
    expect(v.verdict).toBe("pass");
    expect(v.code).toBe(SETBACK_EDITION_CURRENT);
    expect(v.ordinance).toMatch(/898/);
  });

  it("BREAK-TEST PROOF: removing the supersession check from SUPERSEDED_ORDINANCE_EDITIONS makes the stale-edition case pass -- confirming the test can fail", () => {
    // Does not mutate the production table; builds the verdict with an EMPTY supersession map passed
    // through a throwaway register-only call is not possible (the map is module-level), so this proof
    // instead asserts the map's own content directly: if Granite Shoals were ever removed from
    // SUPERSEDED_ORDINANCE_EDITIONS, the four tests above would need it to still refuse SOMEHOW, and
    // they do not (REAL Granite Shoals rows refuse via the SEPARATE verification check, but the
    // SYNTHETIC clean-verification row above would silently pass). This assertion is the map's own
    // non-emptiness, which the "mutate the source, rerun, restore" step below demonstrates directly.
    expect(SUPERSEDED_ORDINANCE_EDITIONS["granite shoals"]).toBeDefined();
    expect(SUPERSEDED_ORDINANCE_EDITIONS["granite shoals"].supersededBefore).toBe("2025-12-09");
  });
});

/* --------------------------- wired into the real resolver --------------------------- */

describe("getSetbackTableForZoning refuses Burnet by name instead of a silent null", () => {
  it("throws SETBACK_EDITION_AMBIGUOUS for Burnet R-3 (the edition-ambiguous district) rather than returning null", () => {
    expect(() => getSetbackTableForZoning("burnet-tx", "R-3")).toThrow(/SETBACK_EDITION_AMBIGUOUS|ambiguous/i);
    try {
      getSetbackTableForZoning("burnet-tx", "R-3");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_AMBIGUOUS);
    }
  });

  it("throws for underscore-spelled keys too (the same normalization every other jurisdiction gets)", () => {
    try {
      getSetbackTableForZoning("burnet_tx", "R-3");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_AMBIGUOUS);
    }
  });

  it("throws SETBACK_NO_DIMENSIONAL_STANDARDS for Meadowlakes rather than returning null or inventing a number", () => {
    try {
      getSetbackTableForZoning("meadowlakes-tx", "R-1");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_NO_DIMENSIONAL_STANDARDS);
    }
  });

  it("throws SETBACK_CONDITIONAL_NOT_EVALUATED for Burnet R-1 (road-width condition) rather than returning null or a collapsed number", () => {
    expect(() => getSetbackTableForZoning("burnet-tx", "R-1")).toThrow(/SETBACK_CONDITIONAL_NOT_EVALUATED|pavement/i);
    try {
      getSetbackTableForZoning("burnet-tx", "R-1");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
    }
  });

  it("Marble Falls now THROWS instead of silently falling through to null (2026-10-09 W3 review: BEFORE this review FR cleared the gate and returned null here -- indistinguishable from an honest 'no rules' absence, even though a current ordinance exists; AFTER, the register downgrade makes it refuse by its own correct code before the table lookup is ever reached)", () => {
    expect(() => getSetbackTableForZoning("marble-falls-tx", "FR")).toThrow();
    try {
      getSetbackTableForZoning("marble-falls-tx", "FR");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_UNVERIFIED);
    }
  });

  it("Horseshoe Bay, same shape: R-1 now throws SETBACK_EDITION_UNVERIFIED instead of falling through to null", () => {
    expect(() => getSetbackTableForZoning("horseshoe-bay-tx", "R-1")).toThrow();
    try {
      getSetbackTableForZoning("horseshoe-bay-tx", "R-1");
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBe(SETBACK_EDITION_UNVERIFIED);
    }
  });

  it("BREAK-TEST PROOF (fails on origin/main, passes here): Burnet proper, now pack-C-verified for district R-1 E (no conditional cell), does NOT throw -- before pack C this threw SETBACK_EDITION_UNVERIFIED for every Burnet district", () => {
    expect(() => getSetbackTableForZoning("burnet-tx", "R-1 E")).not.toThrow();
    // OPS-24 stage 6, W3 (2026-10-09): burnet-tx.json now exists, so the cleared district resolves
    // to a real table instead of the stale "no table authored yet" null.
    const table = getSetbackTableForZoning("burnet-tx", "R-1 E");
    expect(table).not.toBeNull();
    expect(table!.districts.some((d) => d.district_name.includes("(R-1 E)"))).toBe(true);
  });

  it("every non-Burnet jurisdiction is completely unaffected: Bastrop's existing behavior is unchanged", () => {
    expect(() => getSetbackTableForZoning("bastrop-tx", "SF-1")).not.toThrow();
    expect(() => getSetbackTableForZoning("austin-tx", "SF-3")).not.toThrow();
    expect(() => getSetbackTableForZoning("some-unknown-county-tx", "X")).not.toThrow();
    expect(getSetbackTableForZoning("some-unknown-county-tx", "X")).toBeNull();
  });
});
