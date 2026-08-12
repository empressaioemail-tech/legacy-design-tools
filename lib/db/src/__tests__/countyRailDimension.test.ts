import { describe, it, expect } from "vitest";
import {
  COUNTY_RAIL_DECLARATION,
  COUNTY_RAIL_COUNT,
  COVERAGE_CLASS_BY_RAIL_KEY,
} from "../schema/countyRailDimension";

/**
 * Internal-consistency guard for the checked-in rail declaration.
 * hasWriter is derived by railManifestDerivation / refresh CLI — this file
 * must not pin hand-declared booleans (SF-26). Rail identity is the ruled
 * key list below, not a tautological COUNT===length pin.
 */
const RULED_RAIL_KEYS = [
  "geometry",
  "cad",
  "zoning",
  "roads",
  "flood",
  "envelope",
  "landuse",
  "footprint",
  "easement",
  "owner",
  "rrc-wells",
  "rrc-pipelines",
  "rail-corridor",
  "mud",
] as const;

describe("COUNTY_RAIL_DECLARATION", () => {
  it("declares the ruled rail key set", () => {
    expect(COUNTY_RAIL_DECLARATION.map((r) => r.railKey)).toEqual([
      ...RULED_RAIL_KEYS,
    ]);
    expect(COUNTY_RAIL_COUNT).toBe(RULED_RAIL_KEYS.length);
  });

  it("does not hand-declare hasWriter (derived at refresh; SF-26)", () => {
    for (const r of COUNTY_RAIL_DECLARATION) {
      expect("hasWriter" in r).toBe(false);
    }
  });

  it("does not contain a 'join' rail", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    expect(keys).not.toContain("join");
  });

  it("has unique rail keys", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has ordinals 1..N with no gap or duplicate", () => {
    const ordinals = COUNTY_RAIL_DECLARATION.map((r) => r.ordinal).sort(
      (a, b) => a - b,
    );
    expect(ordinals).toEqual(
      Array.from({ length: RULED_RAIL_KEYS.length }, (_, i) => i + 1),
    );
  });

  it("pins owner atom family as present (OWN lane, contract 1.16.0)", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    expect(byKey.get("owner")?.atomFamilyState).toBe("present");
  });

  it("splits RRC by source+geometry and keeps the tracks/Commission distinction", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    expect(keys).not.toContain("rrc");
    expect(keys).toContain("rrc-wells");
    expect(keys).toContain("rrc-pipelines");
    expect(keys).toContain("rail-corridor");

    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    expect(byKey.get("rrc-wells")?.atomFamilyState).toBe("missing");
    expect(byKey.get("rrc-pipelines")?.atomFamilyState).toBe("missing");
    expect(byKey.get("rail-corridor")?.atomFamilyState).toBe("missing");
  });

  it("every atomFamilyState is one of the four the county_rail CHECK constraint allows", () => {
    const allowed = new Set(["present", "missing", "partial", "unpublished"]);
    for (const r of COUNTY_RAIL_DECLARATION) {
      expect(allowed.has(r.atomFamilyState)).toBe(true);
    }
  });

  it("every kind is spine or derived, matching the county_rail CHECK constraint", () => {
    for (const r of COUNTY_RAIL_DECLARATION) {
      expect(["spine", "derived"]).toContain(r.kind);
    }
  });

  it("pins atomFamilyState for rails corrected in the 2026-08-08 refresh", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    expect(byKey.get("geometry")?.atomFamilyState).toBe("present");
    expect(byKey.get("footprint")?.atomFamilyState).toBe("present");
    expect(byKey.get("easement")?.atomFamilyState).toBe("present");
    expect(byKey.get("cad")?.atomFamilyState).toBe("present");
    expect(byKey.get("flood")?.atomFamilyState).toBe("present");
    expect(byKey.get("landuse")?.atomFamilyState).toBe("present");
  });

  it("assigns coverageClass per OPS-14 jurisdiction-depth vs statewide-uniform split", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    for (const key of ["cad", "owner", "zoning", "envelope", "landuse", "easement"]) {
      expect(byKey.get(key)?.coverageClass).toBe("jurisdiction-depth");
      expect(COVERAGE_CLASS_BY_RAIL_KEY[key]).toBe("jurisdiction-depth");
    }
    for (const key of [
      "geometry",
      "roads",
      "flood",
      "footprint",
      "rrc-wells",
      "rrc-pipelines",
      "rail-corridor",
      "mud",
    ]) {
      expect(byKey.get(key)?.coverageClass).toBe("statewide-uniform");
      expect(COVERAGE_CLASS_BY_RAIL_KEY[key]).toBe("statewide-uniform");
    }
    expect(Object.keys(COVERAGE_CLASS_BY_RAIL_KEY)).toHaveLength(COUNTY_RAIL_COUNT);
  });

  it("pins mud rail atom family as present after P1-4 (special-district-fact)", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    expect(byKey.get("mud")?.atomFamilyState).toBe("present");
    expect(byKey.get("mud")?.declaredSource).toMatch(/TCEQ WaterDistricts/i);
    expect(byKey.get("mud")?.displayName).toBe("Special districts");
  });
});
