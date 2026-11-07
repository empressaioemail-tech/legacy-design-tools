/**
 * District-mapping tests (Problem B): zoningCode -> district, with honest
 * null for absent/unmatched codes (caller declines; no invented district).
 */

import { describe, it, expect } from "vitest";
import {
  getSetbackTable,
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

  it("routes Bastrop BDC SF-1 to bastrop-development-code row", () => {
    const table = getSetbackTableForZoning("bastrop_tx", "SF-1");
    expect(table?.jurisdictionKey).toBe("bastrop-development-code");
    const result = mapDistrict(table!, "SF-1");
    expect(result?.kind).toBe("matched");
    expect(result?.district.district_name).toMatch(/^SF-1/);
    expect(result?.district.front_ft).toBe(30);
  });

  it("honest-declines repealed Bastrop B3 P-5 (no current-law table)", () => {
    expect(getSetbackTableForZoning("bastrop_tx", "P-5")).toBeNull();
  });
  it("does not invent Kyle R-1 envelopes for R-1-T townhouse stamps", () => {
    const table = getSetbackTable("kyle-tx");
    expect(table).not.toBeNull();
    // Bare R-1 was omitted from the table because its code prefixes R-1-T.
    expect(mapDistrict(table!, "R-1-T")).toBeNull();
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
    expect(r.note).toMatch(/no zoning stamp/i);
    expect(r.note).toMatch(/not a district determination/i);
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

/**
 * Burnet pack E (2026-10-13): Marble Falls is the first Burnet city whose stamped codes are a MIX of
 * served and refused districts in one table. The edition gate refuses the 10 refused codes before
 * mapDistrict is reached, but the whole table is also served raw (/local/setbacks/:key), so the
 * table itself must never let a refused stamped code cross into a served row by prefix.
 */
describe("marble-falls-tx: every stamped code maps to its own row or to none (pack E)", () => {
  const SERVED = ["ENZ.1", "ENZ.2", "ENZ.3", "ENZ.4", "ENZ.5", "BP", "IN"];
  const REFUSED = ["NR", "GC", "DR", "NC", "DN", "TR", "DT", "RE", "FR", "MR"];

  it("each served code is an exact match to its own row", () => {
    for (const code of SERVED) {
      const table = getSetbackTableForZoning("marble-falls-tx", code)!;
      const r = mapDistrict(table, code)!;
      expect(r.kind, code).toBe("matched");
      expect(districtCode(r.district), code).toBe(normalizeCode(code));
    }
  });

  it("each refused code maps to NO row of the raw table (no prefix crossing), and the edition gate refuses it by name", () => {
    const table = getSetbackTable("marble-falls-tx")!;
    for (const code of REFUSED) {
      expect(mapDistrict(table, code), code).toBeNull();
      expect(() => getSetbackTableForZoning("marble-falls-tx", code), code).toThrow();
    }
  });
});
