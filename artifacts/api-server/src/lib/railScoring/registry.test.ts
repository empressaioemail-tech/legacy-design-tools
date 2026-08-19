/**
 * REGISTRY DIVERGENCE TESTS — the control, not a style check.
 *
 * DEV_PROCESS 2.4: when one rule has two implementations, the divergence test
 * IS the control. The rail dimension (`COUNTY_RAIL_DECLARATION`) and the
 * scoring registry are two lists describing one set of rails, and CTRL-1
 * happened because exactly that shape went untested. Adding a rail must be
 * impossible to half-do.
 */

import { describe, it, expect } from "vitest";
import { COUNTY_RAIL_DECLARATION } from "@workspace/db/schema";
import {
  RAIL_SCORING_DECLARATION,
  absenceProbeCoversCounty,
  railScoringRuleFor,
  scoreableRailKeys,
  thresholdPctForRail,
  unspecifiedRails,
  type AbsenceProbeSpec,
} from "./registry";

describe("registry / rail-dimension divergence", () => {
  it("declares a scoring rule for EVERY rail in COUNTY_RAIL_DECLARATION", () => {
    const dimensionKeys = COUNTY_RAIL_DECLARATION.map((r) => r.railKey).sort();
    const registryKeys = RAIL_SCORING_DECLARATION.map((r) => r.railKey).sort();
    expect(registryKeys).toEqual(dimensionKeys);
  });

  it("declares NO rail the dimension does not have", () => {
    // The other direction of the same identity, asserted separately so a
    // failure names which side drifted.
    const dimensionKeys = new Set(COUNTY_RAIL_DECLARATION.map((r) => r.railKey));
    const strays = RAIL_SCORING_DECLARATION.filter(
      (r) => !dimensionKeys.has(r.railKey),
    ).map((r) => r.railKey);
    expect(strays).toEqual([]);
  });

  it("has no duplicate rail keys", () => {
    const keys = RAIL_SCORING_DECLARATION.map((r) => r.railKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("resolves a threshold for every rail from the DIMENSION, not from itself", () => {
    for (const rule of RAIL_SCORING_DECLARATION) {
      const fromDimension = COUNTY_RAIL_DECLARATION.find(
        (r) => r.railKey === rule.railKey,
      );
      expect(fromDimension, `no dimension row for ${rule.railKey}`).toBeDefined();
      expect(thresholdPctForRail(rule.railKey)).toBe(fromDimension!.thresholdPct);
    }
  });

  it("does NOT carry a threshold field of its own", () => {
    // A threshold here would be a second home for one rule — the exact
    // duplication that let GEOMETRY_THRESHOLD_PCT and FLOOD_THRESHOLD_PCT
    // become per-file literals.
    for (const rule of RAIL_SCORING_DECLARATION) {
      expect(rule).not.toHaveProperty("thresholdPct");
    }
  });

  it("throws rather than defaulting when a rail has no threshold", () => {
    expect(() => thresholdPctForRail("not-a-rail")).toThrow(/not in COUNTY_RAIL_DECLARATION/);
  });
});

describe("registry completeness", () => {
  it("every rule carries a denominator with a non-empty prose basis", () => {
    // DEV_PROCESS 1.1: a coverage figure travels with its denominator or it
    // does not ship. The basis is what travels.
    for (const rule of RAIL_SCORING_DECLARATION) {
      expect(rule.denominator.kind, rule.railKey).toBeTruthy();
      expect(rule.denominator.basis.trim().length, rule.railKey).toBeGreaterThan(10);
    }
  });

  it("every rule names an instrument, so no row can be anonymous", () => {
    // 57 live ledger rows carry verified_by_instrument NULL. A row that
    // cannot name what produced it cannot be re-derived or challenged.
    for (const rule of RAIL_SCORING_DECLARATION) {
      expect(rule.instrument.trim().length, rule.railKey).toBeGreaterThan(0);
    }
  });

  it("every UNSPECIFIED rail names a reason and an owner", () => {
    // DEV_PROCESS 3.6: "unassigned" is a blocking state, not a default.
    for (const rail of unspecifiedRails()) {
      expect(rail.unspecifiedReason.trim().length, rail.railKey).toBeGreaterThan(40);
      expect(rail.specOwner.trim().length, rail.railKey).toBeGreaterThan(0);
    }
  });

  it("the six rails with zero live coverage rows are declared, not omitted", () => {
    // Verified against the deployment store 2026-08-19: these six have zero
    // rows in county_facet_coverage — 1,524 of 3,556 cells. `mud` is here
    // too: it has 254 live rows written by a script that exists nowhere.
    const declaredUnspecified = new Set(unspecifiedRails().map((r) => r.railKey));
    for (const railKey of [
      "roads",
      "footprint",
      "easement",
      "rrc-wells",
      "rrc-pipelines",
      "rail-corridor",
    ]) {
      expect(declaredUnspecified.has(railKey), railKey).toBe(true);
    }
  });

  it("scoreableRailKeys and unspecifiedRails partition the registry", () => {
    expect(scoreableRailKeys().length + unspecifiedRails().length).toBe(
      RAIL_SCORING_DECLARATION.length,
    );
  });

  it("resolves a known rail and returns undefined for an unknown one", () => {
    expect(railScoringRuleFor("flood")?.railKey).toBe("flood");
    expect(railScoringRuleFor("no-such-rail")).toBeUndefined();
  });
});

describe("absence probe reach", () => {
  // TRACED TO AN INCIDENT: the RRC wells source is a Harris-only mirror.
  // Applying it statewide writes mass false absences.
  const statewide: AbsenceProbeSpec = {
    kind: "source-table-zero-rows",
    table: "tx_special_district",
    fipsColumn: "county_fips",
    basis: "statewide-source-zero-rows-for-fips",
    reach: { kind: "statewide" },
  };
  const harrisOnly: AbsenceProbeSpec = {
    ...statewide,
    table: "rrc_wells",
    reach: { kind: "enumerated-counties", counties: ["48201"] },
  };
  const unknownReach: AbsenceProbeSpec = {
    ...statewide,
    reach: { kind: "unknown" },
  };

  it("a statewide source covers any county", () => {
    expect(absenceProbeCoversCounty(statewide, "48021")).toBe(true);
  });

  it("an enumerated source covers ONLY its counties", () => {
    expect(absenceProbeCoversCounty(harrisOnly, "48201")).toBe(true);
    expect(absenceProbeCoversCounty(harrisOnly, "48113")).toBe(false);
  });

  it("an UNKNOWN reach covers nothing — it can never establish an absence", () => {
    expect(absenceProbeCoversCounty(unknownReach, "48021")).toBe(false);
  });
});
