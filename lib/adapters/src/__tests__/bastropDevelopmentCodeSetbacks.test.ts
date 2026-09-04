/**
 * WDLL 2026-07-29 BDC STEP 3 — bastrop setback routing (LDT adapters).
 */

import { describe, expect, it } from "vitest";

import {
  getSetbackTable,
  getSetbackTableForZoning,
  getSetbackDistrict,
} from "../local/setbacks/index.js";

describe("bastrop-development-code setback router (WDLL STEP 3)", () => {
  it("routes bastrop-tx + SF-1 to bastrop-development-code", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "SF-1");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("bastrop-development-code");
    const d = table!.districts.find((row) =>
      row.district_name.toUpperCase().startsWith("SF-1"),
    );
    expect(d).toBeDefined();
    expect(d!.front_ft).toBe(30);
    expect(d!.side_ft).toBe(10);
    expect(d!.side_corner_ft).toBe(20);
    expect(d!.rear_ft).toBe(30);
  });

  it("routes SF-2 / SF-3 / RR to bastrop-development-code", () => {
    for (const code of ["SF-2", "SF-3", "RR"] as const) {
      const table = getSetbackTableForZoning("bastrop-tx", code);
      expect(table!.jurisdictionKey).toBe("bastrop-development-code");
      const token = code;
      expect(
        table!.districts.some((d) =>
          d.district_name.toUpperCase().startsWith(token),
        ),
      ).toBe(true);
    }
  });

  it("MU / GC / PDD route to BDC table with no chart rows (honest-decline)", () => {
    for (const code of ["MU", "GC", "PDD"] as const) {
      const table = getSetbackTableForZoning("bastrop-tx", code);
      expect(table!.jurisdictionKey).toBe("bastrop-development-code");
      expect(
        table!.districts.some(
          (d) => (d.district_name.trim().split(/\s+/)[0] ?? "").toUpperCase() === code,
        ),
      ).toBe(false);
    }
  });

  it("repealed P-3 does NOT route to bastrop-city-tx as current", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "P-3")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-city-tx", "P-3")).toBeNull();
  });

  it("repealed P-5 / P-EC honest-decline; archival B3 by direct key only", () => {
    expect(getSetbackTableForZoning("bastrop-tx", "P-5")).toBeNull();
    expect(getSetbackTableForZoning("bastrop-tx", "P-EC")).toBeNull();
    const archival = getSetbackTable("bastrop-city-tx");
    expect(archival!.jurisdictionKey).toBe("bastrop-city-tx");
    expect(
      archival!.districts.some((d) => d.district_name.startsWith("P-3")),
    ).toBe(true);
  });

  it("legacy county R-MD still uses bastrop-tx table (not BDC city path)", () => {
    const table = getSetbackTableForZoning("bastrop-tx", "R-MD");
    expect(table!.jurisdictionKey).toBe("bastrop-tx");
    const d = getSetbackDistrict("bastrop-tx", "R-MD Residential Medium Density");
    expect(d!.front_ft).toBe(25);
  });

  it("does not fall through SF-1 to bastrop-tx legacy table", () => {
    const legacy = getSetbackTable("bastrop-tx")!;
    expect(
      legacy.districts.some((d) =>
        d.district_name.toUpperCase().startsWith("SF-1"),
      ),
    ).toBe(false);
    const routed = getSetbackTableForZoning("bastrop_tx", "SF-1")!;
    expect(routed.jurisdictionKey).toBe("bastrop-development-code");
  });
});
