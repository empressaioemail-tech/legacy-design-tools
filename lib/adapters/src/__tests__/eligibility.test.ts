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

  it("returns the federal four for an out-of-pilot but geocoded context (PL-04)", () => {
    // Boulder CO style: stateKey null, but the parcel is geocoded
    // (lat/lng baked into ctxFor's defaults). Federal adapters now
    // apply to any finite-coords engagement.
    const applicable = filterApplicableAdapters(ctxFor(null, null));
    const keys = applicable.map((a) => a.adapterKey).sort();
    expect(keys).toEqual(
      [
        "fcc:broadband",
        "fema:nfhl-flood-zone",
        "epa:ejscreen",
        "usgs:ned-elevation",
      ].sort(),
    );
  });

  it("returns [] when the parcel has no geocode (NaN coordinates)", () => {
    const ctx: AdapterContext = {
      parcel: { latitude: NaN, longitude: NaN },
      jurisdiction: { stateKey: null, localKey: null },
    };
    expect(filterApplicableAdapters(ctx)).toEqual([]);
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
  it("asks for an address when the engagement has no geocode", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: null, localKey: null },
        hasGeocode: false,
      }),
    ).toBe("Add an address to enable site context layers.");
  });

  it("falls back to a neutral message when geocoded but stateKey is unresolved (defensive)", () => {
    // PL-04: federal adapters apply to any geocoded engagement, so
    // reaching this branch means a non-US lat/lng or a future federal
    // adapter that gates more strictly. The message should not imply
    // the architect can fix it by editing the city/state.
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: null, localKey: null },
        hasGeocode: true,
      }),
    ).toBe("No applicable adapters for this engagement's site context.");
  });

  it("names the resolved state when geocoded + stateKey resolved + localKey null", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: "utah", localKey: null },
        hasGeocode: true,
      }),
    ).toBe(
      "Federal layers loaded. No local adapter for Utah yet — upload a QGIS overlay if you have one.",
    );
  });

  it("names Texas when the resolver lands on the Texas state slug", () => {
    expect(
      noApplicableAdaptersMessage({
        jurisdiction: { stateKey: "texas", localKey: null },
        hasGeocode: true,
      }),
    ).toBe(
      "Federal layers loaded. No local adapter for Texas yet — upload a QGIS overlay if you have one.",
    );
  });
});
