/**
 * P-85 WDLL item 1 — fetch verbatim clerk portal terms into neondb.
 *
 * Usage:
 *   node scripts/p85/fetch-clerk-portal-terms.mjs
 *   node scripts/p85/fetch-clerk-portal-terms.mjs --portal=hays-erss
 *   node scripts/p85/fetch-clerk-portal-terms.mjs --apply-permitted-ruling
 *
 * Does not set automated_search unless --apply-permitted-ruling (operator go 2026-08-26).
 */

import pg from "pg";
import { P85_CLERK_PORTAL_SEED } from "./p85-clerk-portals.mjs";
import { applyOperatorPermittedRulingsPg } from "./apply-operator-portal-rulings.mjs";

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
  const applyRuling = process.argv.includes("--apply-permitted-ruling");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL required");
    process.exit(1);
  }

  const targets = filter
    ? P85_CLERK_PORTAL_SEED.filter((p) => p.portalId === filter)
    : P85_CLERK_PORTAL_SEED;

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

  if (applyRuling) {
    await applyOperatorPermittedRulingsPg(client);
  }

  await client.end();
  console.log(JSON.stringify({ ok: true, count: results.length, results, applyRuling }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
