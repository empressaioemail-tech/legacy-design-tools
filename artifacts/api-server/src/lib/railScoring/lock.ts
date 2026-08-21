/**
 * The scoring run's mutual exclusion, for callers that are not the server.
 *
 * WHY THIS EXISTS. `POST /api/county-ledger/score` serialises through
 * `withClusterSweepLock`, so two concurrent runs cannot interleave. The CLI
 * had no such guard, which meant the control existed on one of the two paths
 * that can write the ledger — a guardrail that does not survive being reached
 * a different way is not a guardrail (DEV_PROCESS 6.1). Worse, the CLI is the
 * path a human runs at 2am.
 *
 * ONE KEY, TWO CALLERS. Postgres advisory locks share a single key space
 * regardless of whether they were taken transaction-scoped
 * (`pg_try_advisory_xact_lock`, what the route uses) or session-scoped
 * (`pg_try_advisory_lock`, what a CLI needs, since it has no long transaction
 * to hang the lock on). So the two contend correctly with each other as long
 * as the KEY EXPRESSION is identical. It is duplicated here rather than
 * imported because `@workspace/db`'s helper takes a drizzle handle and this
 * path has a raw pool — so `lock.test.ts` reads `lib/db/src/clusterLock.ts`
 * and asserts the two expressions still agree. When one rule has two
 * implementations, the divergence test IS the control (DEV_PROCESS 2.4).
 *
 * SESSION-SCOPED LOCKS NEED ONE CONNECTION. `pool.query()` checks out an
 * arbitrary connection per call, so a session lock taken that way can be
 * released on a different connection, or leaked entirely. Callers must hand
 * this a single dedicated client and hold it for the run.
 */

import type { RailScoreQueryable } from "./measure";

/** Shared with `routes/countyRailScore.ts`. Distinct from the ledger recompute's namespace. */
export const RAIL_SCORE_LOCK_NAMESPACE = "county_rail_score";

/**
 * The advisory-lock key expression, character-for-character as
 * `@workspace/db`'s `withClusterSweepLock` computes it. Hashing the namespace
 * together with `current_schema()` keeps concurrent test schemas isolated
 * while giving every production caller (all on `public`) one shared key.
 */
export const RAIL_SCORE_LOCK_KEY_SQL =
  "hashtextextended($1 || '|' || current_schema(), 0)";

export type RailScoreLockOutcome<T> =
  | { acquired: true; result: T }
  | { acquired: false };

/**
 * Run `fn` while holding the scoring run's advisory lock, or report that a
 * peer holds it.
 *
 * `client` MUST be a single dedicated connection (`await pool.connect()` or a
 * `pg.Client`), not a pool — see the module header. The lock is released in a
 * `finally`, and a release failure is swallowed deliberately: the connection
 * closing drops the lock anyway, and masking the caller's real error with a
 * cleanup error would be worse.
 */
export async function withRailScoreLock<T>(
  client: RailScoreQueryable,
  namespace: string,
  fn: () => Promise<T>,
): Promise<RailScoreLockOutcome<T>> {
  const got = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock(${RAIL_SCORE_LOCK_KEY_SQL}) AS locked`,
    [namespace],
  );
  if (got.rows[0]?.locked !== true) return { acquired: false };
  try {
    return { acquired: true, result: await fn() };
  } finally {
    try {
      await client.query(
        `SELECT pg_advisory_unlock(${RAIL_SCORE_LOCK_KEY_SQL})`,
        [namespace],
      );
    } catch {
      // The connection closing releases it. Never mask the caller's error.
    }
  }
}
