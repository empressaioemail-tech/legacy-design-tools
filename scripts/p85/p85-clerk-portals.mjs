/** @typedef {{ countyFips: string; portalId: string; portalUrl: string; termsUrl: string; loginRequired: boolean; imagePurchase: Record<string, string> }} ClerkPortalSeed */

/** P-85 clerk portals — keep in sync with artifacts/api-server/src/lib/p85ClerkPortalRegistry.ts */
export const P85_CLERK_PORTAL_SEED = [
  {
    countyFips: "48021",
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
    portalId: "williamson-tylerhost",
    portalUrl: "https://williamsoncountytx-web.tylerhost.net/web/",
    termsUrl: "https://williamsoncountytx-web.tylerhost.net/web/user/disclaimer",
    loginRequired: false,
    imagePurchase: { method: "Tyler self-service cart" },
  },
  {
    countyFips: "48491",
    portalId: "williamson-publicsearch",
    portalUrl: "https://williamson.tx.publicsearch.us/",
    termsUrl: "https://williamson.tx.publicsearch.us/",
    loginRequired: false,
    imagePurchase: { method: "publicsearch.us per-page" },
  },
  {
    countyFips: "48209",
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
    portalId: "caldwell-clerk-web",
    portalUrl: "https://www.co.caldwell.tx.us/page/County.Clerk",
    termsUrl: "https://www.co.caldwell.tx.us/page/County.Clerk",
    loginRequired: false,
    imagePurchase: {
      method: "verify with clerk; vendor unconfirmed at recon",
      notes: "PIA letter recommends phone/mail first",
    },
  },
  {
    countyFips: "48309",
    portalId: "mclennan-online-records",
    portalUrl: "https://www.mclennan.gov/166/County-Clerk",
    termsUrl: "https://www.mclennan.gov/166/County-Clerk",
    loginRequired: false,
    imagePurchase: {
      method: "Online Records Search on county site",
      notes: "Electronic records from 1996-01-01 forward",
    },
  },
];

export const P85_OPERATOR_PERMITTED_RULING_NOTES =
  "Operator go 2026-08-26: all six counties permitted for automated index search (P-85 item 1).";
