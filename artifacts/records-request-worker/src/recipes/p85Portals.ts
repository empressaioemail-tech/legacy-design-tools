/**
 * P-85 clerk portals — keep in sync with scripts/p85/p85-clerk-portals.mjs
 * and artifacts/api-server/src/lib/p85ClerkPortalRegistry.ts
 */

export interface P85PortalConfig {
  portalId: string;
  countyFips: string;
  portalUrl: string;
  /** First surface the reachability recipe opens (terms/disclaimer/landing). */
  entryUrl: string;
  recipeVersion: string;
}

export const P85_PORTALS: readonly P85PortalConfig[] = [
  {
    portalId: "bastrop-aumentum",
    countyFips: "48021",
    portalUrl: "https://cc.co.bastrop.tx.us/RealEstate",
    entryUrl: "https://cc.co.bastrop.tx.us/RealEstate",
    recipeVersion: "p85-bastrop-aumentum-v2",
  },
  {
    portalId: "travis-tccsearch",
    countyFips: "48453",
    portalUrl: "https://www.tccsearch.org",
    entryUrl: "https://www.tccsearch.org/RealEstate/Disclaimer.aspx",
    recipeVersion: "p85-travis-tccsearch-v1",
  },
  {
    portalId: "williamson-tylerhost",
    countyFips: "48491",
    portalUrl: "https://williamsoncountytx-web.tylerhost.net/web/",
    entryUrl:
      "https://williamsoncountytx-web.tylerhost.net/web/user/disclaimer",
    recipeVersion: "p85-tyler-williamson-scaffold-v0",
  },
  {
    portalId: "williamson-publicsearch",
    countyFips: "48491",
    portalUrl: "https://williamson.tx.publicsearch.us/",
    entryUrl: "https://williamson.tx.publicsearch.us/terms",
    recipeVersion: "p85-williamson-publicsearch-v1",
  },
  {
    portalId: "hays-erss",
    countyFips: "48209",
    portalUrl: "https://erss.co.hays.tx.us",
    entryUrl: "https://erss.co.hays.tx.us/web/user/disclaimer",
    recipeVersion: "p85-hays-erss-v1",
  },
  {
    portalId: "caldwell-clerk-web",
    countyFips: "48055",
    portalUrl: "https://www.co.caldwell.tx.us/page/caldwell.county.clerk",
    entryUrl: "https://www.co.caldwell.tx.us/page/caldwell.county.clerk",
    recipeVersion: "p85-caldwell-clerk-scaffold-v0",
  },
  {
    portalId: "mclennan-online-records",
    countyFips: "48309",
    portalUrl: "https://www.mclennan.gov/166/County-Clerk",
    entryUrl: "https://www.mclennan.gov/166/County-Clerk",
    recipeVersion: "p85-mclennan-clerk-scaffold-v0",
  },
] as const;

/** Default portal per county when requestPayload.portalId is absent. */
export const P85_DEFAULT_PORTAL_BY_COUNTY: Readonly<Record<string, string>> = {
  "48021": "bastrop-aumentum",
  "48453": "travis-tccsearch",
  "48491": "williamson-publicsearch",
  "48209": "hays-erss",
  "48055": "caldwell-clerk-web",
  "48309": "mclennan-online-records",
};

export function portalConfigById(portalId: string): P85PortalConfig | undefined {
  return P85_PORTALS.find((p) => p.portalId === portalId);
}
