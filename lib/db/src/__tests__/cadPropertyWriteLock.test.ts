/**
 * `takeCadPropertyWriteLock` / `withCadPropertyWriteLock` (gate 4 / P4,
 * audit 2026-10-07: "cad_property has no write lock" — two writers in one
 * hour added 91,931 unexplained rows to Tarrant's `cad_property`).
 *
 * Same pattern as `clusterLock.test.ts`: a per-suite `withTestSchema`
 * schema (so the `current_schema()` component of the hash key keeps
 * concurrent test runs from contending with each other), and a borrowed
 * pool connection standing in for a peer writer that is STILL holding its
 * lock — never released before the second claim is attempted — so the
 * "two concurrent writers" break test genuinely overlaps in time rather
 * than running the two claims one after another (WDLL 4.1).
 */

import { describe, it, expect, vi } from "vitest";
import {
  CadPropertyLockPooledConnectionError,
  CadPropertyWriteLockedError,
  CAD_PROPERTY_LOCK_POOLED_CONNECTION,
  takeCadPropertyWriteLock,
  withCadPropertyWriteLock,
  type CadPropertyLockClient,
} from "../cadPropertyWriteLock";
import { withTestSchema } from "../testing";

const BURNET_FIPS = "48053";
const WILLIAMSON_FIPS = "48491";
/** Mirrors the module's own `hashtextextended($1 || '|' || current_schema(), 0)`. */
const LOCK_HASH_SQL = `hashtextextended($1 || '|' || current_schema(), 0)`;

describe("takeCadPropertyWriteLock", () => {
  it("acquires cleanly when no peer holds the county's lock, and release() lets a later take re-acquire", async () => {
    await withTestSchema(async ({ pool }) => {
      const client = await pool.connect();
      try {
        const lock = await takeCadPropertyWriteLock(client, BURNET_FIPS);
        expect(lock.countyFips).toBe(BURNET_FIPS);
        await lock.release();

        // Did not leak: a second take on the same connection succeeds.
        const lock2 = await takeCadPropertyWriteLock(client, BURNET_FIPS);
        await lock2.release();
      } finally {
        client.release();
      }
    });
  });

  it("REFUSES CAD_PROPERTY_WRITE_LOCKED when a peer still holds the lock for the SAME county — the two claims overlap, the peer is never released first", async () => {
    await withTestSchema(async ({ pool }) => {
      const peer = await pool.connect();
      const contender = await pool.connect();
      try {
        // Peer takes the lock and DOES NOT release it before the
        // contender's claim below — this is the overlap the break test
        // requires, not two sequential claims.
        const peerLock = await takeCadPropertyWriteLock(peer, BURNET_FIPS);

        await expect(
          takeCadPropertyWriteLock(contender, BURNET_FIPS),
        ).rejects.toBeInstanceOf(CadPropertyWriteLockedError);
        await expect(
          takeCadPropertyWriteLock(contender, BURNET_FIPS),
        ).rejects.toMatchObject({ code: "CAD_PROPERTY_WRITE_LOCKED", countyFips: BURNET_FIPS });

        // Still refuses while the peer is live — confirms the refusal
        // was not a one-shot fluke of the first attempt.
        const stillLocked = await pool.query(
          `SELECT pg_try_advisory_lock(${LOCK_HASH_SQL}) AS locked`,
          [`cad_property_write|${BURNET_FIPS}`],
        );
        // (pool.query may hand this a different connection than either
        // peer or contender; if it happens to get a THIRD free
        // connection it will also see the lock held.)
        expect(stillLocked.rows[0]?.locked).toBe(false);

        await peerLock.release();

        // Now that the peer released, the contender can acquire.
        const nowFree = await takeCadPropertyWriteLock(contender, BURNET_FIPS);
        await nowFree.release();
      } finally {
        peer.release();
        contender.release();
      }
    });
  });

  it("does not contend across counties — a peer holding Williamson's lock does not block a Burnet claim", async () => {
    await withTestSchema(async ({ pool }) => {
      const peer = await pool.connect();
      const contender = await pool.connect();
      try {
        const peerLock = await takeCadPropertyWriteLock(peer, WILLIAMSON_FIPS);

        const burnetLock = await takeCadPropertyWriteLock(contender, BURNET_FIPS);
        await burnetLock.release();

        await peerLock.release();
      } finally {
        peer.release();
        contender.release();
      }
    });
  });

  it("rejects a county_fips that is not a 5-digit FIPS, before taking anything", async () => {
    await withTestSchema(async ({ pool }) => {
      const client = await pool.connect();
      try {
        await expect(takeCadPropertyWriteLock(client, "GLOBAL")).rejects.toThrow(
          /5-digit county_fips/,
        );
        await expect(takeCadPropertyWriteLock(client, "")).rejects.toThrow(
          /5-digit county_fips/,
        );
      } finally {
        client.release();
      }
    });
  });
});

describe("withCadPropertyWriteLock", () => {
  it("releases on success and on throw, so a failed writer never strands the county locked", async () => {
    await withTestSchema(async ({ pool }) => {
      const client = await pool.connect();
      const peer = await pool.connect();
      try {
        let ran = 0;
        const result = await withCadPropertyWriteLock(client, BURNET_FIPS, async () => {
          ran += 1;
          return "wrote the batch";
        });
        expect(result).toBe("wrote the batch");
        expect(ran).toBe(1);

        // Released: a peer can now take it.
        const peerLock = await takeCadPropertyWriteLock(peer, BURNET_FIPS);
        await peerLock.release();

        const boom = new Error("batch write failed mid-run");
        await expect(
          withCadPropertyWriteLock(client, BURNET_FIPS, async () => {
            throw boom;
          }),
        ).rejects.toBe(boom);

        // Still released after the throw.
        const peerLock2 = await takeCadPropertyWriteLock(peer, BURNET_FIPS);
        await peerLock2.release();
      } finally {
        client.release();
        peer.release();
      }
    });
  });
});

/**
 * Pooled-connection refusal (2026-10-07, coordinator-requested fix to this
 * same PR). `pg_try_advisory_lock` is session-scoped, and a Neon `-pooler`
 * host runs PgBouncer in transaction mode, which can return the underlying
 * server connection to the pool between statements -- a lock taken through
 * one is never reliably held or released by the client that took it. This
 * is checked on the CLIENT's own recorded host (no real DB connection
 * needed), so these tests use a minimal fake rather than `withTestSchema`.
 */
function fakeClient(
  host: string | undefined,
  opts: { viaConnectionParameters?: boolean; viaHost?: boolean; locked?: boolean } = {},
): CadPropertyLockClient & { query: ReturnType<typeof vi.fn> } {
  const { viaConnectionParameters = true, viaHost = true, locked = true } = opts;
  const query = vi.fn(async () => ({ rows: [{ locked }] }));
  const fake = {
    query,
    ...(viaConnectionParameters ? { connectionParameters: { host } } : {}),
    ...(viaHost ? { host } : {}),
  };
  return fake as unknown as CadPropertyLockClient & { query: typeof query };
}

describe("takeCadPropertyWriteLock: pooled-connection refusal", () => {
  it("REFUSES CAD_PROPERTY_LOCK_POOLED_CONNECTION for a -pooler host, WITHOUT ever issuing the lock query", async () => {
    const client = fakeClient("ep-abc-pooler.us-east-2.aws.neon.tech");
    await expect(takeCadPropertyWriteLock(client, BURNET_FIPS)).rejects.toBeInstanceOf(
      CadPropertyLockPooledConnectionError,
    );
    await expect(takeCadPropertyWriteLock(client, BURNET_FIPS)).rejects.toMatchObject({
      code: CAD_PROPERTY_LOCK_POOLED_CONNECTION,
      host: "ep-abc-pooler.us-east-2.aws.neon.tech",
    });
    expect(client.query).not.toHaveBeenCalled();
  });

  it("PROCEEDS for an unpooled (direct) host — the lock query is issued and the lock is returned", async () => {
    const client = fakeClient("ep-abc.us-east-2.aws.neon.tech");
    const lock = await takeCadPropertyWriteLock(client, BURNET_FIPS);
    expect(lock.countyFips).toBe(BURNET_FIPS);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("pg_try_advisory_lock"), [
      `cad_property_write|${BURNET_FIPS}`,
    ]);
  });

  it("refuses via connectionParameters.host alone (no top-level .host)", async () => {
    const client = fakeClient("ep-abc-pooler.us-east-2.aws.neon.tech", { viaHost: false });
    await expect(takeCadPropertyWriteLock(client, BURNET_FIPS)).rejects.toBeInstanceOf(
      CadPropertyLockPooledConnectionError,
    );
  });

  it("refuses via the top-level .host alone (no connectionParameters)", async () => {
    const client = fakeClient("ep-abc-pooler.us-east-2.aws.neon.tech", { viaConnectionParameters: false });
    await expect(takeCadPropertyWriteLock(client, BURNET_FIPS)).rejects.toBeInstanceOf(
      CadPropertyLockPooledConnectionError,
    );
  });

  it("a client with neither host property proceeds (an unknown host is not a known pooler host)", async () => {
    const client = fakeClient(undefined, { viaConnectionParameters: false, viaHost: false });
    const lock = await takeCadPropertyWriteLock(client, BURNET_FIPS);
    expect(lock.countyFips).toBe(BURNET_FIPS);
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("a REAL pg.Client built from a -pooler connection string is refused before this module ever calls .connect()", async () => {
    // No network connection is made or needed: pg.Client parses the
    // connection string at construction, and connectionParameters.host is
    // set synchronously from it.
    const pg = await import("pg");
    const client = new pg.Client({
      connectionString: "postgres://user:pass@ep-abc-pooler.us-east-2.aws.neon.tech:5432/db",
    });
    try {
      await expect(takeCadPropertyWriteLock(client as never, BURNET_FIPS)).rejects.toBeInstanceOf(
        CadPropertyLockPooledConnectionError,
      );
    } finally {
      // Never connected, so nothing to close; end() on an unconnected
      // client is a harmless no-op guard against a future refactor that
      // connects it before this assertion.
      await client.end().catch(() => {});
    }
  });
});
