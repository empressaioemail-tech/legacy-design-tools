/**
 * Public test helpers for @workspace/db.
 *
 * Exposed via the `@workspace/db/testing` subpath so any package can run
 * integration tests against a real Postgres without reaching into lib/db's
 * `__tests__/` directory.
 *
 * Strategy: each call to {@link withTestSchema} creates a fresh schema named
 * `test_<unix_ts>_<random>`, replays the production DDL into it (see
 * `lib/db/src/__tests__/__fixtures__/schema.sql.template`), runs the body,
 * then drops the schema. Connections set
 * `search_path = <schema>, public` so unqualified Drizzle table refs land
 * in the test schema while shared types (e.g. pgvector's `vector`) remain
 * reachable in `public`.
 *
 * On every test run we also opportunistically reap orphaned `test_*` schemas
 * older than 1h (capped at 50/pass) to clean up after crashed runs.
 *
 * For cases where re-creating the schema between every test is too expensive
 * (api-server route tests etc.), use {@link truncateAll} to reset state
 * between tests within a single `withTestSchema` block.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import pg from "pg";
import * as schema from "../schema";

const { Pool } = pg;

// Derive __dirname in ESM so this module works whether it's loaded by vitest
// (which supplies __dirname) or by another ESM bundler (which doesn't).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SCHEMA_TEMPLATE_PATH = join(
  __dirname,
  "../__tests__/__fixtures__/schema.sql.template",
);
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
      "TEST_DATABASE_URL or DATABASE_URL must be set to run @workspace/db integration tests",
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
 * Open a fresh test schema and return its context. The caller is responsible
 * for invoking {@link dropTestSchema} to clean up — typically inside an
 * `afterAll` hook. Use this for one-schema-per-file integration suites where
 * setup cost dominates and `truncateAll` is preferable to `withTestSchema`.
 */
export async function createTestSchema(): Promise<TestSchemaContext> {
  const url = databaseUrl();
  const schemaName = generateSchemaName();
  const adminPool = new Pool({ connectionString: url, max: 1 });
  try {
    await reapStaleTestSchemas(adminPool);
  } catch {
    // ignore — never let reaper block tests
  }
  await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
  const ddl = loadSchemaTemplate().replace(/@@SCHEMA@@/g, `"${schemaName}"`);
  await adminPool.query(ddl);
  await adminPool.end();

  const url2 = new URL(url);
  url2.searchParams.set("options", `-c search_path=${schemaName},public`);
  const pool = new Pool({ connectionString: url2.toString(), max: 4 });
  const db = drizzle(pool, { schema });
  return { schemaName, pool, db };
}

/**
 * Drop the schema opened by {@link createTestSchema} and close its pool.
 * Idempotent and safe to call from `afterAll`.
 */
export async function dropTestSchema(ctx: TestSchemaContext): Promise<void> {
  await ctx.pool.end();
  const cleanup = new Pool({ connectionString: databaseUrl(), max: 1 });
  try {
    await cleanup.query(
      `DROP SCHEMA IF EXISTS "${ctx.schemaName}" CASCADE`,
    );
  } finally {
    await cleanup.end();
  }
}

/**
 * Run `body` against a freshly-created test schema. Always drops the schema
 * on exit (success or failure) and closes the dedicated pool. Returns
 * whatever `body` returns.
 *
 * The pool's connections are pre-configured with `search_path = <schema>,
 * public` so Drizzle's unqualified table SQL lands in the right place.
 *
 * For long suites where a single schema can serve all tests, prefer
 * {@link createTestSchema} + {@link truncateAll} + {@link dropTestSchema}.
 */
export async function withTestSchema<T>(
  body: (ctx: TestSchemaContext) => Promise<T>,
): Promise<T> {
  const ctx = await createTestSchema();
  try {
    return await body(ctx);
  } finally {
    await dropTestSchema(ctx);
  }
}

/**
 * Reset the named tables between tests within a single {@link withTestSchema}
 * block. Uses `TRUNCATE ... RESTART IDENTITY CASCADE` so sequences reset and
 * dependent tables are also cleared (CASCADE is required because our schema
 * has FK chains, e.g. engagement → snapshots → sheets).
 *
 * Caller passes the explicit table list — no auto-discovery. This forces
 * the test author to think about which tables they're nuking and avoids
 * surprises if the schema later gains tables that should be preserved
 * (e.g. seeded reference data).
 *
 * @example
 *   afterEach(async () => {
 *     await truncateAll(ctx.pool, ["engagements", "snapshots", "sheets"]);
 *   });
 */
export async function truncateAll(
  pool: pg.Pool,
  tableNames: readonly string[],
): Promise<void> {
  if (tableNames.length === 0) return;
  // Validate identifiers — pg.Pool.query parameters can't be used for
  // identifier positions, so we have to interpolate. Reject anything that
  // isn't a plain unquoted identifier.
  for (const t of tableNames) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(t)) {
      throw new Error(`truncateAll: invalid identifier ${JSON.stringify(t)}`);
    }
  }
  const list = tableNames.map((t) => `"${t}"`).join(", ");
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/** Re-exported for tests that want to use Drizzle's sql template literal. */
export { sql };
