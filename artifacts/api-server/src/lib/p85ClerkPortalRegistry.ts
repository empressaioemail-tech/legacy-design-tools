/**
 * P-85 — six-county clerk portal registry for terms fetch and index search.
 * Williamson carries two portal instances (TylerHost + publicsearch.us).
 */

export interface ClerkPortalSpec {
  countyFips: string;
  countyName: string;
  portalId: string;
  portalUrl: string;
  termsUrl: string;
  loginRequired: boolean;
  imagePurchase: {
    pricePerPage?: string;
    method?: string;
    notes?: string;
  };
}

export const P85_CLERK_PORTALS: readonly ClerkPortalSpec[] = [
  {
    countyFips: "48021",
    countyName: "Bastrop",
    portalId: "bastrop-aumentum",
    portalUrl: "https://cc.co.bastrop.tx.us/RealEstate",
    termsUrl: "https://cc.co.bastrop.tx.us/RealEstate/SearchTerms.aspx",
    loginRequired: true,
    imagePurchase: {
      method: "portal per-page purchase",
      notes: "Aumentum; login required; no bulk API",
    },
  },
  {
    countyFips: "48453",
    countyName: "Travis",
    portalId: "travis-tccsearch",
    portalUrl: "https://www.tccsearch.org",
    termsUrl: "https://www.tccsearch.org/RealEstate/Disclaimer.aspx",
    loginRequired: false,
    imagePurchase: {
      pricePerPage: "$1.00",
      method: "emailed copies per county clerk fee schedule",
    },
  },
  {
    countyFips: "48491",
    countyName: "Williamson",
    portalId: "williamson-tylerhost",
    portalUrl: "https://williamsoncountytx-web.tylerhost.net/web/",
    termsUrl: "https://williamsoncountytx-web.tylerhost.net/web/user/disclaimer",
    loginRequired: false,
    imagePurchase: {
      method: "Tyler self-service cart",
    },
  },
  {
    countyFips: "48491",
    countyName: "Williamson",
    portalId: "williamson-publicsearch",
    portalUrl: "https://williamson.tx.publicsearch.us/",
    termsUrl: "https://williamson.tx.publicsearch.us/",
    loginRequired: false,
    imagePurchase: {
      method: "publicsearch.us per-page",
    },
  },
  {
    countyFips: "48209",
    countyName: "Hays",
    portalId: "hays-erss",
    portalUrl: "https://erss.co.hays.tx.us",
    termsUrl: "https://erss.co.hays.tx.us/web/user/disclaimer",
    loginRequired: false,
    imagePurchase: {
      pricePerPage: "$1.00",
      method: "Tyler self-service",
      notes: "24x36 plat $5.00 per county fee schedule",
    },
  },
  {
    countyFips: "48055",
    countyName: "Caldwell",
    portalId: "caldwell-clerk-web",
    // P-113 (verified live 2026-09-03, legacy-design-tools#597): real vendor
    // is Tyler Technologies "CountyGovernmentRecords.com" (landrecords
    // product), not the informational co.caldwell.tx.us page this row
    // previously pointed at. That vendor gates ALL index search behind free
    // registration/login with no anonymous search path at all — loginRequired
    // corrected from false to true to match. See
    // artifacts/records-request-worker/src/recipes/p85Portals.ts for the
    // recipe-side source of truth this was reconciled against.
    portalUrl: "https://tx.countygovernmentrecords.com/texas/web/",
    termsUrl: "https://tx.countygovernmentrecords.com/texas/web/",
    loginRequired: true,
    imagePurchase: {
      method: "verify with clerk; vendor confirmed, purchase flow unconfirmed",
      notes: "PIA letter recommends phone/mail first",
    },
  },
  {
    countyFips: "48309",
    countyName: "McLennan",
    portalId: "mclennan-online-records",
    // P-113 (verified live 2026-09-03, legacy-design-tools#597): real vendor
    // is Tyler self-service (same product family as Hays ERSS), reachable
    // headless, not the informational mclennan.gov page this row previously
    // pointed at. See p85Portals.ts (records-request-worker) for the
    // recipe-side source of truth this was reconciled against.
    portalUrl: "https://mclennancountytx-web.tylerhost.net/web/",
    termsUrl: "https://mclennancountytx-web.tylerhost.net/web/user/disclaimer",
    loginRequired: false,
    imagePurchase: {
      method: "Tyler self-service cart",
      notes: "Electronic records from 1996-01-01 forward",
    },
  },
] as const;

export function clerkPortalsForCounty(countyFips: string): ClerkPortalSpec[] {
  return P85_CLERK_PORTALS.filter((p) => p.countyFips === countyFips);
}

export function clerkPortalById(portalId: string): ClerkPortalSpec | undefined {
  return P85_CLERK_PORTALS.find((p) => p.portalId === portalId);
}

/** P-85 WDLL item 1 — counties in scope. */
export const P85_COUNTY_FIPS = [
  "48021",
  "48453",
  "48491",
  "48209",
  "48055",
  "48309",
] as const;

export type P85CountyFips = (typeof P85_COUNTY_FIPS)[number];

export function isP85CountyFips(fips: string): fips is P85CountyFips {
  return (P85_COUNTY_FIPS as readonly string[]).includes(fips);
}
