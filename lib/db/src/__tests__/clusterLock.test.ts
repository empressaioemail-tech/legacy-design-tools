/**
 * Focused unit tests for `withClusterSweepLock` (Task #274).
 *
 * The helper is exercised end-to-end through the adapter-cache and
 * briefing-generation-jobs sweep suites, but those tests pin the
 * sweep behavior — a regression scoped purely to the helper (e.g. a
 * future change that swaps the discriminated union shape, drops the
 * `current_schema()` scoping from the hash, or stops auto-releasing
 * on rollback) would only fail through both downstream suites at
 * once and the failure messages would point at sweep behavior rather
 * than the helper. These tests pin the helper's contract directly.
 *
 * Each test runs against a freshly-created per-suite schema (so the
 * `current_schema()` component of the lock hash is unique to this
 * test) and uses a borrowed pool connection to simulate a peer
 * api-server instance pre-holding a session-scoped advisory lock on
 * the same key — the same pattern the downstream sweep tests use.
 */

import { describe, it, expect } from "vitest";
import { withClusterSweepLock } from "../clusterLock";
import { withTestSchema } from "../testing";

const NAMESPACE = "test_cluster_lock_helper";
const OTHER_NAMESPACE = "test_cluster_lock_helper_other";

/** SQL that mirrors the helper's hash key derivation exactly. */
const LOCK_HASH_SQL = `hashtextextended($1 || '|' || current_schema(), 0)`;

describe("withClusterSweepLock", () => {
  it("invokes the callback and returns { acquired: true, result } when no peer holds the lock", async () => {
    await withTestSchema(async ({ db }) => {
      let invocations = 0;
      const outcome = await withClusterSweepLock(db, NAMESPACE, async () => {
        invocations += 1;
        return { rowsDeleted: 7 } as const;
      });
      expect(invocations).toBe(1);
      expect(outcome).toEqual({
        acquired: true,
        result: { rowsDeleted: 7 },
      });
    });
  });

  it("short-circuits to { acquired: false } and skips the callback when a peer holds a session-scoped lock on the same namespace + schema", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const peer = await pool.connect();
      let invocations = 0;
      try {
        // Session-scoped peer lock on the exact key the helper hashes.
        // Session and xact advisory locks share one keyspace, so this
        // blocks the helper's pg_try_advisory_xact_lock from acquiring.
        await peer.query(`SELECT pg_advisory_lock(${LOCK_HASH_SQL})`, [
          NAMESPACE,
        ]);

        const outcome = await withClusterSweepLock(db, NAMESPACE, async () => {
          invocations += 1;
          return "should never run" as const;
        });

        expect(outcome).toEqual({ acquired: false });
        expect(invocations).toBe(0);

        await peer.query(`SELECT pg_advisory_unlock(${LOCK_HASH_SQL})`, [
          NAMESPACE,
        ]);
      } finally {
        peer.release();
      }
    });
  });

  it("releases the lock on rollback when the callback throws and the next call can re-acquire", async () => {
    await withTestSchema(async ({ db }) => {
      const boom = new Error("callback exploded");
      await expect(
        withClusterSweepLock(db, NAMESPACE, async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);

      // If the lock had leaked across the failed transaction's
      // rollback, this second call would either short-circuit to
      // `{ acquired: false }` or hang. Instead it should acquire
      // cleanly and run the callback.
      let invocations = 0;
      const outcome = await withClusterSweepLock(db, NAMESPACE, async () => {
        invocations += 1;
        return "ok" as const;
      });
      expect(invocations).toBe(1);
      expect(outcome).toEqual({ acquired: true, result: "ok" });
    });
  });

  it("does not contend across namespaces on the same schema (a peer holding namespace A does not block namespace B)", async () => {
    await withTestSchema(async ({ db, pool }) => {
      const peer = await pool.connect();
      try {
        // Peer holds namespace A.
        await peer.query(`SELECT pg_advisory_lock(${LOCK_HASH_SQL})`, [
          NAMESPACE,
        ]);

        // Helper acquires namespace B in the same schema — must not
        // contend with the peer's namespace-A lock. The two
        // namespaces hash to different keys, so both locks coexist.
        let invocations = 0;
        const outcome = await withClusterSweepLock(
          db,
          OTHER_NAMESPACE,
          async () => {
            invocations += 1;
            return 42 as const;
          },
        );
        expect(invocations).toBe(1);
        expect(outcome).toEqual({ acquired: true, result: 42 });

        // And the peer's namespace-A lock is still held — a helper
        // call against namespace A must still short-circuit.
        const blocked = await withClusterSweepLock(
          db,
          NAMESPACE,
          async () => "should never run" as const,
        );
        expect(blocked).toEqual({ acquired: false });

        await peer.query(`SELECT pg_advisory_unlock(${LOCK_HASH_SQL})`, [
          NAMESPACE,
        ]);
      } finally {
        peer.release();
      }
    });
  });
});
