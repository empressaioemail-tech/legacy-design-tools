import { describe, it, expect } from "vitest";
import {
  COUNTY_RAIL_DECLARATION,
  COUNTY_RAIL_COUNT,
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
  it("has exactly 12 rails (join quality removed 2026-08-08)", () => {
    expect(COUNTY_RAIL_DECLARATION).toHaveLength(12);
    expect(COUNTY_RAIL_COUNT).toBe(12);
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
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
    expect(byKey.get("geometry")?.atomFamilyState).toBe("present");
    expect(byKey.get("geometry")?.hasWriter).toBe(false);

    // footprint: building-footprint published 1.12.0 + engine PR #282 -- present now, was 'unpublished'.
    expect(byKey.get("footprint")?.atomFamilyState).toBe("present");

    // easement: utility-easement published 1.12.0 + engine PR #282 -- present now, was 'unpublished'.
    expect(byKey.get("easement")?.atomFamilyState).toBe("present");

    // landuse: atomFamilyState stays 'missing' (no land-use atom exists anywhere).
    // hasWriter stays true -- backed by the live CAD-roll scorer
    // (countyCoverageScoreCli.ts), NOT the dead Cotality land_use_code path.
    expect(byKey.get("landuse")?.atomFamilyState).toBe("missing");
    expect(byKey.get("landuse")?.hasWriter).toBe(true);
  });
});
