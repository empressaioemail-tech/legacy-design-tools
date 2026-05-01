import { describe, expect, it } from "vitest";
import {
  filterApplicableAdapters,
  noApplicableAdaptersMessage,
} from "../eligibility";
import { ALL_ADAPTERS } from "../registry";
import type {
  Adapter,
  AdapterContext,
  AdapterResult,
} from "../types";

function ctxFor(
  stateKey: AdapterContext["jurisdiction"]["stateKey"],
  localKey: AdapterContext["jurisdiction"]["localKey"],
): AdapterContext {
  return {
    parcel: { latitude: 0, longitude: 0 },
    jurisdiction: { stateKey, localKey },
  };
}

describe("filterApplicableAdapters", () => {
  it("returns Bastrop TX's federal + Texas state + Bastrop local adapters", () => {
    const applicable = filterApplicableAdapters(ctxFor("texas", "bastrop-tx"));
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fcc:broadband",
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "tceq:edwards-aquifer",
        "bastrop-tx:parcels",
        "bastrop-tx:zoning",
        "bastrop-tx:floodplain",
      ].sort(),
    );
  });

  it("returns Moab UT's federal + Utah state + Grand County local adapters", () => {
    const applicable = filterApplicableAdapters(
      ctxFor("utah", "grand-county-ut"),
    );
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fcc:broadband",
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "ugrc:dem",
        "ugrc:parcels",
        "ugrc:address-points",
        "grand-county-ut:parcels",
        "grand-county-ut:zoning",
        "grand-county-ut:roads",
      ].sort(),
    );
  });

  it("returns Salmon ID's federal + Idaho state + Lemhi County local adapters", () => {
    const applicable = filterApplicableAdapters(
      ctxFor("idaho", "lemhi-county-id"),
    );
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fcc:broadband",
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
        "inside-idaho:dem",
        "inside-idaho:parcels",
        "lemhi-county-id:parcels",
        "lemhi-county-id:zoning",
        "lemhi-county-id:roads",
      ].sort(),
    );
  });

  it("returns [] for an out-of-pilot context (CO/CA — no resolved stateKey)", () => {
    expect(filterApplicableAdapters(ctxFor(null, null))).toEqual([]);
  });

  it("swallows an `appliesTo` throw and treats it as false", () => {
    const throwing: Adapter = {
      adapterKey: "test:throwing",
      tier: "state",
      sourceKind: "state-adapter",
      layerKind: "test-throwing",
      provider: "Test",
      jurisdictionGate: { state: "utah" },
      appliesTo: () => {
        throw new Error("boom — feature flag service unreachable");
      },
      run(): Promise<AdapterResult> {
        throw new Error("should never be called");
      },
    };
    const matching: Adapter = {
      ...throwing,
      adapterKey: "test:matching",
      appliesTo: () => true,
    };

    expect(
      filterApplicableAdapters(ctxFor("utah", "grand-county-ut"), [
        throwing,
        matching,
      ]),
    ).toEqual([matching]);
  });

  it("defaults to ALL_ADAPTERS when no second arg is supplied", () => {
    // Sanity check that the default-arg path matches the explicit-arg path
    // — the FE pre-flight gate calls the helper without a second arg.
    const explicit = filterApplicableAdapters(
      ctxFor("texas", "bastrop-tx"),
      ALL_ADAPTERS,
    );
    const defaulted = filterApplicableAdapters(ctxFor("texas", "bastrop-tx"));
    expect(defaulted.map((a) => a.adapterKey)).toEqual(
      explicit.map((a) => a.adapterKey),
    );
  });
});

describe("noApplicableAdaptersMessage", () => {
  it("produces the 'could not resolve' copy when stateKey is null", () => {
    expect(
      noApplicableAdaptersMessage({ stateKey: null, localKey: null }),
    ).toBe(
      "Could not resolve a pilot jurisdiction from this engagement's site context (city/state/address). Add a city + state and try again.",
    );
  });

  it("substitutes stateKey alone when only the state resolved", () => {
    expect(
      noApplicableAdaptersMessage({ stateKey: "utah", localKey: null }),
    ).toBe('No adapters configured for jurisdiction "utah".');
  });

  it("substitutes both stateKey and localKey when the resolver landed on a local pilot", () => {
    expect(
      noApplicableAdaptersMessage({
        stateKey: "texas",
        localKey: "bastrop-tx",
      }),
    ).toBe(
      'No adapters configured for jurisdiction "texas" / bastrop-tx.',
    );
  });
});
