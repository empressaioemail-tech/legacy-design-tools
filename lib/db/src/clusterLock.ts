/**
 * Cluster-wide sweep lock helper.
 *
 * Multi-instance api-server (and any other horizontally-scaled
 * service) processes that run periodic cleanup ticks all wake up on
 * the same cadence, but the work itself only needs to run once per
 * tick across the cluster. Without coordination, every instance
 * scans the same table and contends on the same row locks for the
 * same DELETE.
 *
 * The standard Postgres-native fix is a transaction-scoped advisory
 * lock keyed on a sweep-specific namespace + the current schema:
 *
 *   1. Open a transaction.
 *   2. `pg_try_advisory_xact_lock(hashtextextended(NAMESPACE || '|' ||
 *      current_schema(), 0))`. Returns `true` on the lock-holder,
 *      `false` on every contender.
 *   3. If acquired, run the cleanup callback; otherwise short-circuit.
 *   4. COMMIT / ROLLBACK auto-releases the lock so a crashed sweeper
 *      cannot strand the lock for the rest of the cluster.
 *
 * Hashing the namespace together with `current_schema()` keeps
 * concurrent test schemas from contending on the same key while
 * still giving every production instance (all on `public`) the same
 * shared key. Test code can simulate a peer instance holding the
 * lock by computing the same hash on a borrowed pool connection
 * (see the existing adapter-cache and briefing-jobs sweep tests).
 *
 * This helper exists so future periodic cleanups (orphaned-upload
 * sweeps, etc.) opt in to the same cluster-wide coordination by
 * picking a namespace string instead of copy-pasting the SQL.
 */

import { sql } from "drizzle-orm";
import type { db as defaultDb } from "./index";

/**
 * Type alias for any drizzle handle compatible with the project's
 * shared `db` singleton — both the production export from
 * `@workspace/db` and the per-suite test schema's drizzle client
 * (which the testing helpers build with the same factory) satisfy
 * this. Callers do not need to thread their own type parameter.
 */
export type ClusterLockDbHandle = typeof defaultDb;

/**
 * Transaction handle passed to the callback. Mirrors the type the
 * underlying drizzle `transaction(fn)` API hands the inner function
 * so the callback can run scoped queries (`tx.execute(...)`,
 * `tx.delete(...)`, etc.) without re-typing.
 */
export type ClusterLockTxHandle = Parameters<
  Parameters<ClusterLockDbHandle["transaction"]>[0]
>[0];

/**
 * Result of a {@link withClusterSweepLock} call. The discriminated
 * union forces callers to handle the "peer holds the lock" branch
 * explicitly rather than mistaking a `0` return value for a
 * successful no-op tick.
 */
export type WithClusterSweepLockResult<T> =
  | { acquired: true; result: T }
  | { acquired: false };

/**
 * Run `fn` inside a transaction guarded by a cluster-wide Postgres
 * advisory lock keyed on `namespace`. If a peer instance is already
 * holding the same lock when this call begins, `fn` is NOT invoked
 * and the helper resolves to `{ acquired: false }`.
 *
 * Failure isolation is the caller's responsibility — exceptions
 * thrown inside `fn` propagate up after the transaction rolls back
 * (and the lock is released). Callers that want "errors are logged
 * and reported as 0" semantics should wrap the helper call in their
 * own try/catch the way `sweepExpiredAdapterCacheRows` does.
 *
 * Example:
 *   const outcome = await withClusterSweepLock(db, "my_sweep", async (tx) => {
 *     return await tx.delete(myTable).where(...).returning({ id: myTable.id });
 *   });
 *   if (!outcome.acquired) {
 *     log.debug({}, "my_sweep: peer holds advisory lock, skipping tick");
 *     return 0;
 *   }
 *   return outcome.result.length;
 */
export async function withClusterSweepLock<T>(
  dbHandle: ClusterLockDbHandle,
  namespace: string,
  fn: (tx: ClusterLockTxHandle) => Promise<T>,
): Promise<WithClusterSweepLockResult<T>> {
  return await dbHandle.transaction(async (tx) => {
    // pg_try_advisory_xact_lock returns true if it acquired the
    // lock, false if any other session is already holding it. The
    // hash key is derived in-DB from the namespace + current schema
    // so production instances (all on `public`) share one key while
    // concurrent test schemas stay isolated from each other.
    const lockResult = (await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(
            hashtextextended(${namespace} || '|' || current_schema(), 0)
          ) AS locked`,
    )) as unknown as { rows: Array<{ locked?: unknown }> };
    const locked = lockResult.rows?.[0]?.locked === true;
    if (!locked) {
      return { acquired: false } as const;
    }
    const result = await fn(tx);
    return { acquired: true, result } as const;
  });
}
