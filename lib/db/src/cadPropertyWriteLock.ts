/**
 * `cad_property` write lock (Phase 1 B0-4 / gate 4, audit P4, 2026-10-07).
 *
 * `cad_property` has no write lock today (audit section 4, "Still open":
 * "Two writers in the same hour added 91,931 unexplained rows to Tarrant's
 * `cad_property`; that table has no lock."). `atoms_writer_lease_v2`
 * (hauska-engine's `packages/storage`) cannot be reused directly: it lives
 * on the ATOMS_DATABASE_URL host, a different database from the one
 * `cad_property` lives on (STAGING_NEONDB_URL / PRODUCTION_NEONDB_URL, the
 * cortex/LDT Neon host). A lease minted on one database is not visible to
 * a writer connected to the other, and no transaction can span both, so a
 * lease table there cannot gate a write here.
 *
 * This reuses the pattern already in this package
 * (`clusterLock.ts`'s `withClusterSweepLock`, a transaction-scoped
 * `pg_try_advisory_xact_lock`) rather than inventing a second lease table:
 * a Postgres session-level advisory lock, `pg_try_advisory_lock`, scoped to
 * (`cad_property write`, `county_fips`), on the database that actually
 * holds `cad_property`. Session-scoped rather than transaction-scoped
 * because the main cad-ingest write run (`ingest.ts`'s `upsertCadProperties`)
 * is not one transaction — it is many batched upserts — so the lock must
 * outlive any single transaction. Session-scoped rather than TTL-leased
 * because Postgres itself releases a session lock the moment its holding
 * connection closes, including a crashed writer's connection: there is no
 * stale-lease window to manage, unlike a row-based lease that needs a TTL
 * and a steal rule.
 *
 * `pg_try_advisory_lock` (never the blocking `pg_advisory_lock`): a second
 * writer refuses immediately with `CAD_PROPERTY_WRITE_LOCKED` rather than
 * queuing behind the first.
 *
 * Every writer of `cad_property` takes this lock, on the SAME connection it
 * will write through, before its first write, and releases it in a
 * `finally`:
 *  - `lib/cad-ingest/src/cli.ts` (the bulk CAD loader)
 *  - `lib/cad-ingest/src/published-identifier-backfill-cli.ts`
 *  - `lib/db/scripts/p124-ctx-leaves2-private-road-correction.mjs` (a raw
 *    `pg` script outside this package's TS build; it computes the SAME
 *    lock key inline — see that script's own comment — so it contends on
 *    the identical advisory lock rather than a parallel one).
 */

export const CAD_PROPERTY_WRITE_LOCKED = "CAD_PROPERTY_WRITE_LOCKED";

/** Same string every writer must hash identically, including the one duplicating this by hand (see file header). */
export const CAD_PROPERTY_LOCK_NAMESPACE_PREFIX = "cad_property_write|";

export function cadPropertyLockNamespace(countyFips: string): string {
  return `${CAD_PROPERTY_LOCK_NAMESPACE_PREFIX}${countyFips}`;
}

export class CadPropertyWriteLockedError extends Error {
  readonly code = CAD_PROPERTY_WRITE_LOCKED;
  readonly countyFips: string;
  constructor(countyFips: string) {
    super(
      `${CAD_PROPERTY_WRITE_LOCKED}: another cad_property writer already holds the ` +
        `session advisory lock for county ${countyFips}. Two writers on one county at ` +
        "once is the exact Tarrant-class defect (audit P4, 2026-10-07: 91,931 " +
        "unexplained rows added by two writers in one hour). Wait for the other " +
        "writer to finish (its session closing releases the lock) and retry.",
    );
    this.name = "CadPropertyWriteLockedError";
    this.countyFips = countyFips;
  }
}

/**
 * Minimal shape both `pg.Pool` and `pg.Client` satisfy. The caller passes
 * the ONE connection it intends to hold for the whole write run — a lock
 * taken via a `Pool`'s auto-checkout-per-query would attach to whichever
 * physical connection served that one query and could be silently returned
 * to the pool's idle set, not held.
 */
export interface CadPropertyLockClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface HeldCadPropertyWriteLock {
  readonly countyFips: string;
  /** Idempotent: safe to call more than once (e.g. once explicitly, once from a finally). */
  release(): Promise<void>;
}

/**
 * Takes the county-scoped `cad_property` write lock on `client`'s current
 * connection/session. Throws {@link CadPropertyWriteLockedError} immediately
 * (never blocks) when a live peer already holds it.
 *
 * `client` MUST be a single pinned connection (a `pg.Client`, or one
 * `pg.PoolClient` checked out via `pool.connect()` and not released back to
 * the pool until {@link HeldCadPropertyWriteLock.release} runs) — not a bare
 * `pg.Pool`, whose `.query()` can hand each call a different physical
 * connection and so cannot hold a session lock across a run.
 */
export async function takeCadPropertyWriteLock(
  client: CadPropertyLockClient,
  countyFips: string,
): Promise<HeldCadPropertyWriteLock> {
  if (!/^\d{5}$/.test(countyFips)) {
    throw new Error(`takeCadPropertyWriteLock requires a 5-digit county_fips, got ${JSON.stringify(countyFips)}`);
  }
  const namespace = cadPropertyLockNamespace(countyFips);
  // hashtextextended($1 || '|' || current_schema(), 0): the same
  // schema-qualified hash `clusterLock.ts`'s withClusterSweepLock uses.
  // In production there is one schema (`public`) on each database, so
  // this costs nothing there; it is what lets concurrent test runs (each
  // in `withTestSchema`'s own per-suite schema, see cadPropertyWriteLock
  // .test.ts) exercise a real lock conflict without colliding with each
  // other's advisory-lock keys on a shared test Postgres instance.
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended($1 || '|' || current_schema(), 0)) AS locked",
    [namespace],
  );
  if (rows[0]?.locked !== true) {
    throw new CadPropertyWriteLockedError(countyFips);
  }
  let released = false;
  return {
    countyFips,
    async release() {
      if (released) return;
      released = true;
      await client.query(
        "SELECT pg_advisory_unlock(hashtextextended($1 || '|' || current_schema(), 0))",
        [namespace],
      );
    },
  };
}

/** Take the lock, run `fn`, release in a `finally` — the shape every call site should use. */
export async function withCadPropertyWriteLock<T>(
  client: CadPropertyLockClient,
  countyFips: string,
  fn: (lock: HeldCadPropertyWriteLock) => Promise<T>,
): Promise<T> {
  const lock = await takeCadPropertyWriteLock(client, countyFips);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
