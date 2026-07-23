/**
 * District-mapping tests (Problem B): zoningCode -> district, with honest
 * null for absent/unmatched codes (caller declines; no invented district).
 */

import { describe, it, expect } from "vitest";
import {
  getSetbackTableForZoning,
  type SetbackTable,
} from "@workspace/adapters";
import { mapDistrict, districtCode, normalizeCode } from "./districtMapping";

const TABLE: SetbackTable = {
  jurisdictionKey: "test-tx",
  jurisdictionDisplayName: "Test, TX",
  districts: [
    {
      district_name: "R-HD Residential High Density",
      front_ft: 20,
      rear_ft: 15,
      side_ft: 5,
      side_corner_ft: 12,
      max_height_ft: 45,
      max_lot_coverage_pct: 50,
      max_impervious_pct: 65,
      citation_url: "https://example/hd",
    },
    {
      district_name: "R-MD Residential Medium Density",
      front_ft: 25,
      rear_ft: 20,
      side_ft: 7.5,
      side_corner_ft: 15,
      max_height_ft: 35,
      max_lot_coverage_pct: 40,
      max_impervious_pct: 55,
      citation_url: "https://example/md",
    },
    {
      district_name: "R-LD Residential Low Density",
      front_ft: 30,
      rear_ft: 25,
      side_ft: 10,
      side_corner_ft: 20,
      max_height_ft: 35,
      max_lot_coverage_pct: 35,
      max_impervious_pct: 50,
      citation_url: "https://example/ld",
    },
  ],
};

describe("normalizeCode / districtCode", () => {
  it("strips punctuation and uppercases", () => {
    expect(normalizeCode("r-md")).toBe("RMD");
    expect(districtCode(TABLE.districts[1]!)).toBe("RMD");
  });
});

describe("mapDistrict — exact match", () => {
  it("maps a zoningCode to its district", () => {
    const r = mapDistrict(TABLE, "R-MD")!;
    expect(r.kind).toBe("matched");
    expect(r.district.district_name).toContain("R-MD");
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("is punctuation/case insensitive", () => {
    const r = mapDistrict(TABLE, "rmd")!;
    expect(r.district.district_name).toContain("R-MD");
    expect(r.kind).toBe("matched");
  });
});

describe("mapDistrict — guarded prefix match", () => {
  it("maps a multi-character district stem to a suffix variant", () => {
    const r = mapDistrict(TABLE, "R-MDA")!;
    expect(r.kind).toBe("matched");
    expect(r.district.district_name).toContain("R-MD");
    expect(r.confidence).toBe(0.7);
  });

  it("routes Bastrop B3 P-5 to its populated city place-type row", () => {
    const table = getSetbackTableForZoning("bastrop_tx", "P-5");
    expect(table?.jurisdictionKey).toBe("bastrop-city-tx");
    expect(table?.districts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          district_name: "P-5 Core",
          front_ft: 15,
        }),
      ]),
    );
    expect(table?.note).toMatch(/B3 Code/i);
    const result = mapDistrict(table!, "P-5");
    expect(result?.kind).toBe("matched");
    expect(result?.district.district_name).toBe("P-5 Core");
    expect(result?.district.district_name).not.toMatch(/^P Public\/Institutional$/);
  });
});

describe("mapDistrict — unmatched/absent", () => {
  it("returns null for an unknown explicit code so the caller can decline", () => {
    expect(mapDistrict(TABLE, "C-2")).toBeNull();
  });

  it("uses the conservative fallback when no zoning is present", () => {
    const r = mapDistrict(TABLE, null)!;
    expect(r.kind).toBe("fallback-conservative");
    expect(r.district.district_name).toContain("R-LD");
    expect(r.note).toMatch(/no zoning/i);
  });
});

describe("mapDistrict — single-district table", () => {
  it("uses the only district", () => {
    const single: SetbackTable = {
      ...TABLE,
      districts: [TABLE.districts[0]!],
    };
    const r = mapDistrict(single, null)!;
    expect(r.kind).toBe("single");
    expect(r.confidence).toBeGreaterThan(0.5);
  });
});
