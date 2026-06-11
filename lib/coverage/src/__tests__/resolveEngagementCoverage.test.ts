import { describe, it, expect } from "vitest";
import { resolveEngagementCoverage } from "../resolveEngagementCoverage";

describe("resolveEngagementCoverage", () => {
  it("returns unknown without geocode", () => {
    expect(
      resolveEngagementCoverage({ address: null, jurisdictionState: null }),
    ).toEqual({
      substrateJurisdictionKey: null,
      cortexJurisdictionKey: null,
      coverageStatus: "unknown",
    });
  });

  it("returns ready when cortex key and atoms exist", () => {
    expect(
      resolveEngagementCoverage(
        {
          jurisdictionCity: "Moab",
          jurisdictionState: "UT",
        },
        {
          substrateJurisdictions: [
            { key: "grand-county-ut", displayName: "Grand County, UT" },
          ],
          cortexAtomCount: 12,
        },
      ),
    ).toMatchObject({
      cortexJurisdictionKey: "grand_county_ut",
      coverageStatus: "ready",
    });
  });

  it("returns not_in_catalog when city/state cannot be resolved", () => {
    expect(
      resolveEngagementCoverage(
        {
          jurisdiction: "Atlantis, Lost Continent",
          address: "1 Trident Way, Atlantis",
        },
        { substrateJurisdictions: [{ key: "bastrop-tx", displayName: "Bastrop, TX" }] },
      ),
    ).toMatchObject({
      cortexJurisdictionKey: null,
      coverageStatus: "not_in_catalog",
    });
  });

  it("returns warming for synthesized unwarmed US cities (web-first on demand)", () => {
    expect(
      resolveEngagementCoverage(
        { jurisdictionCity: "Pagosa Springs", jurisdictionState: "CO" },
        { substrateJurisdictions: [{ key: "bastrop-tx", displayName: "Bastrop, TX" }] },
      ),
    ).toMatchObject({
      cortexJurisdictionKey: "pagosa_springs_co",
      coverageStatus: "warming",
    });
  });

  it("returns substrate_only when MCP has match but no cortex key", () => {
    expect(
      resolveEngagementCoverage(
        { jurisdictionCity: "Dallas", jurisdictionState: "TX" },
        {
          substrateJurisdictions: [
            { key: "dallas-tx", displayName: "Dallas, TX" },
          ],
          cortexAtomCount: 0,
        },
      ),
    ).toMatchObject({
      substrateJurisdictionKey: "dallas-tx",
      cortexJurisdictionKey: null,
      coverageStatus: "substrate_only",
    });
  });
});
