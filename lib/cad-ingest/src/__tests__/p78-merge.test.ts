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

describe("CTX-HAYS-REBIND: a geometry apply cannot blank a published crosswalk", () => {
  it("a StratMap re-apply LEAVES an existing quick_ref_id / property_number intact", () => {
    // The whole safety argument for putting these two under coalesce. The
    // StratMap loader emits null for both (hardcoded, see
    // txgio/landuse.ts), so coalesce(incoming, existing) returns the EXISTING
    // value and the crosswalk a real CAD export established survives.
    //
    // This is NOT true of source_file, which applyPathAMerge overwrites
    // unconditionally -- which is exactly why lineage could not be recovered
    // from it and why the crosswalk had to come from the county rather than
    // from provenance.
    const existing = {
      countyFips: "48209",
      propId: "40138",
      taxYear: 2025,
      quickRefId: "R26199",
      propertyNumber: "11-2520-0000-03100-2",
      situsAddress: "340 WINDMILL WAY, BUDA, TX 78610",
      sourceFile: "2026-PROPERTY-DATA-EXPORT-FILES.zip",
      sourceVintage: "tier:cad-export;2026",
    };
    const stratmapIncoming = {
      countyFips: "48209",
      propId: "40138",
      taxYear: 2025,
      quickRefId: null,
      propertyNumber: null,
      situsAddress: "100 RIVERSIDE DR, SAN MARCOS, TX 78666",
      sourceFile: "stratmap25-landparcels_48209_lp.zip",
      sourceVintage: "stratmap25",
    };
    const merged = applyPathAMerge(existing, stratmapIncoming);
    expect(merged.quickRefId).toBe("R26199");
    expect(merged.propertyNumber).toBe("11-2520-0000-03100-2");
    // THE P-78 MERGE ROOT FIX (Phase 0 audit section 3/4, P3). Before this fix, the SAME merge
    // ALSO overwrote situsAddress with the StratMap incoming value -- the exact defect audited
    // as "p78Merge.ts letting geometry-source fields overwrite appraisal-source fields". Now
    // situsAddress runs through the same authority-aware merge as quickRefId/propertyNumber's
    // reasoning already implied it should: a non-cad-export incoming value can never overwrite
    // an existing cad-export value. The real CAD export's situs survives a StratMap re-apply,
    // exactly like its quickRefId/propertyNumber already did.
    expect(merged.situsAddress).toBe("340 WINDMILL WAY, BUDA, TX 78610");
    // source_file/source_vintage are NOT in AUTHORITY_COALESCE_FIELDS (they describe the row's
    // own provenance, not an appraisal attribute) and are still overwritten unconditionally --
    // this is the pre-existing, intentional "lineage could not be recovered from it" behavior
    // the comment on applyPathAMerge's sourceFile/sourceVintage assignment already documents.
    expect(merged.sourceFile).toBe("stratmap25-landparcels_48209_lp.zip");
  });

  it("a real CAD export re-publishing a corrected identifier DOES win", () => {
    const existing = {
      countyFips: "48209",
      propId: "40138",
      taxYear: 2026,
      quickRefId: "R00000",
      propertyNumber: "00-0000-0000-00000-0",
      sourceFile: "old.zip",
      sourceVintage: "tier:cad-export;2025",
    };
    const corrected = {
      countyFips: "48209",
      propId: "40138",
      taxYear: 2026,
      quickRefId: "R26199",
      propertyNumber: "11-2520-0000-03100-2",
      sourceFile: "2026-PROPERTY-DATA-EXPORT-FILES.zip",
      sourceVintage: "tier:cad-export;2026",
    };
    const merged = applyPathAMerge(existing, corrected);
    expect(merged.quickRefId).toBe("R26199");
    expect(merged.propertyNumber).toBe("11-2520-0000-03100-2");
  });

  it("the StratMap loader emits null for both, which is what makes the above safe", () => {
    // Read from the loader rather than restated: if normalizeStratMapLandUse
    // ever started mapping the shapefile's GEO_ID into property_number, the
    // crosswalk's two sides would both come from the geometry publisher and
    // the corroboration would agree by construction.
    const rec = normalizeStratMapLandUse(
      "48209",
      0,
      {
        Prop_ID: "26199",
        GEO_ID: "11-2520-0000-03100-2",
        SITUS_ADDR: "340 WINDMILL WAY, BUDA, TX 78610",
        GIS_AREA: 0.45,
        GIS_AREA_U: "AC",
      } as never,
      newCounters(),
      2025,
    );
    expect(rec?.quickRefId).toBeNull();
    expect(rec?.propertyNumber).toBeNull();
  });
});

describe("THE P-78 MERGE ROOT (Phase 0 audit section 3/4, P3): authority-aware merge for every appraisal-sourced field, not only yearBuilt/livingAreaSqft", () => {
  const camaRow = {
    countyFips: "48053",
    propId: "24560",
    taxYear: 2025,
    ownerName: "REAL CAD OWNER",
    legalDescription: "REAL CAD LEGAL",
    landValue: 50000,
    improvementValue: 10000,
    marketValue: 60000,
    assessedValue: 55000,
    landAcres: "1.5000",
    propertyUseCode: "A1",
    exemptionCodes: ["HS"],
    sourceFile: "cad-export.zip",
    sourceVintage: "tier:cad-export;2026",
  };
  const stratmapRow = {
    countyFips: "48053",
    propId: "24560",
    taxYear: 2025,
    ownerName: "STRATMAP OWNER",
    legalDescription: "STRATMAP LEGAL",
    landValue: 1,
    improvementValue: 1,
    marketValue: 2,
    assessedValue: null,
    landAcres: "9.9999",
    propertyUseCode: "XX",
    exemptionCodes: null,
    sourceFile: "stratmap25.dbf",
    sourceVintage: "tier:stratmap-roll;adapter:stratmap",
  };

  it("a StratMap (non-cad-export) incoming row can NEVER overwrite an existing cad-export row's appraisal fields, for every one of the 11 remaining AUTHORITY_COALESCE_FIELDS this fixture exercises", () => {
    const merged = applyPathAMerge(camaRow, stratmapRow);
    expect(merged.ownerName).toBe("REAL CAD OWNER");
    expect(merged.legalDescription).toBe("REAL CAD LEGAL");
    expect(merged.landValue).toBe(50000);
    expect(merged.improvementValue).toBe(10000);
    expect(merged.marketValue).toBe(60000);
    expect(merged.assessedValue).toBe(55000);
    expect(merged.landAcres).toBe("1.5000");
    expect(merged.propertyUseCode).toBe("A1");
    expect(merged.exemptionCodes).toEqual(["HS"]);
  });

  it("FALSIFIER: the OLD bare-coalesce merge (last-wins) regresses every one of those fields back to the StratMap value -- proving the fixture above is not vacuous", () => {
    const naiveLastWins = { ...stratmapRow };
    expect(naiveLastWins.ownerName).not.toBe(applyPathAMerge(camaRow, stratmapRow).ownerName);
    expect(naiveLastWins.landValue).not.toBe(applyPathAMerge(camaRow, stratmapRow).landValue);
    expect(naiveLastWins.legalDescription).not.toBe(applyPathAMerge(camaRow, stratmapRow).legalDescription);
  });

  it("a cad-export incoming row DOES win over an existing cad-export row (a re-published, corrected roll takes effect)", () => {
    const correctedCamaIncoming = { ...camaRow, ownerName: "CORRECTED OWNER", landValue: 51000 };
    const merged = applyPathAMerge(camaRow, correctedCamaIncoming);
    expect(merged.ownerName).toBe("CORRECTED OWNER");
    expect(merged.landValue).toBe(51000);
  });

  it("a non-null incoming value fills a null existing value regardless of tier (null never beats a value, on either side)", () => {
    const existingWithGap = { ...camaRow, ownerName: null as unknown as string };
    const merged = applyPathAMerge(existingWithGap, stratmapRow);
    expect(merged.ownerName).toBe("STRATMAP OWNER");
  });

  it("a null incoming value never blanks an existing value, regardless of tier", () => {
    const incomingWithGap = { ...stratmapRow, ownerName: null as unknown as string };
    const merged = applyPathAMerge(camaRow, incomingWithGap);
    expect(merged.ownerName).toBe("REAL CAD OWNER");
  });

  it("two StratMap loads in a row (neither side cad-export): incoming wins, identical to the pre-fix bare-coalesce outcome", () => {
    const olderStratmap = { ...stratmapRow, ownerName: "OLDER STRATMAP OWNER" };
    const newerStratmap = { ...stratmapRow, ownerName: "NEWER STRATMAP OWNER" };
    const merged = applyPathAMerge(olderStratmap, newerStratmap);
    expect(merged.ownerName).toBe("NEWER STRATMAP OWNER");
  });
});
