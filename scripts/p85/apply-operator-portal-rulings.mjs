#!/usr/bin/env node
/**
 * Apply operator ruling 2026-08-26: automated_search=permitted for all P-85 portals.
 * Requires terms rows to exist (run fetch-clerk-portal-terms.mjs first).
 *
 * Usage: DATABASE_URL=... node scripts/p85/apply-operator-portal-rulings.mjs
 */

import postgres from "postgres";

const PORTAL_IDS = [
  "bastrop-aumentum",
  "travis-tccsearch",
  "williamson-tylerhost",
  "williamson-publicsearch",
  "hays-erss",
  "caldwell-clerk-web",
  "mclennan-online-records",
];

const RULING_NOTES =
  "Operator go 2026-08-26: all six counties permitted for automated index search (P-85 item 1).";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const updated = await sql`
    UPDATE clerk_portal_terms
    SET
      automated_search = 'permitted',
      operator_ruled_at = now(),
      operator_ruling_notes = ${RULING_NOTES},
      updated_at = now()
    WHERE portal_id IN ${sql(PORTAL_IDS)}
    RETURNING portal_id
  `;

  const got = new Set(updated.map((r) => r.portal_id));
  const missing = PORTAL_IDS.filter((id) => !got.has(id));
  if (missing.length > 0) {
    console.error(
      `Refusing complete: ${missing.length} portal(s) have no terms row: ${missing.join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      event: "p85_portal_rulings_applied",
      count: updated.length,
      automated_search: "permitted",
      portal_ids: PORTAL_IDS,
    }),
  );
} finally {
  await sql.end();
}
