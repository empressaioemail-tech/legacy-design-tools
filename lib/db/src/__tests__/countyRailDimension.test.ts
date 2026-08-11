import { describe, it, expect } from "vitest";
import {
  COUNTY_RAIL_DECLARATION,
  COUNTY_RAIL_COUNT,
  COVERAGE_CLASS_BY_RAIL_KEY,
} from "../schema/countyRailDimension";

/**
 * Internal-consistency guard for the checked-in rail declaration
 * (`lib/db/src/schema/countyRailDimension.ts`). This CANNOT detect drift
 * against the atom contract or hauska-engine's `PROPERTY_ENTITY_TYPES` —
 * this repo has no live dependency edge to either (see the declaration
 * file's header for why a fully automatic derivation was not feasible).
 * What it CAN do is fail loudly if a future edit corrupts the shape this
 * file promises: a dropped rail, a duplicate ordinal, a gap in the
 * sequence, or `join` silently reappearing. That is a real, if narrower,
 * safety net — the freshness claim itself is a human verification step
 * recorded in the file's "VERIFIED AGAINST" comment, to be re-checked by
 * hand whenever a contract publish or engine PROPERTY_ENTITY_TYPES change
 * lands.
 */
describe("COUNTY_RAIL_DECLARATION", () => {
  it("has exactly 14 rails (join removed 2026-08-08; rrc split + rail-corridor added 2026-08-09)", () => {
    expect(COUNTY_RAIL_DECLARATION).toHaveLength(14);
    expect(COUNTY_RAIL_COUNT).toBe(14);
  });

  it("does not contain a 'join' rail", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    expect(keys).not.toContain("join");
  });

  it("has unique rail keys", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has ordinals 1..12 with no gap or duplicate", () => {
    const ordinals = COUNTY_RAIL_DECLARATION.map((r) => r.ordinal).sort(
      (a, b) => a - b,
    );
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it("pins owner as PRESENT with a writer (OWN lane, contract 1.16.0)", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    // The policy was ruled long before the carrier existed; both now exist.
    expect(byKey.get("owner")?.atomFamilyState).toBe("present");
    expect(byKey.get("owner")?.hasWriter).toBe(true);
  });

  it("splits RRC by source+geometry and keeps the tracks/Commission distinction", () => {
    const keys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey);
    // The merged rail is gone: one cell could not honestly score a point
    // layer and a line layer from two different endpoints.
    expect(keys).not.toContain("rrc");
    expect(keys).toContain("rrc-wells");
    expect(keys).toContain("rrc-pipelines");
    // Railroad TRACKS, not the Railroad COMMISSION. Separate domain.
    expect(keys).toContain("rail-corridor");

    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    // Corrected from the stale-optimistic 'partial': the property spine
    // holds zero ADR-025 O&G atoms, whatever og-twin has published.
    expect(byKey.get("rrc-wells")?.atomFamilyState).toBe("missing");
    expect(byKey.get("rrc-pipelines")?.atomFamilyState).toBe("missing");
    expect(byKey.get("rail-corridor")?.atomFamilyState).toBe("missing");
    // None has a writer yet — the new cells must read honestly as gaps.
    expect(byKey.get("rrc-wells")?.hasWriter).toBe(false);
    expect(byKey.get("rrc-pipelines")?.hasWriter).toBe(false);
    expect(byKey.get("rail-corridor")?.hasWriter).toBe(false);
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

  it("pins the five corrected rail states from the 2026-08-08 refresh (fix/county-rail-refresh)", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));

    // geometry: parcel-node shipped in contract 1.13.0 + engine PR #282 -- present now, was 'missing'.
    // hasWriter flipped true 2026-08-09 -- countyGeometryScoreCli.ts scores
    // parcel-node atom count (ATOMS store) against txgio_parcel DISTINCT
    // feature_index (DEPLOYMENT store) and writes county_facet_coverage
    // facet='geometry'.
    expect(byKey.get("geometry")?.atomFamilyState).toBe("present");
    expect(byKey.get("geometry")?.hasWriter).toBe(true);

    // footprint: building-footprint published 1.12.0 + engine PR #282 -- present now, was 'unpublished'.
    expect(byKey.get("footprint")?.atomFamilyState).toBe("present");

    // easement: utility-easement published 1.12.0 + engine PR #282 -- present now, was 'unpublished'.
    expect(byKey.get("easement")?.atomFamilyState).toBe("present");

    // cad / flood / landuse: engine PR #291 atom writers shipped 2026-08-09.
    expect(byKey.get("cad")?.atomFamilyState).toBe("present");
    expect(byKey.get("cad")?.hasWriter).toBe(true);
    expect(byKey.get("flood")?.atomFamilyState).toBe("present");
    expect(byKey.get("flood")?.hasWriter).toBe(true);
    expect(byKey.get("landuse")?.atomFamilyState).toBe("present");
    expect(byKey.get("landuse")?.hasWriter).toBe(true);
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

  it("pins mud rail metadata after P1-4 (special-district-fact)", () => {
    const byKey = new Map(COUNTY_RAIL_DECLARATION.map((r) => [r.railKey, r]));
    expect(byKey.get("mud")?.declaredSource).toMatch(/TCEQ WaterDistricts/i);
    expect(byKey.get("mud")?.displayName).toBe("Special districts");
  });
});
