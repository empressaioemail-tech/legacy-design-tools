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
  /** Tyler ERSS post-disclaimer index search surface (county-specific action URL). */
  searchEntryUrl?: string;
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
    entryUrl: "https://williamson.tx.publicsearch.us/",
    recipeVersion: "p85-williamson-publicsearch-v1",
  },
  {
    portalId: "hays-erss",
    countyFips: "48209",
    portalUrl: "https://erss.co.hays.tx.us",
    entryUrl: "https://erss.co.hays.tx.us/web/user/disclaimer",
    searchEntryUrl: "https://erss.co.hays.tx.us/web/search/DOCSEARCH149S1",
    recipeVersion: "p85-hays-erss-v2",
  },
  {
    // P-113: real vendor is Tyler Technologies "CountyGovernmentRecords.com"
    // (landrecords product), NOT the informational co.caldwell.tx.us page and
    // NOT the ERSS/web-self-service product used by Hays/McLennan — verified
    // live 2026-09-03. The splash page's only action is "Enter", which routes
    // straight to /texas/web/login.jsp: this vendor requires free registration
    // + login before ANY index search, with no anonymous search surface at
    // all. Do not guess from the county name or from "Tyler Technologies" —
    // same company, materially different product than the other Tyler portals.
    portalId: "caldwell-clerk-web",
    countyFips: "48055",
    portalUrl: "https://tx.countygovernmentrecords.com/texas/web/",
    entryUrl: "https://tx.countygovernmentrecords.com/texas/web/",
    recipeVersion: "p85-caldwell-countygovernmentrecords-v1",
  },
  {
    // P-113: real vendor is Tyler self-service (same product family as Hays
    // ERSS), verified live 2026-09-03 — reachable headless (unlike Williamson
    // TylerHost's 403-to-bots), disclaimer accept at /web/user/disclaimer,
    // real search action DOCSEARCH402S1 ("Official Public Record Search and
    // Copies"). Field ids differ from Hays: McLennan's combined name field is
    // field_BothNamesID, not field_GrantorGrantee — see
    // TYLER_MCLENNAN_SEARCH_INPUT_SELECTORS in tylerSelfServiceSearch.ts.
    portalId: "mclennan-online-records",
    countyFips: "48309",
    portalUrl: "https://mclennancountytx-web.tylerhost.net/web/",
    entryUrl: "https://mclennancountytx-web.tylerhost.net/web/user/disclaimer",
    searchEntryUrl:
      "https://mclennancountytx-web.tylerhost.net/web/search/DOCSEARCH402S1",
    recipeVersion: "p85-mclennan-tylerhost-v1",
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
