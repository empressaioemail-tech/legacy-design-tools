#!/usr/bin/env node
/**
 * Run pending `lib/db/drizzle/*.sql` migrations against the database
 * pointed at by `DATABASE_URL` — invoked by the `run-migrations`
 * workflow_dispatch action in `.github/workflows/cloud-run-deploy.yml`
 * to close the schema-drift loop the cortex-api deploy left open.
 *
 * Idempotency model. A `_schema_migrations` tracker table records
 * applied filenames; each pending file is applied in its own transaction
 * and its name is inserted on success. Re-runs are a no-op when nothing
 * is pending. A failure inside a file rolls that file's transaction and
 * exits non-zero with the file name.
 *
 * Why a hand-written runner rather than `drizzle-kit push`. `push` diffs
 * the live DB against the TS schema and applies the diff in one shot —
 * including destructive operations (drop column, drop table) without a
 * named, reviewable artifact. The numbered `lib/db/drizzle/*.sql` files
 * are this repo's prod-apply sequence (0009–0014 were applied that way
 * during the QA-04 cutover; 0015 was applied the same way during the
 * Phase 1 P0-1 operator-supervised pass). The script just continues
 * that pattern in CI, with the tracker table as the journal.
 *
 * Inputs (env):
 *   DATABASE_URL  required. The Postgres connection string.
 *   BOOTSTRAP     "true" / "1" — first-run only. Marks every existing
 *                 file in `lib/db/drizzle/` as applied WITHOUT
 *                 re-running them. Required when the tracker table is
 *                 empty; aborts with explicit instructions otherwise so
 *                 the operator confirms the DB is at the head before
 *                 the seed lies.
 *   PLAN_ONLY     "true" / "1" — echo the pending list and exit 0
 *                 without applying. Useful for previewing in a separate
 *                 workflow_dispatch run.
 *
 * `lib/db/scripts/track-b-ifc-ingest.sql` is intentionally NOT in the
 * tracked migration set — it was hand-applied during the QA-04 cutover
 * and is treated as part of the historical bootstrap baseline. Future
 * schema changes go into `lib/db/drizzle/NNNN_*.sql`.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "..", "drizzle");

const truthy = (v) => v === "true" || v === "1";
const bootstrap = truthy(process.env.BOOTSTRAP);
const planOnly = truthy(process.env.PLAN_ONLY);

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("migrate-prod: DATABASE_URL is not set");
  process.exit(1);
}

const allFiles = readdirSync(drizzleDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
if (allFiles.length === 0) {
  console.error(`migrate-prod: no .sql files found in ${drizzleDir}`);
  process.exit(1);
}

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
});
await client.connect();

const safeUrl = dbUrl
  .replace(/:[^:@]+@/, ":***@")
  .replace(/\?.*$/, "");
console.log(`migrate-prod: connected to ${safeUrl}`);
console.log(
  `migrate-prod: ${allFiles.length} migration file(s) in lib/db/drizzle/`,
);

await client.query(`
  CREATE TABLE IF NOT EXISTS _schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamp with time zone NOT NULL DEFAULT now()
  )
`);

const { rows: trackerRows } = await client.query(
  "SELECT name FROM _schema_migrations ORDER BY name",
);
const applied = new Set(trackerRows.map((r) => r.name));
console.log(
  `migrate-prod: ${applied.size} migration(s) already tracked as applied`,
);

if (applied.size === 0) {
  if (!bootstrap) {
    await client.end();
    console.error(
      [
        "",
        "migrate-prod: the _schema_migrations tracker is empty.",
        "This is the first run-migrations execution against this DB. Two cases:",
        "",
        "  (a) the DB is at the migration head — the historical migrations",
        "      were applied manually per 90_runbooks/neon_schema_migration_via_cloud_shell.md",
        "      (true for cortex-prod as of 2026-05-22 after the operator-supervised",
        "      Phase 1 P0-1 apply of 0015).",
        "  (b) the DB is empty or under-migrated.",
        "",
        "Re-run with BOOTSTRAP=true to confirm (a) — the tracker will be seeded",
        "with every existing file marked applied. No SQL is re-executed.",
        "Do NOT set BOOTSTRAP=true if (b) — apply the historical migrations by",
        "hand first.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
  console.log(
    "migrate-prod: BOOTSTRAP=true — seeding the tracker with every existing file marked applied (no SQL is re-executed).",
  );
  for (const f of allFiles) {
    await client.query(
      "INSERT INTO _schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING",
      [f],
    );
    console.log(`  bootstrapped  ${f}`);
  }
  await client.end();
  console.log(
    "\nmigrate-prod: bootstrap complete. Subsequent runs will apply only new files.",
  );
  process.exit(0);
}

const pending = allFiles.filter((f) => !applied.has(f));

console.log("\nmigrate-prod: pending migrations:");
if (pending.length === 0) {
  console.log("  (none — DB is at the head)");
  await client.end();
  process.exit(0);
}
for (const f of pending) console.log(`  ${f}`);

if (planOnly) {
  console.log("\nmigrate-prod: PLAN_ONLY=true — exiting without applying.");
  await client.end();
  process.exit(0);
}

console.log("\nmigrate-prod: applying...");
for (const f of pending) {
  const sql = readFileSync(join(drizzleDir, f), "utf8");
  console.log(`\n--- applying ${f} ---`);
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO _schema_migrations (name) VALUES ($1)",
      [f],
    );
    await client.query("COMMIT");
    console.log(`  ok  ${f} applied`);
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    await client.end();
    console.error(`  FAIL  ${f}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

const { rows: finalRows } = await client.query(
  "SELECT name, applied_at FROM _schema_migrations ORDER BY name",
);
console.log("\nmigrate-prod: applied state after this run:");
for (const r of finalRows) {
  console.log(`  ${r.name}  (${r.applied_at.toISOString()})`);
}

await client.end();
console.log("\nmigrate-prod: done.");
