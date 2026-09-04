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
