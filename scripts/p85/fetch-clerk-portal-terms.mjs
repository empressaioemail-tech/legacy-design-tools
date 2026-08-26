/**
 * P-85 WDLL item 1 — fetch verbatim clerk portal terms into neondb.
 *
 * Usage:
 *   node scripts/p85/fetch-clerk-portal-terms.mjs
 *   node scripts/p85/fetch-clerk-portal-terms.mjs --portal hays-erss
 *
 * Does not set automated_search; rows land as unknown until operator rules.
 */

import pg from "pg";

const PORTALS = [
  {
    countyFips: "48021",
    portalId: "bastrop-aumentum",
    portalUrl: "https://cc.co.bastrop.tx.us/RealEstate",
    termsUrl: "https://cc.co.bastrop.tx.us/RealEstate/SearchTerms.aspx",
    loginRequired: true,
    imagePurchase: {
      method: "portal per-page purchase",
      notes: "Aumentum; login required",
    },
  },
  {
    countyFips: "48453",
    portalId: "travis-tccsearch",
    portalUrl: "https://www.tccsearch.org",
    termsUrl: "https://www.tccsearch.org/RealEstate/Disclaimer.aspx",
    loginRequired: false,
    imagePurchase: { pricePerPage: "$1.00", method: "emailed copies" },
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
    termsUrl: "https://williamson.tx.publicsearch.us/terms",
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
      notes: "24x36 plat $5.00",
    },
  },
  {
    countyFips: "48055",
    portalId: "caldwell-clerk-web",
    portalUrl: "https://www.co.caldwell.tx.us/page/caldwell.county.clerk",
    termsUrl: "https://www.co.caldwell.tx.us/page/caldwell.county.clerk",
    loginRequired: false,
    imagePurchase: {
      method: "verify with clerk",
      notes: "vendor unconfirmed at recon",
    },
  },
  {
    countyFips: "48309",
    portalId: "mclennan-online-records",
    portalUrl: "https://www.mclennan.gov/166/County-Clerk",
    termsUrl: "https://www.mclennan.gov/166/County-Clerk",
    loginRequired: false,
    imagePurchase: {
      method: "Online Records Search",
      notes: "electronic from 1996-01-01",
    },
  },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchTermsText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Hauska-P85-portal-terms-fetch/1.0 (+public-record compliance)",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const body = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      text: `[fetch failed HTTP ${res.status}]\n\nURL: ${url}\n\n${body.slice(0, 4000)}`,
    };
  }
  const plain = stripHtml(body);
  return {
    ok: true,
    status: res.status,
    text: plain.length > 0 ? plain : `[empty body after strip]\n\nURL: ${url}\n\n${body.slice(0, 4000)}`,
  };
}

async function upsertPortalTerms(client, portal, fetched) {
  const now = new Date().toISOString();
  await client.query(
    `INSERT INTO clerk_portal_terms (
       county_fips, portal_id, portal_url, terms_url, terms_text,
       terms_fetched_at, automated_search, login_required, image_purchase, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,'unknown',$7,$8::jsonb,$6)
     ON CONFLICT (county_fips, portal_id) DO UPDATE SET
       portal_url = EXCLUDED.portal_url,
       terms_url = EXCLUDED.terms_url,
       terms_text = EXCLUDED.terms_text,
       terms_fetched_at = EXCLUDED.terms_fetched_at,
       login_required = EXCLUDED.login_required,
       image_purchase = EXCLUDED.image_purchase,
       updated_at = EXCLUDED.updated_at`,
    [
      portal.countyFips,
      portal.portalId,
      portal.portalUrl,
      portal.termsUrl,
      fetched.text,
      now,
      portal.loginRequired,
      JSON.stringify(portal.imagePurchase),
    ],
  );
}

async function main() {
  const filterArg = process.argv.find((a) => a.startsWith("--portal="));
  const filter = filterArg?.split("=")[1];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const targets = filter
    ? PORTALS.filter((p) => p.portalId === filter)
    : PORTALS;

  if (targets.length === 0) {
    console.error(`No portal matches --portal=${filter}`);
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  const results = [];
  for (const portal of targets) {
    const fetched = await fetchTermsText(portal.termsUrl);
    await upsertPortalTerms(client, portal, fetched);
    results.push({
      portalId: portal.portalId,
      countyFips: portal.countyFips,
      termsUrl: portal.termsUrl,
      httpStatus: fetched.status,
      fetchOk: fetched.ok,
      termsChars: fetched.text.length,
    });
    console.log(
      JSON.stringify({
        portalId: portal.portalId,
        httpStatus: fetched.status,
        termsChars: fetched.text.length,
      }),
    );
  }

  await client.end();
  console.log(JSON.stringify({ ok: true, count: results.length, results }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
