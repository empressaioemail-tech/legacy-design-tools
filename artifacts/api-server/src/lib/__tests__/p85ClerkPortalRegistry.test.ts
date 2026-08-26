import { describe, expect, it } from "vitest";

import {
  P85_CLERK_PORTALS,
  P85_COUNTY_FIPS,
  clerkPortalsForCounty,
} from "../p85ClerkPortalRegistry";

describe("P85_CLERK_PORTALS registry", () => {
  it("covers six counties with seven portal instances (Williamson twice)", () => {
    expect(P85_COUNTY_FIPS).toHaveLength(6);
    expect(P85_CLERK_PORTALS).toHaveLength(7);
    expect(clerkPortalsForCounty("48491")).toHaveLength(2);
    expect(clerkPortalsForCounty("48491").map((p) => p.portalId).sort()).toEqual([
      "williamson-publicsearch",
      "williamson-tylerhost",
    ]);
  });

  it("assigns a unique portal_id per row", () => {
    const ids = P85_CLERK_PORTALS.map((p) => p.portalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers all six operator-permitted county FIPS", () => {
    expect(new Set(P85_CLERK_PORTALS.map((p) => p.countyFips)).size).toBe(6);
    for (const fips of P85_COUNTY_FIPS) {
      expect(clerkPortalsForCounty(fips).length).toBeGreaterThan(0);
    }
  });
});
