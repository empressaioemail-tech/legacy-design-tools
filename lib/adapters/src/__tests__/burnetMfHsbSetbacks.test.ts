/**
 * Burnet County (48053) pack E -- Marble Falls and Horseshoe Bay setbacks from official ordinance
 * text (OPS-24 stage 6, 2026-10-13).
 *
 * Source: doc_repo/_inbox/2026-10-13_burnet_B3_groundtruth_browser_packE.csv (Marble Falls from
 * Municode, every table value script-checked against the live tables; Horseshoe Bay from eCode360
 * Ch. 14 Art. 14.02, every value cell string-matched against the live text), converted by
 * lib/adapters/scripts/apply-packE-to-burnet-register.mjs.
 *
 * These are the only two Burnet cities with zoning stamped on parcels. Before pack E every stamped
 * code in both refused SETBACK_EDITION_UNVERIFIED (LDT #805 downgraded the zoneomics-mirror and
 * GIS-attribute rows). The tests below fail on origin/main: marble-falls-tx has no table there, and
 * every Horseshoe Bay code refuses with the unverified code rather than the zone reason.
 */
import { describe, expect, it } from "vitest";
import {
  getSetbackTable,
  getSetbackTableForZoning,
  SETBACK_JURISDICTION_KEYS,
  SETBACK_EDITION_CURRENT,
  SETBACK_EDITION_UNVERIFIED,
  SETBACK_CONDITIONAL_NOT_EVALUATED,
  SETBACK_SOURCE_NOT_REGISTERED,
  SETBACK_TABLE_ABSENT,
  checkSetbackEditionCurrency,
  burnetOrdinanceRegister,
  isSetbackRefusalError,
} from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";
import zoneFile from "../local/setbacks/horseshoe-bay-tx-zone-standards.json" with { type: "json" };

/** The codes stamped on production parcels (txgio_parcel, county 48053, read 2026-10-13). */
const MF_STAMPED = ["ENZ.1", "ENZ.2", "ENZ.3", "ENZ.4", "ENZ.5", "NR", "GC", "DR", "NC", "DN", "TR", "DT", "RE", "BP", "FR", "MR", "IN"];
const HSB_STAMPED = ["R-1", "MH-1", "R-4", "GH", "R-6", "R-2", "A-1", "C-2", "GUI"];

/** Same normalization as artifacts/api-server districtMapping.ts's districtCode()/normalizeCode(). */
const normalizeCode = (raw: string) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
const districtCode = (name: string) => normalizeCode(name.trim().split(/\s+/)[0] ?? "");

function refusalCode(jurisdictionKey: string, code: string): string | null {
  try {
    getSetbackTableForZoning(jurisdictionKey, code);
    return null;
  } catch (err) {
    if (!isSetbackRefusalError(err)) throw err;
    return err.code;
  }
}

const register = burnetOrdinanceRegister();
const regRow = (city: string, code: string) => register.find((r) => r.city === city && r.district_code === code);

/* ===================================== Marble Falls ===================================== */

/** Pack E's own cells for the served row of each served district (feet / percent, as printed). */
const MF_EXPECTED: Record<string, [number, number, number, number, number, number]> = {
  //          front side rear street-side height coverage%
  "ENZ.1": [50, 15, 25, 25, 35, 30],
  "ENZ.2": [25, 5, 10, 15, 35, 50],
  "ENZ.3": [25, 5, 10, 15, 35, 75],
  "ENZ.4": [25, 5, 15, 15, 35, 75],
  "ENZ.5": [25, 5, 15, 15, 25, 60],
  BP: [35, 15, 30, 25, 60, 80],
  IN: [35, 20, 40, 25, 60, 85],
};

describe("marble-falls-tx table (pack E)", () => {
  const table = getSetbackTable("marble-falls-tx")!;

  it("BREAK-TEST (fails on origin/main, where no marble-falls-tx table exists): the table is registered and carries exactly the 7 served districts", () => {
    expect(SETBACK_JURISDICTION_KEYS).toContain("marble-falls-tx");
    expect(table).not.toBeNull();
    expect(table.districts.map((d) => districtCode(d.district_name)).sort()).toEqual(
      Object.keys(MF_EXPECTED).map(normalizeCode).sort(),
    );
  });

  it("passes the setback acceptance gate with zero blocks (no atom corpus: primary-source-verified)", () => {
    const report = runSetbackGate({ table: table as unknown as GatedSetbackTable, atoms: [] });
    expect(report.counts.block).toBe(0);
    expect(report.passed).toBe(true);
    expect(report.gated).toBe(true);
  });

  it.each(Object.entries(MF_EXPECTED))("%s serves pack E's own numbers end-to-end, through the edition gate", (code, exp) => {
    const t = getSetbackTableForZoning("marble-falls-tx", code)!;
    const d = t.districts.find((x) => districtCode(x.district_name) === normalizeCode(code))!;
    expect([d.front_ft, d.side_ft, d.rear_ft, d.side_corner_ft, d.max_height_ft, d.max_lot_coverage_pct]).toEqual(exp);
    // No Marble Falls table states impervious cover: the not_specified sentinel, flagged -- never 0.
    expect(d.max_impervious_pct).toBe(100);
    const p = (d as unknown as GatedSetbackTable["districts"][number]).provenance!;
    expect(p.max_impervious_pct!.not_specified).toBe(true);
  });

  it("every coded number is carried by a verbatim quote that prints it (feet as 25', coverage as 50%)", () => {
    for (const d of table.districts) {
      const p = (d as unknown as GatedSetbackTable["districts"][number]).provenance!;
      for (const f of ["front_ft", "side_ft", "rear_ft", "side_corner_ft", "max_height_ft"] as const) {
        expect(p[f]!.quote, `${d.district_name}.${f}`).toContain(`"${d[f]}'"`);
      }
      expect(p.max_lot_coverage_pct!.quote).toContain(`"${d.max_lot_coverage_pct}%"`);
    }
  });

  it("district_name leads with the code, so districtCode() resolves every served stamped code to exactly one row", () => {
    for (const code of Object.keys(MF_EXPECTED)) {
      const hits = table.districts.filter((d) => districtCode(d.district_name) === normalizeCode(code));
      expect(hits, code).toHaveLength(1);
    }
  });
});

describe("Marble Falls register: every stamped code ends with a row or a declared refusal", () => {
  it.each(MF_STAMPED)("%s", (code) => {
    const v = checkSetbackEditionCurrency({ city: "Marble Falls", districtCode: code });
    expect(v.code).not.toBe(SETBACK_SOURCE_NOT_REGISTERED);
    const row = regRow("Marble Falls", code)!;
    expect(row.ordinance).toBe("Ord. No. 2026-O-04A");
    expect(row.edition_line_verbatim).toContain("Codified through Ordinance No. 2026-O-04A, adopted April 7, 2026. (Supp. No. 98)");
    expect(row.source_url).toMatch(/^https:\/\/library\.municode\.com\/tx\/marble_falls\//);
    if (code in MF_EXPECTED) {
      expect(v.code).toBe(SETBACK_EDITION_CURRENT);
      expect(row.verification).toBe("verified-browser-read");
      expect(refusalCode("marble-falls-tx", code)).toBeNull();
    } else {
      expect(v.code).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
      expect(row.conditional_reason, code).toBeTruthy();
      expect(refusalCode("marble-falls-tx", code)).toBe(SETBACK_CONDITIONAL_NOT_EVALUATED);
    }
  });

  it("the building-type rule: FR, RE, NR, TR and MR refuse because their table has several (or no) Single-Family Detached rows and marks none primary; each refusal quotes every row", () => {
    const sfdRows: Record<string, number> = { FR: 3, RE: 2, NR: 3, TR: 2, MR: 0 };
    for (const [code, n] of Object.entries(sfdRows)) {
      const row = regRow("Marble Falls", code)!;
      expect(row.conditional_reason, code).toMatch(/building type/);
      const quoted = (row.notes.match(/Single-Family Detached\)"/gi) ?? []).length; // pack E spells TR's "Single-family"
      expect(quoted, `${code}: Single-Family Detached rows quoted`).toBe(n);
    }
  });

  it("DR refuses on Table 4.2.6.A's lot-width tiers; NC/GC on lake adjacency; DN/DT on build-to lines", () => {
    expect(regRow("Marble Falls", "DR")!.conditional_reason).toMatch(/lot width/);
    for (const c of ["NC", "GC"]) expect(regRow("Marble Falls", c)!.conditional_reason, c).toMatch(/Lake Marble Falls/);
    for (const c of ["DN", "DT"]) expect(regRow("Marble Falls", c)!.conditional_reason, c).toMatch(/build-to/);
  });

  it("no refused code can reach a served row by prefix (the api-server districtMapping fallback): no refused stamped code is a prefix of, or prefixed by, a served row's code", () => {
    const table = getSetbackTable("marble-falls-tx")!;
    const served = table.districts.map((d) => districtCode(d.district_name));
    for (const code of MF_STAMPED.filter((c) => !(c in MF_EXPECTED)).map(normalizeCode)) {
      for (const s of served) {
        expect(s.startsWith(code) || code.startsWith(s), `${code} vs ${s}`).toBe(false);
      }
    }
  });

  it("PD (not stamped; pack E did not extract Div. 4.4) stays unverified", () => {
    expect(checkSetbackEditionCurrency({ city: "Marble Falls", districtCode: "PD" }).code).toBe(SETBACK_EDITION_UNVERIFIED);
  });
});

/* ===================================== Horseshoe Bay ===================================== */

type ZoneEntry = (typeof zoneFile.standards)[number];
const SIG_FIELDS = ["front_ft", "side_ft", "rear_ft", "corner_or_street_side_ft", "max_height", "max_lot_coverage", "max_impervious_cover"] as const;
const numbersIn = (s: string) => [...new Set([...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])))].sort((a, b) => a - b);
const signature = (e: ZoneEntry) =>
  SIG_FIELDS.map((f) => {
    const c = (e.fields as Record<string, { value: number | null; verbatim: string }>)[f]!;
    return c.value !== null ? `#${c.value}` : `null[${numbersIn(c.verbatim).join(",")}]`;
  }).join(";");
const entriesFor = (layerCode: string) => zoneFile.standards.filter((e) => e.layer_zoning === layerCode);
const variesByZone = (layerCode: string) => new Set(entriesFor(layerCode).map(signature)).size > 1;

const ZONE_REASON = "standards vary by Horseshoe Bay geographic zone; parcel zone not resolved";

describe("Horseshoe Bay: one test per stamped code (varies by zone -> refuses; identical -> only a non-zone reason may refuse it)", () => {
  const expectations: Record<string, { varies: boolean; code: string; reason: RegExp }> = {
    "R-1": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    "R-4": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    GH: { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    "R-6": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    "R-2": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    "A-1": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    "C-2": { varies: true, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /geographic zone/ },
    // Identical in Zones 3/4A/4B and 12 -- but its "10'.*" side/rear carry the footnote "25 feet for
    // any side or rear that adjoins residential classifications", an abutting condition.
    GUI: { varies: false, code: SETBACK_CONDITIONAL_NOT_EVALUATED, reason: /^abutting residential/ },
  };

  it.each(Object.entries(expectations))("%s", (code, exp) => {
    expect(variesByZone(code), `${code} varies-by-zone, recomputed from the zone-keyed standards`).toBe(exp.varies);
    expect(refusalCode("horseshoe-bay-tx", code)).toBe(exp.code);
    const row = regRow("Horseshoe Bay", code)!;
    expect(row.verification).toBe("conditional-not-evaluated");
    expect(row.conditional_reason).toMatch(exp.reason);
    // The zone reason is present iff the standards really vary by zone.
    expect(row.conditional_reason!.includes(ZONE_REASON), code).toBe(exp.varies);
    const v = checkSetbackEditionCurrency({ city: "Horseshoe Bay", districtCode: code });
    expect(v.detail).toContain(row.conditional_reason!);
    expect(row.edition_line_verbatim).toContain("Includes legislation through Ord. No. 2026-18 adopted June 16, 2026");
  });

  it("MH-1 (stamped on 746 parcels, absent from pack E) refuses as unsourced -- never mapped onto pack E's Zone-4B M-1", () => {
    expect(refusalCode("horseshoe-bay-tx", "MH-1")).toBe(SETBACK_EDITION_UNVERIFIED);
    expect(regRow("Horseshoe Bay", "MH-1")!.notes).toMatch(/^UNSOURCED/);
    expect(zoneFile.code_spelling_map.some((m) => m.pack_e_code === "MH-1" || m.layer_zoning === "MH-1")).toBe(false);
  });

  it("every stamped Horseshoe Bay code ends with a declared refusal; none serves, and no horseshoe-bay-tx table is vendored", () => {
    expect(getSetbackTable("horseshoe-bay-tx")).toBeNull();
    for (const code of HSB_STAMPED) {
      const c = refusalCode("horseshoe-bay-tx", code);
      expect(c, code).not.toBeNull();
      expect(c, code).not.toBe(SETBACK_SOURCE_NOT_REGISTERED);
    }
  });

  it("consistency, every layer code pack E covers: zone-varying -> refused with the zone reason; identical and one figure per field -> clears the edition gate (verified-browser-read) and refuses only SETBACK_TABLE_ABSENT", () => {
    for (const v of zoneFile.per_code_verdicts) {
      if (v.keyKind !== "ZONING") continue;
      const row = regRow("Horseshoe Bay", v.code)!;
      if (row.verification === "no-dimensional-standards") continue;
      if (variesByZone(v.code)) {
        expect(row.conditional_reason, v.code).toContain(ZONE_REASON);
      } else if (row.verification === "verified-browser-read") {
        expect(checkSetbackEditionCurrency({ city: "Horseshoe Bay", districtCode: v.code }).code, v.code).toBe(SETBACK_EDITION_CURRENT);
        expect(refusalCode("horseshoe-bay-tx", v.code), v.code).toBe(SETBACK_TABLE_ABSENT);
      } else {
        expect(row.conditional_reason ?? "", v.code).not.toContain(ZONE_REASON);
      }
    }
    const verified = zoneFile.per_code_verdicts.filter((v) => /^verified/.test(v.verdict)).map((v) => v.code).sort();
    expect(verified).toEqual(["M-1", "R-16", "R-6.5"]);
  });

  it("spellings map explicitly, never fuzzily: R-R -> RR; Zone 9 'R-1 Estate' -> R-1 (not R-1-EST); Zone 12 'R-1-EST' -> R-1 / SUB_ZONING R-1-EST", () => {
    const m = (c: string) => zoneFile.code_spelling_map.find((x) => x.pack_e_code === c)!;
    expect(m("R-R").layer_zoning).toBe("RR");
    expect(m("R-1 Estate").layer_zoning).toBe("R-1");
    expect(m("R-1 Estate").layer_sub_zoning).toBeNull();
    expect(m("R-1-EST").layer_sub_zoning).toBe("R-1-EST");
    // Every pack-E spelling is mapped (the converter throws otherwise); the CA, Lago Estate and LR-1
    // codes the browser agent flagged are present.
    const codes = new Set(zoneFile.standards.map((e) => e.pack_e_code));
    for (const c of codes) expect(zoneFile.code_spelling_map.some((x) => x.pack_e_code === c), c).toBe(true);
    for (const c of ["CA", "Lago Estate", "LR-1"]) expect(codes.has(c), c).toBe(true);
  });

  it("printing errors are copied as printed and never coded: Zone 19 A-1 front 25\" and the 'often (10) feet' tract", () => {
    const a1z19 = zoneFile.standards.find((e) => e.pack_e_code === "A-1" && e.zone === "19")!;
    expect(a1z19.fields.front_ft.verbatim).toContain('25"');
    expect(a1z19.fields.front_ft.value).toBeNull();
    const often = zoneFile.standards.find((e) => e.fields.side_ft.verbatim.includes("often (10)"))!;
    expect(often.fields.side_ft.value).toBeNull();
    expect(often.fields.rear_ft.value).toBeNull();
  });

  it("the zone-keyed standards file is not a served table", () => {
    expect(SETBACK_JURISDICTION_KEYS).not.toContain("horseshoe-bay-tx");
    expect(zoneFile.status).toMatch(/^NOT SERVED/);
  });
});
