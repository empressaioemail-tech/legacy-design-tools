/**
 * P-78 cad_property merge fixtures (JS reference; SQL must match).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyPathAMerge,
  landAcresFromGis,
  landAcresFromLegalDescription,
  parseYearBuilt,
  REFUSE_GIS_AREA_REASON,
} from "../p78Merge";
import { normalizeStratMapLandUse } from "../txgio/landuse";
import { newCounters } from "../types";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(here, "__fixtures__", "p78-cad-merge");

type Fixture = {
  name: string;
  existingRow: Record<string, unknown>;
  incomingRow: Record<string, unknown>;
  gisArea?: unknown;
  gisAreaU?: unknown;
  expect: Record<string, unknown> | { refuse: true; reason: string };
};

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")) as Fixture);
}

function applyMerge(fixture: Fixture) {
  if (fixture.gisArea != null || fixture.gisAreaU != null) {
    const gate = landAcresFromGis(fixture.gisArea, fixture.gisAreaU);
    if ("refuse" in gate) return { refuse: true, reason: gate.reason };
  }
  const incoming = { ...fixture.incomingRow } as Parameters<typeof applyPathAMerge>[1];
  if (fixture.gisArea != null || fixture.gisAreaU != null) {
    const gate = landAcresFromGis(fixture.gisArea, fixture.gisAreaU);
    if (!("refuse" in gate)) incoming.landAcres = gate.landAcres;
  }
  return applyPathAMerge(
    fixture.existingRow as Parameters<typeof applyPathAMerge>[0],
    incoming,
  );
}

function applyLastWins(fixture: Fixture) {
  return { ...fixture.incomingRow };
}

describe("P-78 merge fixtures", () => {
  const fixtures = loadFixtures();

  it("matches reference merge for every fixture", () => {
    for (const fix of fixtures) {
      const got = applyMerge(fix);
      expect(got, fix.name).toEqual(fix.expect);
    }
  });

  it("last-wins fails F1 and F3", () => {
    const byName = Object.fromEntries(fixtures.map((f) => [f.name, f]));
    expect(applyLastWins(byName.F1)).not.toEqual(byName.F1.expect);
    expect(applyLastWins(byName.F3)).not.toEqual(byName.F3.expect);
  });
});

describe("parseYearBuilt", () => {
  it("takes first valid YYYY from comma list (F8)", () => {
    expect(parseYearBuilt("1962,2011,2023")).toBe(1962);
    expect(Number("1962,2011,2023")).toBeNaN();
  });

  it("skips junk token 209", () => {
    expect(parseYearBuilt("209,1975,2002")).toBe(1975);
  });
});

describe("normalizeStratMapLandUse YEAR_BUILT / GIS_AREA", () => {
  const base = {
    Prop_ID: "1",
    TAX_YEAR: "2025",
    STAT_LAND_: "A1",
  };

  it("parses YEAR_BUILT list", () => {
    const rec = normalizeStratMapLandUse(
      "48055",
      0,
      { ...base, YEAR_BUILT: "1962,2011,2023" },
      newCounters(),
    );
    expect(rec!.yearBuilt).toBe(1962);
  });

  it("refuses land_acres when GIS_AREA_U is unknown", () => {
    const rec = normalizeStratMapLandUse(
      "48055",
      0,
      { ...base, GIS_AREA: 1.5, GIS_AREA_U: "SQM" },
      newCounters(),
    );
    expect(rec!.landAcres).toBeNull();
  });

  it("writes acres when GIS_AREA_U is AC", () => {
    const rec = normalizeStratMapLandUse(
      "48055",
      0,
      { ...base, GIS_AREA: 2.5, GIS_AREA_U: "AC" },
      newCounters(),
    );
    expect(rec!.landAcres).toBe("2.5000");
  });
});

describe("landAcresFromGis unit table", () => {
  it("refuses blank unit", () => {
    expect(landAcresFromGis(1, "")).toEqual({
      refuse: true,
      reason: REFUSE_GIS_AREA_REASON,
    });
  });
});

describe("landAcresFromLegalDescription (McLennan leftover-farm fallback, F-01)", () => {
  it("parses the dominant 'Acres <n>' phrasing (real McLennan example)", () => {
    expect(
      landAcresFromLegalDescription("LOT 4 BLOCK 2 RIVER OAKS ADDN Acres 0.414"),
    ).toBe("0.4140");
  });

  it("FALSIFIER: prefers 'Total <n> Ac' over an earlier decoy '<n> Ac' in the same string (real McLennan example)", () => {
    // The decoy (0.116) is a sub-tract figure, not the parcel's real total.
    // A naive first-match-wins "<number> Ac" regex would return "0.1160".
    expect(
      landAcresFromLegalDescription(
        "AXTELL OT Block 5 Lot 4 5 & 0.116 Ac Aband ROW (A) Total 0.414 Ac",
      ),
    ).toBe("0.4140");
  });

  it("returns null for a description with no parseable acreage (honest absence, never invented)", () => {
    expect(landAcresFromLegalDescription("LOT 4 BLOCK 2 RIVER OAKS ADDN")).toBeNull();
  });

  it("returns null for a non-positive or non-finite figure", () => {
    expect(landAcresFromLegalDescription("Acres 0")).toBeNull();
    expect(landAcresFromLegalDescription("Acres -1.5")).toBeNull();
  });

  it("returns null for null/undefined/non-string input", () => {
    expect(landAcresFromLegalDescription(null)).toBeNull();
    expect(landAcresFromLegalDescription(undefined)).toBeNull();
    expect(landAcresFromLegalDescription(12.5)).toBeNull();
  });
});

describe("normalizeStratMapLandUse LEGAL_DESC fallback (McLennan, F-01)", () => {
  const base = {
    Prop_ID: "1",
    TAX_YEAR: "2025",
    STAT_LAND_: "A1",
  };

  it("falls back to LEGAL_DESC acreage when GIS_AREA_U is unusable (the real McLennan shape: land_value present, land_acres null)", () => {
    const rec = normalizeStratMapLandUse(
      "48309",
      0,
      {
        ...base,
        GIS_AREA: 1.5,
        GIS_AREA_U: "", // McLennan's real drop: no usable unit on any row
        LEGAL_DESC: "LOT 4 BLOCK 2 RIVER OAKS ADDN Acres 0.414",
        LAND_VALUE: 12000,
      },
      newCounters(),
    );
    expect(rec!.landAcres).toBe("0.4140");
    expect(rec!.landValue).toBe(12000);
  });

  it("FALSIFIER: does NOT regress a county whose GIS_AREA already resolves -- the GIS value wins even when LEGAL_DESC also carries a (different) figure", () => {
    const rec = normalizeStratMapLandUse(
      "48055",
      0,
      {
        ...base,
        GIS_AREA: 2.5,
        GIS_AREA_U: "AC",
        LEGAL_DESC: "LOT 9 BLOCK 3 SOME OTHER ADDN Acres 9.999",
      },
      newCounters(),
    );
    expect(rec!.landAcres).toBe("2.5000");
  });

  it("stays null when neither GIS_AREA nor LEGAL_DESC carries a usable figure (no fabrication)", () => {
    const rec = normalizeStratMapLandUse(
      "48309",
      0,
      { ...base, GIS_AREA: 1.5, GIS_AREA_U: "", LEGAL_DESC: "LOT 4 BLOCK 2 RIVER OAKS ADDN" },
      newCounters(),
    );
    expect(rec!.landAcres).toBeNull();
  });
});
