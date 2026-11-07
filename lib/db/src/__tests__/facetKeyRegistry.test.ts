/**
 * FACET KEY DIVERGENCE TEST — the control, not a nicety.
 *
 * `countyCoverageScoreCli.ts` wrote facet `land-use` while the rail key is
 * `landuse`. The manifest grid joins `c.facet = r.rail_key`, so 19 production
 * rows were written, joined by nothing, and read by no cell — for four weeks,
 * across two instruments, with nothing failing.
 *
 * DEV_PROCESS 2.4: when one rule has two implementations, the divergence test
 * IS the control. These cases are written so that reintroducing the original
 * defect fails CI, and so that the NEGATIVE cases prove the check can fire
 * (DEV_PROCESS 2.2 — a gate that cannot fail for the right reason is a defect,
 * not a test).
 */

import { describe, it, expect } from "vitest";
import {
  RAIL_FACET_KEYS,
  DIAGNOSTIC_FACET_KEYS,
  DIAGNOSTIC_FACET_DECLARATIONS,
  RETIRED_FACET_KEYS,
  WRITABLE_FACET_KEYS,
  facetKeyCollisionForm,
  checkFacetKey,
  assertWritableFacetKeys,
  assertRailLedgerRowFixture,
} from "../schema/facetKeyRegistry";
import { COUNTY_RAIL_DECLARATION } from "../schema/countyRailDimension";

describe("facet key registry", () => {
  it("derives rail keys from the rail declaration, never a second list", () => {
    expect(RAIL_FACET_KEYS.size).toBe(COUNTY_RAIL_DECLARATION.length);
    for (const rail of COUNTY_RAIL_DECLARATION) {
      expect(RAIL_FACET_KEYS.has(rail.railKey)).toBe(true);
    }
  });

  it("accepts every rail key", () => {
    for (const key of RAIL_FACET_KEYS) {
      expect(checkFacetKey(key)).toBeNull();
    }
  });

  it("accepts every declared diagnostic key", () => {
    for (const key of DIAGNOSTIC_FACET_KEYS) {
      expect(checkFacetKey(key)).toBeNull();
    }
  });

  // --- the defect itself, pinned ---

  it("REJECTS 'land-use', the key that orphaned 19 production rows", () => {
    const v = checkFacetKey("land-use");
    expect(v).not.toBeNull();
    expect(v?.reason).toContain("RETIRED");
  });

  it("REJECTS any near miss that collapses onto a rail key", () => {
    // None of these is equal to a rail key, so a set-equality control passes
    // them all. Every one of them would write a row nothing can join.
    for (const nearMiss of ["land_use", "Landuse", "RAIL-CORRIDOR", "rrc_wells", "foot-print"]) {
      const v = checkFacetKey(nearMiss);
      expect(v, `${nearMiss} must be rejected`).not.toBeNull();
    }
  });

  it("REJECTS an unknown key outright", () => {
    const v = checkFacetKey("wetlands");
    expect(v).not.toBeNull();
    expect(v?.reason).toContain("neither a rail key nor a declared diagnostic");
  });

  it("collision form normalises hyphens, underscores and case", () => {
    expect(facetKeyCollisionForm("land-use")).toBe("landuse");
    expect(facetKeyCollisionForm("LAND_USE")).toBe("landuse");
    expect(facetKeyCollisionForm("landuse")).toBe("landuse");
  });

  // --- the invariant that keeps the registry itself honest ---

  it("no diagnostic key collides with any rail key", () => {
    const railForms = new Set([...RAIL_FACET_KEYS].map(facetKeyCollisionForm));
    for (const d of DIAGNOSTIC_FACET_KEYS) {
      expect(
        railForms.has(facetKeyCollisionForm(d)),
        `diagnostic '${d}' collapses onto a rail key`,
      ).toBe(false);
    }
  });

  it("no retired key is also writable", () => {
    for (const r of RETIRED_FACET_KEYS) {
      expect(WRITABLE_FACET_KEYS.has(r)).toBe(false);
    }
  });

  it("every diagnostic declares what it measures and why it is not a rail", () => {
    for (const d of DIAGNOSTIC_FACET_DECLARATIONS) {
      expect(d.measures.length).toBeGreaterThan(20);
      expect(d.notARailBecause.length).toBeGreaterThan(20);
      expect(d.writerRef.length).toBeGreaterThan(0);
    }
  });

  // --- the fail-closed guard a writer actually calls ---

  it("assertWritableFacetKeys passes a legal set", () => {
    expect(() =>
      assertWritableFacetKeys(["zoning", "envelope", "landuse-cad-join"]),
    ).not.toThrow();
  });

  it("assertWritableFacetKeys THROWS on the historical set, before any write", () => {
    expect(() =>
      assertWritableFacetKeys(["land-use", "zoning", "envelope"]),
    ).toThrow(/land-use/);
  });

  it("assertWritableFacetKeys reports every violation, not just the first", () => {
    let message = "";
    try {
      assertWritableFacetKeys(["land-use", "wetlands", "zoning"]);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("land-use");
    expect(message).toContain("wetlands");
  });

  // --- row-shaped fixtures used as RAIL cells ---

  it("accepts a ledger-row fixture whose facet is a rail key", () => {
    const railRow = {
      county_fips: "48021",
      facet: "landuse",
      honest_coverage_pct: "98.26",
    };
    expect(() => assertRailLedgerRowFixture(railRow)).not.toThrow();
  });

  it("REJECTS a ledger-row fixture that uses retired land-use as a rail key", () => {
    const orphanAsRail = {
      county_fips: "48021",
      facet: "land-use",
      honest_coverage_pct: "98.01",
    };
    expect(() => assertRailLedgerRowFixture(orphanAsRail)).toThrow(/RETIRED/);
    expect(RAIL_FACET_KEYS.has(orphanAsRail.facet)).toBe(false);
    expect(RETIRED_FACET_KEYS.has(orphanAsRail.facet)).toBe(true);
  });
});
