/**
 * P-106 item 2, the derivation half. These tests exist to pin the ONE thing
 * that makes the three-set result honest: `absent-verified` is earned, and
 * every other kind of not-knowing stays out of it.
 *
 * The fixtures are shaped from live 2026-09-02 bake payloads on the deployment
 * store, including the `48021:0` row whose `situsAddress` is `", ,"` and whose
 * whole `cadRoll` is null.
 */

import { describe, it, expect } from "vitest";
import {
  CONSTRAINT_RAILS,
  CONSTRAINT_RAIL_STATES,
  cellIsEvaluable,
  projectConstraintCells,
  situsIsReal,
} from "./parcelConstraintProjection";
import { SMART_SITE_RAIL_STATES, composeSmartSiteStub } from "./smartSiteStub";
import { PARCEL_CONSTRAINT_RAIL_STATE_SQL } from "@workspace/db/schema";

/** A live-shaped Bastrop tier-1 payload with a stamped city district. */
const IN_CITY_ZONED = {
  tier: 1,
  zoning: { district: "PDD", jurisdictionKey: "bastrop_city_tx" },
  bakedAt: "2026-08-04T12:24:40.869Z",
  baseFacts: {
    acreage: { sqft: 14035, value: 0.3222, method: "shoelace-wgs84" },
    cadRoll: {
      landValue: null,
      marketValue: null,
      assessedValue: null,
      livingAreaSqft: null,
      improvementValue: null,
    },
    landUse: null,
    yearBuilt: null,
    situsAddress: "304 WOLVERINE PASS , BASTROP, TX 78602",
  },
  countyFips: "48021",
  provenance: { landUseGateBlocked: false },
  parcelNodeId: "48021:103255",
};

/** The live degenerate row: `", ,"` situs, apn 0, everything else null. */
const SENTINEL_ROW = {
  tier: 1,
  zoning: { district: "SF-1" },
  baseFacts: {
    acreage: { sqft: 252007, value: 5.7853, method: "shoelace-wgs84" },
    cadRoll: {
      landValue: null,
      marketValue: null,
      assessedValue: null,
      livingAreaSqft: null,
      improvementValue: null,
    },
    landUse: null,
    yearBuilt: null,
    situsAddress: ", ,",
  },
  countyFips: "48021",
  parcelNodeId: "48021:0",
};

function project(
  tier1: unknown,
  jurisdiction?: "in-city" | "unincorporated" | "unresolved" | null,
  extra: Partial<Parameters<typeof projectConstraintCells>[0]> = {},
) {
  return projectConstraintCells({
    parcelNodeId: "48021:103255",
    countyFips: "48021",
    propId: "103255",
    tier1,
    jurisdictionDisposition: jurisdiction ?? null,
    ...extra,
  });
}

describe("parcel constraint projection", () => {
  it("gives every rail a cell, always, so an omitted key and an unmeasured cell cannot look the same", () => {
    const row = project(IN_CITY_ZONED, "in-city");
    expect(Object.keys(row.cells).sort()).toEqual([...CONSTRAINT_RAILS].sort());
    for (const rail of CONSTRAINT_RAILS) {
      expect(CONSTRAINT_RAIL_STATES).toContain(row.cells[rail].state);
      expect(row.cells[rail].basis.length).toBeGreaterThan(0);
    }
  });

  it("uses the serve path's own five-word rail vocabulary, not a sixth", () => {
    expect(CONSTRAINT_RAIL_STATES).toBe(SMART_SITE_RAIL_STATES);
  });

  /**
   * The divergence test for the one rule with two implementations: the rail
   * vocabulary lives in `smartSiteStub.ts` (artifacts) and in the store's CHECK
   * constraint (lib/db, which cannot import from artifacts). Two lists, one
   * rule. This is what makes adding a word to one and not the other fail.
   */
  it("the DDL check constraint admits exactly the five serve-path words", () => {
    const fromSql = PARCEL_CONSTRAINT_RAIL_STATE_SQL.replace(/[()']/g, "")
      .split(",")
      .map((s) => s.trim())
      .sort();
    expect(fromSql).toEqual([...SMART_SITE_RAIL_STATES].sort());
  });

  it("reads acreage from the bake and names the method as its basis", () => {
    const cell = project(IN_CITY_ZONED, "in-city").cells.acreage;
    expect(cell.state).toBe("present");
    expect(cell.number).toBeCloseTo(0.3222, 4);
    expect(cell.basis).toBe("shoelace-wgs84");
  });

  it("calls a missing acreage unknown, never a verified absence", () => {
    const cell = project(
      { ...IN_CITY_ZONED, baseFacts: { ...IN_CITY_ZONED.baseFacts, acreage: null } },
      "unincorporated",
    ).cells.acreage;
    expect(cell.state).toBe("unknown");
    expect(cellIsEvaluable(cell)).toBe(false);
  });

  it("earns zoning absent-verified only from BOTH inputs: no district AND unincorporated", () => {
    const noDistrict = { ...IN_CITY_ZONED, zoning: null };
    expect(project(noDistrict, "unincorporated").cells.zoningDistrict).toMatchObject({
      state: "absent-verified",
      basis: "unincorporated-no-municipal-zoning",
    });
    // In-city with no district is a STAMP GAP, not an absence.
    expect(project(noDistrict, "in-city").cells.zoningDistrict).toMatchObject({
      state: "unknown",
      basis: "in-city-no-zoning-stamp",
    });
    // No jurisdiction row at all is the weakest state of the three.
    expect(project(noDistrict, null).cells.zoningDistrict).toMatchObject({
      state: "unknown",
      basis: "no-jurisdiction-disposition",
    });
  });

  it("never calls a zoned parcel absent, whatever the jurisdiction says", () => {
    for (const j of ["in-city", "unincorporated", "unresolved", null] as const) {
      const cell = project(IN_CITY_ZONED, j).cells.zoningDistrict;
      expect(cell.state).toBe("present");
      expect(cell.text).toBe("PDD");
    }
  });

  it("separates a bake land-use refusal from a bake land-use absence", () => {
    const blocked = {
      ...IN_CITY_ZONED,
      provenance: { landUseGateBlocked: true },
    };
    expect(project(blocked, "in-city").cells.landUse.state).toBe("refused");
    expect(project(IN_CITY_ZONED, "in-city").cells.landUse.state).toBe("unknown");
  });

  it("keeps a measured zero apart from an unmeasured dollar rail", () => {
    const withZeroes = {
      ...IN_CITY_ZONED,
      baseFacts: {
        ...IN_CITY_ZONED.baseFacts,
        cadRoll: { marketValue: 0, landValue: 0, improvementValue: 0 },
        yearBuilt: 0,
      },
    };
    const zeroed = project(withZeroes, "in-city").cells;
    expect(zeroed.marketValue).toMatchObject({ state: "present", number: 0 });
    expect(zeroed.yearBuilt).toMatchObject({ state: "present", number: 0 });
    // The live shape: null everywhere, and null is NOT zero.
    const live = project(IN_CITY_ZONED, "in-city").cells;
    expect(live.marketValue.state).toBe("unknown");
    expect(live.marketValue.number).toBeNull();
  });

  it("treats a flood atom-miss as unmeasured and a typed absence as a mapped negative", () => {
    const miss = project(IN_CITY_ZONED, "in-city", {
      flood: { state: "refused", code: "atom-miss" },
    }).cells.flood;
    expect(miss.state).toBe("unknown");
    expect(cellIsEvaluable(miss)).toBe(false);

    const typed = project(IN_CITY_ZONED, "in-city", {
      flood: {
        state: "absent",
        absence: { kind: "no-intersecting-zone", reason: "outside every mapped NFHL polygon" },
      },
    }).cells.flood;
    expect(typed.state).toBe("absent-verified");
    expect(cellIsEvaluable(typed)).toBe(true);

    const present = project(IN_CITY_ZONED, "in-city", {
      flood: { state: "present", inSpecialFloodHazardArea: true, floodZone: "AE" },
    }).cells.flood;
    expect(present).toMatchObject({ state: "present", text: "AE", flag: true });
  });

  it("keeps a flood bind-conflict as a refusal, not an absence", () => {
    const cell = project(IN_CITY_ZONED, "in-city", {
      flood: { state: "refused", code: "bind-conflict" },
    }).cells.flood;
    expect(cell.state).toBe("refused");
    expect(cellIsEvaluable(cell)).toBe(false);
  });

  it("carries etj as declared-ahead and unread on every row", () => {
    for (const j of ["in-city", "unincorporated", null] as const) {
      expect(project(IN_CITY_ZONED, j).cells.etj).toMatchObject({
        state: "unread",
        basis: "no-etj-source-in-store",
      });
    }
  });

  it("makes an absent jurisdiction row unknown, never unincorporated", () => {
    expect(project(IN_CITY_ZONED, null).cells.cityLimits.state).toBe("unknown");
    expect(project(IN_CITY_ZONED, "unresolved").cells.cityLimits.state).toBe("refused");
    expect(project(IN_CITY_ZONED, "unincorporated").cells.cityLimits).toMatchObject({
      state: "present",
      text: "unincorporated",
    });
  });

  it("marks every rail unread when there is no bake row at all", () => {
    const row = project(null, "in-city");
    for (const rail of CONSTRAINT_RAILS) {
      expect(row.cells[rail].state).toBe("unread");
      expect(row.cells[rail].basis).toBe("no-tier1-bake-row");
    }
  });

  /**
   * THE ONE PLACE THE PROJECTION AND get_smart_site DISAGREE, PINNED ON
   * PURPOSE so it cannot drift silently and cannot be discovered by surprise.
   *
   * `composeSmartSiteStub` derives zoning from ONE input (the bake payload) and
   * `railStateFromSectionDisposition` maps `absent` to `unknown`, because at
   * section level an absence has no positive typed result behind it (the WDLL
   * item 5 ruling). The projection derives it from TWO independently derived
   * inputs and therefore EARNS `absent-verified` on an unincorporated parcel
   * with no district. Both are honest; the projection's is strictly the more
   * informed of the two, and it is the state that makes "unzoned land"
   * answerable at all.
   *
   * Measured 2026-09-02 on the deployment store, this is not a rounding
   * difference: it is 50,157 of 77,799 Bastrop parcels (64.5 percent), and
   * 14,326 of 48,649 in Caldwell. Routed to the operator
   * in the P-106 close, with two options: teach the serve path the same
   * two-input derivation, or drop the projection to `unknown` and lose the
   * `absent` operator on zoning. This test exists so whichever is chosen has
   * to be chosen, rather than happening.
   */
  it("PINNED DIVERGENCE: the projection earns absent-verified on zoning where get_smart_site says unknown", () => {
    const noDistrict = { ...IN_CITY_ZONED, zoning: null };
    const projected = project(noDistrict, "unincorporated").cells.zoningDistrict;
    const served = composeSmartSiteStub({
      parcelNodeId: "48021:10001",
      facets: noDistrict,
    });
    expect(projected.state).toBe("absent-verified");
    expect(served.zoning).toBe("unknown");
    expect(projected.state).not.toBe(served.zoning);
    // And where the two DO share an input, they agree, so this divergence is
    // the two-input rule and nothing else.
    expect(project(IN_CITY_ZONED, "in-city").cells.zoningDistrict.state).toBe(
      composeSmartSiteStub({ parcelNodeId: "48021:103255", facets: IN_CITY_ZONED })
        .zoning,
    );
    expect(project(IN_CITY_ZONED, "in-city").cells.landUse.state).toBe(
      composeSmartSiteStub({ parcelNodeId: "48021:103255", facets: IN_CITY_ZONED })
        .landUse,
    );
  });

  it("rejects the live punctuation-only situs the bake carries", () => {
    expect(situsIsReal(SENTINEL_ROW.baseFacts.situsAddress)).toBe(false);
    expect(situsIsReal(IN_CITY_ZONED.baseFacts.situsAddress)).toBe(true);
    expect(situsIsReal(null)).toBe(false);
    expect(situsIsReal("   ")).toBe(false);
    // Not punctuation-only, so the serve path does label it: a partial situs
    // is a different defect from a sentinel, and this predicate does not
    // silently take on the second job.
    expect(situsIsReal(", TX 78660")).toBe(true);
  });
});
