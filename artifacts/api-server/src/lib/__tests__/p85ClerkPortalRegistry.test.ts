import { describe, expect, it } from "vitest";

import {
  P85_CLERK_PORTALS,
  P85_COUNTY_FIPS,
  clerkPortalsForCounty,
} from "../p85ClerkPortalRegistry";
import { P85_CLERK_PORTAL_SEED } from "../../../../../scripts/p85/p85-clerk-portals.mjs";

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

  it("matches scripts/p85/p85-clerk-portals.mjs seed shape", () => {
    expect(P85_CLERK_PORTAL_SEED).toHaveLength(7);
    const registryKeys = P85_CLERK_PORTALS.map((p) => `${p.countyFips}:${p.portalId}`).sort();
    const seedKeys = P85_CLERK_PORTAL_SEED.map((p) => `${p.countyFips}:${p.portalId}`).sort();
    expect(seedKeys).toEqual(registryKeys);
    expect(new Set(P85_CLERK_PORTAL_SEED.map((p) => p.countyFips)).size).toBe(6);
  });
});
