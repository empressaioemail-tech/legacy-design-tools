/**
 * Test utilities for lib/db integration tests.
 *
 * The strategy: each test runs against a freshly-created Postgres schema
 * named `test_<unix_ts>_<random>`, into which the production DDL is replayed
 * (see __fixtures__/schema.sql.template). Connections set
 * `search_path = <schema>, public` so unqualified table references in the
 * Drizzle schema resolve into the test schema, while shared things in
 * `public` (like the pgvector type) remain reachable.
 *
 * On every test run we also reap stale `test_*` schemas older than 1h
 * (capped at 50 per pass) — this guards against orphans from crashed runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../schema";

const { Pool } = pg;

const SCHEMA_TEMPLATE_PATH = join(__dirname, "__fixtures__/schema.sql.template");
const REAP_AGE_MS = 60 * 60 * 1000; // 1 hour
const REAP_CAP_PER_PASS = 50;

export type TestDb = ReturnType<typeof drizzle<typeof schema>>;

export interface TestSchemaContext {
  schemaName: string;
  pool: pg.Pool;
  db: TestDb;
}

function databaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL or DATABASE_URL must be set to run lib/db integration tests",
    );
  }
  return url;
}

export function generateSchemaName(): string {
  const ts = Math.floor(Date.now() / 1000);
  const rand = randomBytes(4).toString("hex");
  return `test_${ts}_${rand}`;
}

let cachedTemplate: string | null = null;
function loadSchemaTemplate(): string {
  if (cachedTemplate === null) {
    cachedTemplate = readFileSync(SCHEMA_TEMPLATE_PATH, "utf8");
  }
  return cachedTemplate;
}

/**
 * Reaper: drop every `test_<unix_ts>_<...>` schema older than REAP_AGE_MS.
 * Capped at {@link REAP_CAP_PER_PASS} drops per invocation so a runaway
 * never burns through the whole DB. Safe to call concurrently — DROP SCHEMA
 * IF EXISTS is idempotent.
 */
export async function reapStaleTestSchemas(
  pool: pg.Pool,
  now: Date = new Date(),
): Promise<{ dropped: string[] }> {
  const cutoff = Math.floor((now.getTime() - REAP_AGE_MS) / 1000);
  const res = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname ~ '^test_[0-9]+_'
       AND substring(nspname FROM '^test_([0-9]+)_')::bigint < $1
     ORDER BY nspname
     LIMIT $2`,
    [cutoff, REAP_CAP_PER_PASS],
  );
  const dropped: string[] = [];
  for (const row of res.rows) {
    // Identifier is regex-validated above; safe to interpolate.
    await pool.query(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`);
    dropped.push(row.nspname);
  }
  return { dropped };
}

/**
 * Run `body` against a freshly-created test schema. Always drops the schema
 * on exit (success or failure) and closes the dedicated pool. Returns
 * whatever `body` returns.
 *
 * The pool's connections are pre-configured with `search_path = <schema>,
 * public` so Drizzle's unqualified table SQL lands in the right place.
 */
export async function withTestSchema<T>(
  body: (ctx: TestSchemaContext) => Promise<T>,
): Promise<T> {
  const url = databaseUrl();
  const schemaName = generateSchemaName();
  const adminPool = new Pool({ connectionString: url, max: 1 });
  // Fast-path opportunistic reaper. Best-effort; failures are non-fatal.
  try {
    await reapStaleTestSchemas(adminPool);
  } catch {
    // ignore — never let reaper block tests
  }

  // Identifier validated by generateSchemaName (regex-safe).
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);

  // Replay the production DDL into the new schema. The template uses the
  // sentinel `@@SCHEMA@@` everywhere we'd otherwise see `public.`.
  const ddl = loadSchemaTemplate().replace(/@@SCHEMA@@/g, `"${schemaName}"`);
  await adminPool.query(ddl);
  await adminPool.end();

  // Now build a pool whose every connection lands in the test schema. We use
  // the libpq `options` connection parameter to set search_path before any
  // query runs.
  const url2 = new URL(url);
  url2.searchParams.set("options", `-c search_path=${schemaName},public`);
  const pool = new Pool({ connectionString: url2.toString(), max: 4 });
  const db = drizzle(pool, { schema });

  try {
    return await body({ schemaName, pool, db });
  } finally {
    await pool.end();
    const cleanup = new Pool({ connectionString: url, max: 1 });
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await cleanup.end();
    }
  }
}

/** Re-exported for tests that want to use Drizzle's sql template literal. */
export { sql };
