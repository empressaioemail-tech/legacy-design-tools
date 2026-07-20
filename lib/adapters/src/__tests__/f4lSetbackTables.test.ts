import { describe, expect, it } from "vitest";
import {
  getSetbackTable,
  getSetbackDistrict,
  SETBACK_JURISDICTION_KEYS,
  type SetbackTable,
} from "../local/setbacks";

/**
 * F4l batch setback-table loader tests (Georgetown, Round Rock, Leander, Hutto,
 * New Braunfels).
 *
 * These tables are the citation-backed dimensional rules that the buildable-
 * envelope route (brokeragePlaceBuildableEnvelope) draws onto a parcel and
 * cites back to the user, so the load path and the shape are covered here. The
 * numeric values were adversarially verified against the live ordinances
 * (Municode content API for the four Municode cities; the city-hosted UDC PDF
 * for Hutto) at PR time; this suite asserts the tables are registered, resolve
 * under the synthesized jurisdiction keys, and carry the expected districts +
 * per-value provenance.
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

describe("F4l setback tables", () => {
  it("registers all five F4l jurisdictions", () => {
    expect(SETBACK_JURISDICTION_KEYS).toEqual(
      expect.arrayContaining([
        "georgetown-tx",
        "round-rock-tx",
        "leander-tx",
        "hutto-tx",
        "new-braunfels-tx",
      ]),
    );
  });

  it("resolves Georgetown under its synthesized key (underscore -> hyphen)", () => {
    const table = getSetbackTable("georgetown_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("georgetown-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Georgetown, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "RE Residential Estate",
        "RS Residential Single-Family",
        "MF-2 High Density Multifamily",
        "C-3 General Commercial",
      ]),
    );
    // Spot-check verified values: RS front 20, side 6; MF-2 height 45.
    const rs = getSetbackDistrict("georgetown_tx", "RS Residential Single-Family");
    expect(rs?.front_ft).toBe(20);
    expect(rs?.side_ft).toBe(6);
    const mf2 = getSetbackDistrict("georgetown_tx", "MF-2 High Density Multifamily");
    expect(mf2?.max_height_ft).toBe(45);
  });

  it("resolves Round Rock under its synthesized key", () => {
    const table = getSetbackTable("round_rock_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("round-rock-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Round Rock, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "SF-1 Single-Family Residential 1",
        "SF-2 Single-Family Residential 2 (Conventional)",
        "MF-1 Multifamily Residential 1",
      ]),
    );
    // Spot-check: SF-1 front 30, coverage 40; height not_specified -> stand-in 100.
    const sf1 = getSetbackDistrict("round_rock_tx", "SF-1 Single-Family Residential 1");
    expect(sf1?.front_ft).toBe(30);
    expect(sf1?.max_lot_coverage_pct).toBe(40);
    expect(sf1?.max_height_ft).toBe(100);
  });

  it("resolves Leander under its synthesized key", () => {
    const table = getSetbackTable("leander_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("leander-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Leander, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "SFR Single-Family Residential",
        "TH Townhome",
        "MF Multifamily",
      ]),
    );
    // Spot-check: SFR front 25, side 7, corner 15.
    const sfr = getSetbackDistrict("leander_tx", "SFR Single-Family Residential");
    expect(sfr?.front_ft).toBe(25);
    expect(sfr?.side_ft).toBe(7);
    expect(sfr?.side_corner_ft).toBe(15);
  });

  it("resolves Hutto under its synthesized key", () => {
    const table = getSetbackTable("hutto_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("hutto-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of Hutto, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "SF-R Single-Family Residential Rural",
        "SF-1 Single-Family Residential",
        "LI/I Light Industrial / Industrial",
      ]),
    );
    // Spot-check: SF-R front 50, height 45; SF-1 front 25.
    const sfr = getSetbackDistrict("hutto_tx", "SF-R Single-Family Residential Rural");
    expect(sfr?.front_ft).toBe(50);
    expect(sfr?.max_height_ft).toBe(45);
  });

  it("resolves New Braunfels under its synthesized key", () => {
    const table = getSetbackTable("new_braunfels_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("new-braunfels-tx");
    expect(table!.jurisdictionDisplayName).toBe("City of New Braunfels, TX");
    assertWellFormed(table!);
    const names = table!.districts.map((d) => d.district_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "R-1A-8 Single-Family",
        "R-3L Multifamily Low Density",
        "C-O Commercial Office",
      ]),
    );
    // Spot-check: R-1A-8 front 25, side 10, height 35.
    const r1a8 = getSetbackDistrict("new_braunfels_tx", "R-1A-8 Single-Family");
    expect(r1a8?.front_ft).toBe(25);
    expect(r1a8?.side_ft).toBe(10);
    expect(r1a8?.max_height_ft).toBe(35);
  });
});
