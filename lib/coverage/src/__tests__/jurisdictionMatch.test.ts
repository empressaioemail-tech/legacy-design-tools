import { describe, it, expect } from "vitest";
import {
  collectFirmStateCodes,
  filterJurisdictionsByStates,
  jurisdictionMatchesState,
} from "../jurisdictionMatch";

describe("collectFirmStateCodes", () => {
  it("unions geocoded states from engagements", () => {
    const states = collectFirmStateCodes([
      { site: { geocode: { jurisdictionState: "UT" } } },
      { site: { geocode: { jurisdictionState: "TX" } } },
      { site: { geocode: { jurisdictionState: "UT" } } },
    ]);
    expect([...states].sort()).toEqual(["TX", "UT"]);
  });
});

describe("jurisdictionMatchesState", () => {
  it("matches key suffix heuristics", () => {
    expect(
      jurisdictionMatchesState(
        { key: "grand_county_ut", displayName: "Grand County" },
        "UT",
      ),
    ).toBe(true);
    expect(
      jurisdictionMatchesState(
        { key: "bastrop_tx", displayName: "Bastrop" },
        "TX",
      ),
    ).toBe(true);
  });
});

describe("filterJurisdictionsByStates", () => {
  it("returns empty when no states", () => {
    expect(
      filterJurisdictionsByStates(
        [{ key: "a", displayName: "A" }],
        new Set(),
      ),
    ).toEqual([]);
  });
});
