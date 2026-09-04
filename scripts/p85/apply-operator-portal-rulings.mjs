#!/usr/bin/env node
/**
 * Apply operator ruling 2026-08-26: automated_search=permitted for all P-85 portals.
 * Upserts ruling fields; inserts placeholder terms row when missing (run fetch for verbatim terms).
 *
 * Usage: DATABASE_URL=... node scripts/p85/apply-operator-portal-rulings.mjs
 */

import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  P85_CLERK_PORTAL_SEED,
  P85_OPERATOR_PERMITTED_RULING_NOTES,
} from "./p85-clerk-portals.mjs";

const PLACEHOLDER_TERMS =
  "[P-85 placeholder terms text; run scripts/p85/fetch-clerk-portal-terms.mjs for verbatim clerk terms]";

/**
 * @param {import("pg").Client} client
 */
export async function applyOperatorPermittedRulingsPg(client) {
  const now = new Date().toISOString();
  const applied = [];

  for (const portal of P85_CLERK_PORTAL_SEED) {
    const result = await client.query(
      `INSERT INTO clerk_portal_terms (
         county_fips, portal_id, portal_url, terms_url, terms_text,
         terms_fetched_at, automated_search, login_required, image_purchase,
         operator_ruled_at, operator_ruling_notes, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,'permitted',$7,$8::jsonb,$6,$9,$6)
       ON CONFLICT (county_fips, portal_id) DO UPDATE SET
         automated_search = 'permitted',
         operator_ruled_at = EXCLUDED.operator_ruled_at,
         operator_ruling_notes = EXCLUDED.operator_ruling_notes,
         updated_at = EXCLUDED.updated_at
       RETURNING portal_id, automated_search`,
      [
        portal.countyFips,
        portal.portalId,
        portal.portalUrl,
        portal.termsUrl,
        PLACEHOLDER_TERMS,
        now,
        portal.loginRequired,
        JSON.stringify(portal.imagePurchase),
        P85_OPERATOR_PERMITTED_RULING_NOTES,
      ],
    );
    applied.push(result.rows[0]);
  }

  if (applied.length !== P85_CLERK_PORTAL_SEED.length) {
    throw new Error(
      `Expected ${P85_CLERK_PORTAL_SEED.length} portal rulings; got ${applied.length}`,
    );
  }

  return applied;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: true },
  });
  await client.connect();

  try {
    const applied = await applyOperatorPermittedRulingsPg(client);
    console.log(
      JSON.stringify({
        event: "p85_portal_rulings_applied",
        count: applied.length,
        automated_search: "permitted",
        portal_ids: applied.map((r) => r.portal_id),
      }),
    );
  } finally {
    await client.end();
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
