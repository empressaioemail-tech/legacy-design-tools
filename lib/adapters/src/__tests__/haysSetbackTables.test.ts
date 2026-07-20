import { describe, expect, it } from "vitest";
import {
  getSetbackTable,
  getSetbackDistrict,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
} from "../local/setbacks";

/**
 * Hays County batch (F4k) setback-table loader tests.
 *
 * These tables are the citation-backed dimensional rules that the buildable-
 * envelope route (brokeragePlaceBuildableEnvelope) draws onto a parcel and
 * cites back to the user, so the load path and the shape are covered here.
 * The numeric values themselves were adversarially verified against the live
 * ordinances (Municode / eCode360) at PR time; this suite asserts the tables
 * are registered, resolve under the synthesized jurisdiction keys, and carry
 * the expected districts + per-value provenance.
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
    for (const f of NUMERIC_FIELDS) {
      expect(typeof d[f]).toBe("number");
      expect(Number.isFinite(d[f])).toBe(true);
      expect(d[f]).toBeGreaterThanOrEqual(0);
    }
    // Fan-out tables MUST carry a per-value provenance block (README + gate).
    expect(d.provenance).toBeTruthy();
    // Every citation deep-links to the source ordinance.
    expect(d.citation_url).toMatch(/^https:\/\//);
  }
}

describe("Hays County setback tables (F4k)", () => {
  it("registers all three Hays jurisdictions", () => {
    expect(SETBACK_JURISDICTION_KEYS).toEqual(
      expect.arrayContaining(["dripping-springs-tx", "kyle-tx", "buda-tx"]),
    );
  });

  it("resolves Dripping Springs under its synthesized key (underscore -> hyphen)", () => {
    // brokeragePlaceBuildableEnvelope synthesizes `dripping_springs_tx`;
    // the loader normalizes underscores to hyphens.
    const table = getSetbackTable("dripping_springs_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("dripping-springs-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Dripping Springs, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "SF-1 Single-Family Residential Low Density",
        "SF-2 Single-Family Residential Moderate Density",
        "SF-3 Single-Family Residential Town Center",
        "MF Multiple-Family Residential",
      ]),
    );
    // Spot-check a verified value: SF-3 town center front yard = 10 ft.
    const sf3 = getSetbackDistrict(
      "dripping_springs_tx",
      "SF-3 Single-Family Residential Town Center",
    );
    expect(sf3?.front_ft).toBe(10);
    expect(sf3?.side_corner_ft).toBe(7.5);
  });

  it("resolves Kyle under its synthesized key", () => {
    const table = getSetbackTable("kyle_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("kyle-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Kyle, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "R-1-1 Single-Family Residential 1",
        "R-1-2 Single-Family Residential 2",
        "R-1-3 Single-Family Residential 3",
        "R-2 Residential Two-Family (Duplex)",
      ]),
    );
    // Spot-check a verified value: R-1-1 front setback = 35 ft (Chart 1).
    const r11 = getSetbackDistrict("kyle_tx", "R-1-1 Single-Family Residential 1");
    expect(r11?.front_ft).toBe(35);
    expect(r11?.max_impervious_pct).toBe(50);
  });

  it("resolves Buda under its synthesized key", () => {
    const table = getSetbackTable("buda_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("buda-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Buda, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "R-1 Estate Residential",
        "R-2 Suburban Residential",
        "R-3 One & Two Family Residential",
      ]),
    );
    // Buda is the only Hays jurisdiction whose code states BOTH building
    // coverage and impervious cover; spot-check R-3 (both distinct).
    const r3 = getSetbackDistrict("buda_tx", "R-3 One & Two Family Residential");
    expect(r3?.max_lot_coverage_pct).toBe(50);
    expect(r3?.max_impervious_pct).toBe(60);
    expect(r3?.side_ft).toBe(7.5);
    expect(r3?.side_corner_ft).toBe(10);
  });
});
