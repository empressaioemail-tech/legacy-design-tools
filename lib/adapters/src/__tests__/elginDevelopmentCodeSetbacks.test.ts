/**
 * Elgin setback table port + routing (doc_repo
 * _decisions/2026-08-04_elgin_setback_table_ratified.md — ratified
 * 2026-08-04, ported from hauska-engine's local setbacks copy).
 */

import { describe, expect, it } from "vitest";

import {
  getSetbackTable,
  getSetbackTableForZoning,
} from "../local/setbacks/index.js";

describe("elgin-development-code setback router", () => {
  it("routes the GIS cityKey (elgin-tx) to elgin-development-code", () => {
    const table = getSetbackTableForZoning("elgin-tx", "R-1");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("elgin-development-code");
  });

  it("carries all 8 Euclidean districts from Sec. 46-203", () => {
    const table = getSetbackTable("elgin-development-code")!;
    const names = table.districts.map((d) => d.district_name);
    for (const prefix of ["R-1", "R-2", "R-3", "R-4", "C-1", "C-2", "C-3", "I "]) {
      expect(names.some((n) => n.startsWith(prefix))).toBe(true);
    }
    expect(table.districts).toHaveLength(8);
  });

  it("R-1 scalars match the transcribed ordinance values", () => {
    const table = getSetbackTableForZoning("elgin-tx", "R-1")!;
    const d = table.districts.find((row) =>
      row.district_name.startsWith("R-1"),
    )!;
    expect(d.front_ft).toBe(25);
    expect(d.rear_ft).toBe(10);
    expect(d.side_ft).toBe(7.5);
    expect(d.side_corner_ft).toBe(15);
  });

  it("R-4's canonical name is used even though the GIS layer stamps it 'A'", () => {
    const table = getSetbackTableForZoning("elgin-tx", "R-1")!;
    expect(
      table.districts.some((d) =>
        d.district_name.startsWith("R-4 Multiple-Family"),
      ),
    ).toBe(true);
  });

  it("conditional cells (C-2) carry the ratification's governed_by routing directive", () => {
    const table = getSetbackTable("elgin-development-code")!;
    const c2 = table.districts.find((d) => d.district_name.startsWith("C-2"))!;
    const provenance = c2.provenance as Record<string, Record<string, unknown>>;
    const hasGovernedBy = Object.values(provenance).some(
      (field) => "governed_by" in field || "governed_by_dwellings" in field,
    );
    expect(hasGovernedBy).toBe(true);
  });

  it("does not fall through to a bare 'elgin-tx' table (only the routed key exists)", () => {
    expect(getSetbackTable("elgin-tx")).toBeNull();
  });
});
