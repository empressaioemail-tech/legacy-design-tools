/**
 * P-273 control 2 of the 2026-09-13 ranked card: `facetCoverage.baseFacts`
 * used the lookup key as proof the lookup succeeded.
 *
 * THE DEFECT. The flag read
 *
 *     baseFacts.apn != null || baseFacts.situsAddress != null
 *
 * and the conformant bake computes `apn` as `parcelNodeId.split(":")[1]`. You
 * cannot look a parcel up without its id, so `apn` was non-null for every
 * parcel that exists and the flag was true whether or not a single fact was
 * read from any record. Two states the operator needs to tell apart -- "the
 * CAD facts joined" and "there is no row for this parcel at the declared
 * vintage" -- wore the same `true`. Thrall `48491:R007189` is the second:
 * `lookup-failed` on living area with no `cad_property` row, reporting
 * `baseFacts: true`.
 *
 * This flag is not cosmetic: `facetScore` in `nodeFacetBakeTier1Cli.ts` adds
 * 1000 for it, so a flag that is always true is a constant offset on every
 * payload's monotonic-promotion score (see CP1 for the promotion consequence).
 *
 * WHAT IS PROVEN HERE, in both directions:
 *   1. the pre-change expression is TRUE on an input carrying nothing but
 *      `apn` and the FIPS-derived `situsState` -- the control could not fail;
 *   2. the post-change predicate is FALSE on that same input and TRUE as soon
 *      as any read leaves a value, so it is a control and not a wall.
 */
import { describe, expect, it } from "vitest";

import {
  assembleTier1Payload,
  type Tier1AssemblyInput,
} from "./lib/nodeFacetTier1Assemble";

/** A parcel with NO declared-vintage CAD row: nothing was read. */
function nothingRead(overrides?: Partial<Tier1AssemblyInput>): Tier1AssemblyInput {
  return {
    nodeId: "48491:R007189",
    countyFips: "48491",
    countyName: "Thrall",
    apn: "R007189",
    situsAddress: null,
    situsCity: null,
    situsState: "TX",
    situsZip: null,
    landUse: null,
    cadRoll: {
      marketValue: null,
      assessedValue: null,
      landValue: null,
      improvementValue: null,
      livingAreaSqft: null,
    },
    yearBuilt: null,
    legalDescription: null,
    exemptionCodes: null,
    landUseAddressRecovered: false,
    landUseGateBlocked: false,
    ring: null,
    acreageWithoutRing: null,
    zoningDistrictRaw: null,
    zoningJurisdictionRaw: null,
    parcelSource: "conformant-v1-cad-parcel-roll",
    parcelVintage: null,
    nowIso: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("P-273 control 2: facetCoverage.baseFacts can be false", () => {
  it("THE DEFECT: the pre-change expression is true on a parcel with zero read facts", () => {
    const payload = assembleTier1Payload(nothingRead());
    // `apn` exists by construction and `situsState` comes from the FIPS
    // registry, so both non-read keys are present...
    expect(payload.baseFacts.apn).toBe("R007189");
    expect(payload.baseFacts.situsState).toBe("TX");
    // ...everything a read could have produced is absent...
    expect(payload.baseFacts.situsAddress).toBeNull();
    expect(payload.baseFacts.landUse).toBeNull();
    expect(payload.baseFacts.cadRoll.marketValue).toBeNull();
    // ...and the pre-change predicate is nevertheless TRUE. This is the
    // recorded defect, evaluated verbatim: `apn != null || situsAddress != null`.
    const preChangeExpression =
      payload.baseFacts.apn != null || payload.baseFacts.situsAddress != null;
    expect(preChangeExpression).toBe(true);
  });

  it("THE FIX: the same parcel no longer reports the facet as resolved", () => {
    const payload = assembleTier1Payload(nothingRead());
    expect(payload.facetCoverage.baseFacts).toBe(false);
  });

  it("the flag is not a wall: one read value turns it true, and each source does it alone", () => {
    const cases: Array<[string, Partial<Tier1AssemblyInput>]> = [
      ["a parked CAD dollar", {
        cadRoll: {
          marketValue: { v: 100_000, source: "cad_property", vintage: "2026", valueBasis: "county-assessed" },
          assessedValue: null,
          landValue: null,
          improvementValue: null,
          livingAreaSqft: null,
        },
      }],
      ["only the living area", {
        cadRoll: {
          marketValue: null,
          assessedValue: null,
          landValue: null,
          improvementValue: null,
          livingAreaSqft: { v: 1_400, source: "cad_property", vintage: "2026" },
        },
      }],
      ["a situs city from the claim", { situsCity: "Thrall" }],
      ["a situs zip from the claim", { situsZip: "76578" }],
      ["a land use", {
        landUse: { code: "A1", description: null, source: "cad-roll", vintage: "2026" },
      }],
      ["a year built", {
        yearBuilt: { v: 1961, source: "cad_property", vintage: "2026" },
      }],
      ["a legal description", {
        legalDescription: { v: "0.5 AC OUT OF BLK 3", source: "cad_property", vintage: "2026" },
      }],
      ["exemption codes", {
        exemptionCodes: { v: ["HS"], source: "cad_property", vintage: "2026" },
      }],
    ];
    for (const [label, override] of cases) {
      expect(
        assembleTier1Payload(nothingRead(override)).facetCoverage.baseFacts,
        `${label} must make baseFacts resolved`,
      ).toBe(true);
    }
  });

  it("an EMPTY cadRoll object is not 'a value': the object always exists, its fields do not", () => {
    // The same defect shape one level down. `cadRoll` is
    // `{marketValue, assessedValue, landValue, improvementValue, livingAreaSqft}`,
    // all nullable, so it is never null and a `cadRoll != null` test would have
    // been unfalsifiable in exactly the way the old predicate was.
    const payload = assembleTier1Payload(nothingRead());
    expect(payload.baseFacts.cadRoll).not.toBeNull();
    expect(Object.values(payload.baseFacts.cadRoll).every((v) => v == null)).toBe(true);
    expect(payload.facetCoverage.baseFacts).toBe(false);
  });
});
