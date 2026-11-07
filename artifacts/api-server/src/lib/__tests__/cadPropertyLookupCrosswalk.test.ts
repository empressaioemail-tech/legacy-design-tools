import { describe, expect, it } from "vitest";
import {
  chooseCrosswalkAccount,
  shouldCrosswalkAccountLookup,
  type CrosswalkAccountCandidate,
} from "../cadPropertyLookup";

/**
 * P-180 (2026-09-13). The gate-blocked account lookup must resolve the CAD
 * account through the PUBLISHED IDENTIFIERS, never the bare prop_id. The
 * fixture is the live Hays 48209 Sturgeon collision: node 97658 is a TxGIO
 * parcel whose bare number is ALSO a real, unrelated Mesa Verde CAD account,
 * while the parcel's own geo_id names Conway Addition account 84639 (whose
 * QuickRefID R97658 corroborates the node).
 */
describe("P-180 chooseCrosswalkAccount (gate-blocked account lookup)", () => {
  const conwayAccount: CrosswalkAccountCandidate = {
    propId: "84639",
    quickRefId: "R97658",
  };

  it("fails on the bare join: resolves the account the node's geo_id names, never the colliding bare number", () => {
    const resolved = chooseCrosswalkAccount("97658", "11-2520-0000-03100-2", [
      conwayAccount,
    ]);
    expect(resolved).toBe("84639");
    // The colliding Mesa Verde account is 97658 (the bare prop_id itself).
    // If a future change re-introduced the bare join, this would read "97658".
    expect(resolved).not.toBe("97658");
  });

  it("returns null (honest absence) when the node publishes no geo_id", () => {
    expect(chooseCrosswalkAccount("97658", null, [conwayAccount])).toBeNull();
    expect(chooseCrosswalkAccount("97658", "   ", [conwayAccount])).toBeNull();
  });

  it("returns null when no account publishes the node's geo_id", () => {
    expect(chooseCrosswalkAccount("97658", "11-2520-0000-03100-2", [])).toBeNull();
  });

  it("refuses an ambiguous property_number claimed by more than one account", () => {
    const resolved = chooseCrosswalkAccount("97658", "11-2520-0000-03100-2", [
      conwayAccount,
      { propId: "99999", quickRefId: "R97658" },
    ]);
    expect(resolved).toBeNull();
  });

  it("refuses the bind when the corroborating QuickRefID stem disagrees with the node", () => {
    const resolved = chooseCrosswalkAccount("97658", "11-2520-0000-03100-2", [
      { propId: "84639", quickRefId: "R00001" },
    ]);
    expect(resolved).toBeNull();
  });

  it("fails open on an absent corroborator (a non-R / null QuickRefID is not evidence against the bind)", () => {
    expect(
      chooseCrosswalkAccount("97658", "11-2520-0000-03100-2", [
        { propId: "84639", quickRefId: null },
      ]),
    ).toBe("84639");
  });
});

describe("P-180 shouldCrosswalkAccountLookup (the blocked-county parameter)", () => {
  it("is true for the gate-blocked counties", () => {
    expect(shouldCrosswalkAccountLookup("48209")).toBe(true);
    expect(shouldCrosswalkAccountLookup("48491")).toBe(true);
  });

  it("is false for the control counties (byte-identical old behaviour)", () => {
    for (const fips of ["48021", "48055", "48309", "48453"]) {
      expect(shouldCrosswalkAccountLookup(fips)).toBe(false);
    }
  });

  it("honours a caller-supplied ledger set rather than a hardcoded county", () => {
    expect(shouldCrosswalkAccountLookup("48999", new Set(["48999"]))).toBe(true);
  });
});
