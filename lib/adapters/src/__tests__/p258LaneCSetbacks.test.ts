import { describe, expect, it } from "vitest";

import {
  getSetbackTable,
  getSetbackDistrict,
  getSetbackTableForZoning,
  type SetbackTable,
} from "../local/setbacks/index.js";
import { runSetbackGate, type GatedSetbackTable } from "../local/setbacks/gate.js";

/**
 * P-258 lane-c (2026-09-16) — district-miss rows added to nine existing city
 * tables in one campaign pass, worked largest-parcel-first:
 *
 *   san-marcos-tx (4,054 parcels) round-rock-tx (1,798) cedar-park-tx (2,057)
 *   georgetown-tx (1,062)         buda-tx (1,022)       kyle-tx (834)
 *   dripping-springs-tx (597)     pflugerville-tx (323)
 *
 * These tables are what the buildable-envelope route draws and cites, so this
 * suite asserts the load path, the added districts, and — most importantly —
 * that every row this pass added is gate-clean (zero blocks) under the same
 * acceptance gate the rest of the corpus is held to. It deliberately does NOT
 * re-assert rows this lane did not research.
 *
 * State: every value added by this pass was read off a live primary source
 * (Municode rendering / eCode360 / the city's own adopted PDF), and the
 * jurisdictions whose code-section atom corpus does not exist carry
 * `primary-source-verified` with no `atom_did` (the belton precedent). The
 * Dripping Springs rows are the one nuance: that file's earlier rows are
 * `human-verified` with an `atom_did`, but this pass could not round-trip the
 * section text against a corpus atom, and this corpus has an explicit history
 * of a fabricated `atom_did` (see kyle-tx.json's note), so the added rows are
 * `primary-source-verified` with no atom claim rather than a guess.
 */
const NUMERIC_FIELDS = [
  "front_ft",
  "rear_ft",
  "side_ft",
  "side_corner_ft",
  "max_height_ft",
  "max_lot_coverage_pct",
  "max_impervious_pct",
] as const;

function assertWellFormed(table: SetbackTable) {
  expect(table.districts.length).toBeGreaterThan(0);
  for (const d of table.districts) {
    expect(d.district_name.length).toBeGreaterThan(0);
    expect(d.provenance).toBeTruthy();
    expect(d.citation_url).toMatch(/^https:\/\//);
    for (const f of NUMERIC_FIELDS) {
      expect(typeof d[f], `${d.district_name}.${f}`).toBe("number");
      expect(Number.isFinite(d[f])).toBe(true);
      expect(d[f]).toBeGreaterThanOrEqual(0);
      expect(
        d.provenance![f],
        `${d.district_name}.${f} has no provenance entry`,
      ).toBeTruthy();
    }
  }
}

/** Run the real gate over just the districts this pass added in a city. */
function assertAddedDistrictsGateClean(city: string, names: string[]) {
  const full = getSetbackTable(city)! as unknown as GatedSetbackTable;
  const wanted = new Set(names);
  const subset: GatedSetbackTable = {
    ...full,
    districts: full.districts.filter((d) => wanted.has(d.district_name)),
  };
  expect(subset.districts).toHaveLength(names.length);
  const report = runSetbackGate({ table: subset, atoms: [] });
  const blocks = report.results.filter((r) => r.level === "block");
  expect(blocks.map((b) => `${b.rule} ${b.district}/${b.field}: ${b.message}`)).toEqual(
    [],
  );
  expect(report.passed).toBe(true);
}

/** A not_specified max_height_ft must carry the canonical 999 (gate rule G7). */
function assertHeightSentinel(table: SetbackTable) {
  for (const d of table.districts) {
    if (d.provenance?.max_height_ft?.not_specified) {
      expect(d.max_height_ft, `${d.district_name}.max_height_ft`).toBe(999);
    }
  }
}

describe("P-258 lane-c — Dripping Springs (Municode Ch. 30 Exh. A §3)", () => {
  const ADDED = [
    "AG Agriculture District",
    "O Office District",
    "LR Local Retail District",
    "GR General Retail District",
    "CS Commercial Services District",
    "I Industrial District",
    "GUI Government/Utility/Institutional District",
    "PP Public Park or Preserve District",
    "MH Manufactured Housing District",
  ];

  it("adds the nine lane-c districts the city's commercial + MH codes needed", () => {
    const table = getSetbackTable("dripping_springs_tx")!;
    assertWellFormed(table);
    for (const name of ADDED) {
      expect(
        table.districts.map((d) => d.district_name),
        name,
      ).toContain(name);
    }
  });

  it("codifies the §3.12/§3.13/§3.2 scalars verbatim, with the province of each", () => {
    const cs = getSetbackDistrict("dripping_springs_tx", "CS Commercial Services District")!;
    expect([cs.front_ft, cs.side_ft, cs.side_corner_ft, cs.rear_ft]).toEqual([25, 15, 25, 25]);
    expect([cs.max_height_ft, cs.max_impervious_pct]).toEqual([40, 70]);

    const i = getSetbackDistrict("dripping_springs_tx", "I Industrial District")!;
    expect(i.front_ft).toBe(60);
    expect(i.side_corner_ft).toBe(50); // "50 feet adjacent to a public street or residential lot"

    // AG's side yard is a PERCENTAGE OF LOT WIDTH, so no feet value is invented:
    // not_specified, sentinel 100, and the corner value (which IS in feet) kept.
    const ag = getSetbackDistrict("dripping_springs_tx", "AG Agriculture District")!;
    expect(ag.front_ft).toBe(50);
    expect(ag.side_corner_ft).toBe(25);
    expect(ag.provenance!.side_ft!.not_specified).toBe(true);
    expect(ag.provenance!.side_ft!.quote).toMatch(/PERCENTAGE OF LOT WIDTH/);

    // PP's yards are a stated "N/A" — codified 0, not a sentinel — and its
    // impervious cover is transcribed at the ordinance's literal 3 percent.
    const pp = getSetbackDistrict("dripping_springs_tx", "PP Public Park or Preserve District")!;
    expect([pp.front_ft, pp.side_ft, pp.side_corner_ft, pp.rear_ft]).toEqual([0, 0, 0, 0]);
    expect(pp.max_impervious_pct).toBe(3);
    expect(pp.provenance!.max_impervious_pct!.quote).toMatch(/Three percent/);
  });

  it("is gate-clean on the added districts", () => {
    assertAddedDistrictsGateClean("dripping-springs-tx", ADDED);
  });
});

describe("P-258 lane-c — Round Rock (Pt. III Ch. 2 §2-36/2-49/2-61/2-78)", () => {
  const ADDED = [
    "C-1 General Commercial District",
    "C-1a General Commercial - Limited District",
    "C-2 Local Commercial District",
    "OF-1 General Office District",
    "BP Business Park District",
    "LI Light Industrial District",
    "I Industrial District",
    "PF-1 Public Facilities - Low Intensity District",
    "PF-2 Public Facilities - Medium Intensity District",
    "PF-3 Public Facilities - High Intensity District",
    "MU-1 Mixed-Use Historic Commercial Core District",
    "MU-2 Mixed-Use Downtown Medium Density District",
    "MU-L Mixed-Use Limited District",
    "MU-R Mixed-Use Redevelopment and Small Lot District",
  ];

  it("adds the commercial, employment, civic and mixed-use rows", () => {
    const table = getSetbackTable("round_rock_tx")!;
    assertWellFormed(table);
    for (const name of ADDED) {
      expect(table.districts.map((d) => d.district_name), name).toContain(name);
    }
  });

  it("normalizes every stories-only height to the canonical 999 sentinel (gate G7)", () => {
    assertHeightSentinel(getSetbackTable("round_rock_tx")!);
    const c1 = getSetbackDistrict("round_rock_tx", "C-1 General Commercial District")!;
    expect(c1.max_height_ft).toBe(999);
    expect(c1.provenance!.max_height_ft!.quote).toMatch(/5 stories/);
  });

  it("keeps the mixed-use rows' stated feet heights where the chart states feet", () => {
    expect(
      getSetbackDistrict("round_rock_tx", "MU-1 Mixed-Use Historic Commercial Core District")!
        .max_height_ft,
    ).toBe(48);
    expect(
      getSetbackDistrict("round_rock_tx", "MU-R Mixed-Use Redevelopment and Small Lot District")!
        .max_height_ft,
    ).toBe(50);
  });

  it("is gate-clean on the added districts", () => {
    assertAddedDistrictsGateClean("round-rock-tx", ADDED);
  });
});

describe("P-258 lane-c — Buda, Kyle, Cedar Park, Pflugerville, Georgetown", () => {
  it("Buda adds the nonresidential rows from UDC 2.07.02", () => {
    const names = ["B-2 Arterial Business District", "B-3 Interstate-35 Business District", "LI Light Industrial District", "HI Heavy Industrial District"];
    const table = getSetbackTable("buda_tx")!;
    assertWellFormed(table);
    for (const n of names) expect(table.districts.map((d) => d.district_name)).toContain(n);
    expect(getSetbackDistrict("buda_tx", "B-3 Interstate-35 Business District")!.front_ft).toBe(50);
    assertAddedDistrictsGateClean("buda-tx", names);
  });

  it("Kyle adds the remaining chart districts, with NC's stories-only height at 999", () => {
    const names = [
      "A Agricultural District",
      "R-3-3 Multifamily Residential 3",
      "CBD-2 Central Business District 2",
      "W Warehouse District",
      "CM Commercial District",
      "HS Hospital Services District",
      "NC Neighborhood Commercial District",
    ];
    const table = getSetbackTable("kyle_tx")!;
    assertWellFormed(table);
    for (const n of names) expect(table.districts.map((d) => d.district_name)).toContain(n);
    const nc = getSetbackDistrict("kyle_tx", "NC Neighborhood Commercial District")!;
    expect(nc.max_height_ft).toBe(999);
    expect(nc.provenance!.max_height_ft!.quote).toMatch(/2 stories/);
    assertHeightSentinel(table);
    assertAddedDistrictsGateClean("kyle-tx", names);
  });

  it("Cedar Park adds UR as a cited conservative envelope (TC stays unrowable)", () => {
    const table = getSetbackTable("cedar_park_tx")!;
    assertWellFormed(table);
    const ur = table.districts.find((d) => d.district_name.startsWith("UR "))!;
    expect(ur).toBeDefined();
    expect([ur.front_ft, ur.rear_ft, ur.side_ft, ur.side_corner_ft]).toEqual([25, 20, 15, 25]);
    // TC (Town Center) is form-based and deliberately still has no row.
    expect(
      table.districts.some((d) => d.district_name.toUpperCase().startsWith("TC")),
    ).toBe(false);
    expect(table.note).toMatch(/TC/);
  });

  it("Pflugerville adds the three corridor districts", () => {
    const names = [
      "CL3 Corridor District - Neighborhood (Level 3)",
      "CL4 Corridor District - Urban (Level 4)",
      "CL5 Corridor District - Urban Center (Level 5)",
    ];
    const table = getSetbackTable("pflugerville_tx")!;
    assertWellFormed(table);
    for (const n of names) expect(table.districts.map((d) => d.district_name)).toContain(n);
    expect(getSetbackDistrict("pflugerville_tx", names[2])!.max_height_ft).toBe(85);
    assertAddedDistrictsGateClean("pflugerville-tx", names);
  });

  it("Georgetown adds the four adopted-rewrite districts with complete provenance", () => {
    const names = [
      "AG Agriculture District",
      "MH Manufactured Housing District",
      "PF Public Facilities District",
      "MU-DT Mixed-Use Downtown District",
    ];
    const table = getSetbackTable("georgetown_tx")!;
    assertWellFormed(table);
    for (const n of names) expect(table.districts.map((d) => d.district_name)).toContain(n);
    // Rule G6: every value of these rows needs a confidence, including the
    // not_specified lot-coverage stand-in.
    for (const n of names) {
      const d = getSetbackDistrict("georgetown_tx", n)!;
      for (const f of NUMERIC_FIELDS) {
        expect(typeof d.provenance![f]!.confidence, `${n}.${f}`).toBe("number");
      }
    }
    assertAddedDistrictsGateClean("georgetown-tx", names);
  });
});

describe("P-258 lane-c — San Marcos legacy rows", () => {
  const ADDED = [
    "CC Community Commercial (legacy)",
    "GC General Commercial (legacy)",
    "NC Neighborhood Commercial (legacy)",
    "OP Office Professional (legacy)",
    "MH Manufactured Home District",
  ];

  it("adds the legacy commercial districts plus MH with stories-only heights at 999", () => {
    const table = getSetbackTable("san-marcos-tx")!;
    assertWellFormed(table);
    for (const n of ADDED) expect(table.districts.map((d) => d.district_name)).toContain(n);
    assertHeightSentinel(table);
  });

  it("is gate-clean on the added districts and on the whole table", () => {
    assertAddedDistrictsGateClean("san-marcos-tx", ADDED);
    const report = runSetbackGate({
      table: getSetbackTable("san-marcos-tx") as unknown as GatedSetbackTable,
      atoms: [],
    });
    expect(report.counts.block).toBe(0);
  });
});

describe("P-258 lane-c — Bastrop stays an honest decline (withdrawn rows)", () => {
  it("serves no city-code row, because the wiring routes those codes to the BDC table", () => {
    // This pass read real base scalars for GC/MU/PI/IND/P-OS out of the adopted
    // Bastrop Development Code and briefly rowed them here; the rows were
    // withdrawn because index.ts routes those stamps to
    // bastrop-development-code (a cross-repo hash-locked table that asserts
    // their absence), so rows in this file would never be served. The values
    // are recorded as evidence in this file's note instead.
    for (const code of ["GC", "MU", "PI", "IND", "P/OS"] as const) {
      const routed = getSetbackTableForZoning("bastrop-tx", code)!;
      expect(routed.jurisdictionKey, code).toBe("bastrop-development-code");
      expect(
        routed.districts.some(
          (d) => (d.district_name.trim().split(/\s+/)[0] ?? "").toUpperCase() === code,
        ),
        code,
      ).toBe(false);
    }
    const legacy = getSetbackTable("bastrop-tx")!;
    expect(legacy.districts).toHaveLength(10);
    expect(legacy.districts.some((d) => d.district_name.startsWith("GC"))).toBe(false);
    expect(legacy.note).toMatch(/P-258 LANE-C ADDENDUM/);
    expect(legacy.note).toMatch(/hash-locked/);
  });
});
