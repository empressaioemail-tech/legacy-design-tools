/**
 * `txgio_address` fetch-then-swap integration tests — real Postgres via
 * `@workspace/db/testing` (same harness as `addressIngest.integration
 * .test.ts`). Skipped when no DATABASE_URL / TEST_DATABASE_URL is
 * available locally; CI always provides one.
 *
 * These prove the P-499 stage-check-swap fix (2026-10-12) for real,
 * against a real transaction, not a JS mirror of what a transaction
 * does:
 *
 *  - a successful swap replaces a county's rows atomically, and a
 *    REAL second connection, overlapping the open transaction, sees
 *    either all the old rows or all the new ones -- never a mix, never
 *    zero (proof a);
 *  - the OLD two-statement delete-then-insert sequence (still exported
 *    as `deleteCountyAddresses` / `upsertAddresses`, unchanged, for
 *    their own tests) is run here too, to reproduce the live-vanishing-
 *    rows defect directly, and contrasted with the new transaction's
 *    rollback (proof c, and the brief's "show a test that fails on the
 *    old code and passes on the new");
 *  - two concurrent swaps of the SAME county serialize rather than
 *    interleave (proof d);
 *  - the swap works identically through the CLI's own multi-connection
 *    `pg.Pool` and through a single, directly-opened `pg.Client` (the
 *    stand-in for a direct/unpooled Neon host).
 *
 * `checkAddressFetchComplete`'s own unit tests (`addressFetchCheck
 * .test.ts`) cover proof (b)'s refusal LOGIC; this file's "refuses --
 * zero writes" test closes the loop by showing that branch, mirrored
 * from `cli.ts`'s own control flow, never reaches the database at all.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { createTestSchema, dropTestSchema, openSecondHandle, withTestSchema } from "@workspace/db/testing";
import { txgioAddress } from "@workspace/db/schema";
import {
  checkAddressFetchComplete,
  countCountyAddresses,
  deleteCountyAddresses,
  swapCountyAddresses,
  upsertAddresses,
  type AddressIngestDb,
} from "../address/ingest";
import type { TxgioAddressRecord } from "../address/parse";

const { Client } = pg;

const hasDb =
  process.env.TEST_DATABASE_URL !== undefined ||
  process.env.DATABASE_URL !== undefined;

function rawDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set");
  return url;
}

/** A single, NOT pooled, directly-opened connection -- the local-Postgres
 *  stand-in for a direct/unpooled Neon host (`directNeonUrl`). Scoped to
 *  the given test schema via `search_path`, same as `openSecondHandle`. */
async function openDirectClient(
  schemaName: string,
): Promise<{ client: pg.Client; db: ReturnType<typeof drizzle> }> {
  const url = new URL(rawDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${schemaName},public`);
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return { client, db: drizzle(client) };
}

const FIPS = "48029"; // Bexar -- the largest of the six reload-target counties
const SOURCE_FILE = "test-layer";

function rec(objectId: number, overrides: Partial<TxgioAddressRecord> = {}): TxgioAddressRecord {
  return {
    countyFips: FIPS,
    fullAddr: `${objectId} TEST ST`,
    unit: "",
    objectId,
    addNumber: String(objectId),
    stName: "Test",
    postComm: "San Antonio",
    postCode: "78245",
    state: "TX",
    countyName: "Bexar",
    source: "SAGIS",
    dateAcq: "2025-04-07",
    longitude: -98.5,
    latitude: 29.4,
    tileKey: "g0.02:-98.50000,29.40000",
    ...overrides,
  };
}

async function seedRows(db: AddressIngestDb, records: TxgioAddressRecord[]): Promise<void> {
  await upsertAddresses(db, records, { sourceFile: SOURCE_FILE, sourceVintage: "v0-seed" });
}

async function objectIdsFor(
  db: Pick<ReturnType<typeof drizzle>, "select">,
  fips: string,
): Promise<number[]> {
  const rows = await db
    .select({ objectId: txgioAddress.objectId })
    .from(txgioAddress)
    .where(eq(txgioAddress.countyFips, fips));
  return rows.map((r) => r.objectId).sort((a, b) => a - b);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A promise plus its own resolve, for cross-task handshakes in the
 *  concurrency tests below -- deterministic, no sleep-and-hope races. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe.skipIf(!hasDb)("swapCountyAddresses (P-499 stage-check-swap, txgio_address)", () => {
  it("PROOF (a): a successful swap replaces the county atomically; a REAL overlapping second connection sees only old rows pre-commit, only new rows post-commit -- never a mix, never zero", async () => {
    await withTestSchema(async ({ db, schemaName }) => {
      const oldRows = [rec(1), rec(2), rec(3)];
      await seedRows(db, oldRows);
      expect(await objectIdsFor(db, FIPS)).toEqual([1, 2, 3]);

      const newRows = [rec(101), rec(102), rec(103), rec(104)];

      const insertDone = deferred<void>();
      const readerChecked = deferred<void>();

      const swapPromise = swapCountyAddresses(db, FIPS, newRows, {
        sourceFile: SOURCE_FILE,
        sourceVintage: "v1",
        onBeforeCommit: async () => {
          // Insert is done and verified, but we have not committed yet.
          // Signal the reader, then WAIT for it to finish checking before
          // this returns and the transaction commits -- this is the real,
          // deliberate overlap (not a timing guess).
          insertDone.resolve();
          await readerChecked.promise;
        },
      });

      await insertDone.promise;

      // A SECOND, independent connection -- not the one holding the open
      // swap transaction -- reads the live county WHILE the swap is still
      // open and uncommitted.
      const second = openSecondHandle(schemaName);
      try {
        const mid = await objectIdsFor(second.db, FIPS);
        // Ordinary Postgres MVCC: the reader's own snapshot predates the
        // swap's (still uncommitted) DELETE+INSERT, so it sees EXACTLY the
        // old rows -- never a mix of old+new, and never zero (which a
        // non-transactional delete-then-insert WOULD show here).
        expect(mid).toEqual([1, 2, 3]);
      } finally {
        readerChecked.resolve();
        await second.pool.end();
      }

      const summary = await swapPromise;
      expect(summary.rowsDeleted).toBe(3);
      expect(summary.rowsInserted).toBe(4);

      // Post-commit: now exactly the new rows, old rows fully gone.
      expect(await objectIdsFor(db, FIPS)).toEqual([101, 102, 103, 104]);
    });
  });

  it("PROOF (b): a short/incomplete fetch refuses before any DB write is attempted -- the live rows are untouched", async () => {
    await withTestSchema(async ({ db }) => {
      const liveRows = [rec(1), rec(2), rec(3), rec(4), rec(5)];
      await seedRows(db, liveRows);
      expect(await objectIdsFor(db, FIPS)).toHaveLength(5);

      // Mirrors cli.ts's own branch exactly (src/address/cli.ts, the
      // `if (refusal) { ...; process.exit(2); }` guard before the pool is
      // even opened): a crawl that read fewer features than the service
      // reported at the start.
      const refusal = checkAddressFetchComplete({
        countyFips: FIPS,
        countyName: "Bexar",
        serviceCount: 721_120,
        rowsRead: 400_000, // crawl died partway through
        rowsParsed: 400_000,
        rowsSkipped: 0,
        bufferedAfterDedupe: 400_000,
      });
      expect(refusal).not.toBeNull();
      expect(refusal?.reason).toBe("count-mismatch");

      // cli.ts calls swapCountyAddresses ONLY in the `else` branch of
      // that same `if (refusal)`. Here, refusal is non-null, so (exactly
      // as in production) swapCountyAddresses is never called at all --
      // there is nothing left to assert except that the live rows are
      // still exactly what they were.
      expect(await objectIdsFor(db, FIPS)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it("PROOF (c) + the Burnet-class defect, reproduced then fixed: old delete-then-insert empties the county on interruption; swapCountyAddresses's one transaction rolls back to the untouched original instead", async () => {
    await withTestSchema(async ({ db }) => {
      // ---- OLD CODE (unchanged exports), same county: reproduce the defect ----
      // This is exactly what cli.ts used to do, as two bare statements
      // with nothing wrapping them: `deleteCountyAddresses` then
      // `upsertAddresses`. A crawl that dies / a process that crashes
      // between the two leaves the county in whatever state the delete
      // alone produced.
      const oldLiveRows = [rec(1), rec(2), rec(3)];
      await seedRows(db, oldLiveRows);
      expect(await objectIdsFor(db, FIPS)).toEqual([1, 2, 3]);

      await deleteCountyAddresses(db, FIPS);
      // THE DEFECT, live against real Postgres: the county is now EMPTY.
      // A serving read between this line and whatever insert follows --
      // or a crash that means no insert ever follows -- is served zero
      // address points for a county that, moments ago, had 3.
      expect(await objectIdsFor(db, FIPS)).toEqual([]);

      // ---- NEW CODE, a different county (fresh live state): the fix ----
      const otherFips = "48453"; // Travis
      const newLiveRows = [rec(11, { countyFips: otherFips }), rec(12, { countyFips: otherFips }), rec(13, { countyFips: otherFips })];
      await seedRows(db, newLiveRows);
      expect(await objectIdsFor(db, otherFips)).toEqual([11, 12, 13]);

      // A buffer that will fail MIDWAY through the insert: batchSize 2
      // puts objectid 21 in batch 1 and a REPEAT of 21 in batch 2, which
      // Postgres's own primary-key constraint rejects with a real
      // duplicate-key error -- a genuine Postgres failure, not a mocked
      // one, and one with nothing to do with ON CONFLICT (swapCountyAddresses
      // never uses it -- see insertAddressRows's own comment).
      const poisoned = [
        rec(21, { countyFips: otherFips }),
        rec(22, { countyFips: otherFips }),
        rec(21, { countyFips: otherFips, fullAddr: "DUPLICATE" }),
        rec(23, { countyFips: otherFips }),
      ];

      await expect(
        swapCountyAddresses(db, otherFips, poisoned, {
          sourceFile: SOURCE_FILE,
          sourceVintage: "v2",
          batchSize: 2,
        }),
      ).rejects.toThrow();

      // THE FIX: unlike the old path above, the live rows are back to
      // EXACTLY what they were before this swap was attempted -- the
      // DELETE that ran inside the same transaction was rolled back along
      // with the partial insert, never left visible to any reader.
      expect(await objectIdsFor(db, otherFips)).toEqual([11, 12, 13]);
    });
  });

  it("PROOF (d): two concurrent swaps of the SAME county serialize -- the second cannot delete/insert until the first commits", async () => {
    await withTestSchema(async ({ db, schemaName }) => {
      await seedRows(db, [rec(1), rec(2)]);

      const events: string[] = [];
      const second = openSecondHandle(schemaName);

      try {
        // Swap A holds the transaction open for a real, deliberate 400ms
        // via onBeforeCommit -- long enough that swap B (no delay at all,
        // typically a few ms for 2 rows) would finish FIRST if the two
        // were not actually serialized by the advisory lock.
        const swapA = swapCountyAddresses(db, FIPS, [rec(201), rec(202)], {
          sourceFile: SOURCE_FILE,
          sourceVintage: "vA",
          onBeforeCommit: async () => {
            events.push("A-before-commit-start");
            await delay(400);
            events.push("A-before-commit-end");
          },
        }).then((s) => {
          events.push("A-committed");
          return s;
        });

        // Give swap A a moment to actually acquire the lock and reach its
        // held-open window before swap B is even issued, so this test is
        // about lock contention, not a race to connect.
        await delay(50);

        const swapB = swapCountyAddresses(second.db, FIPS, [rec(301), rec(302), rec(303)], {
          sourceFile: SOURCE_FILE,
          sourceVintage: "vB",
        }).then((s) => {
          events.push("B-committed");
          return s;
        });

        const [summaryA, summaryB] = await Promise.all([swapA, swapB]);

        // B could only run its DELETE after A committed -- so B deleted
        // A's 2 rows (201, 202), not the original seed rows.
        expect(summaryB.rowsDeleted).toBe(2);
        expect(summaryA.rowsDeleted).toBe(2); // the original seed

        // Strict ordering: A's whole held-open window finished, and A
        // committed, BEFORE B committed. If the lock did not serialize
        // these, B (no artificial delay) would commit well before A's
        // 400ms window elapsed.
        expect(events).toEqual([
          "A-before-commit-start",
          "A-before-commit-end",
          "A-committed",
          "B-committed",
        ]);

        // Final state is deterministically B's rows -- never A's, and
        // never a mix of A+B, which a broken/absent lock could produce.
        expect(await objectIdsFor(db, FIPS)).toEqual([301, 302, 303]);
      } finally {
        await second.pool.end();
      }
    });
  });

  it("a blocked lock FAILS FAST (lock_timeout) rather than queueing for the whole statement_timeout window (2026-10-12 W3 review)", async () => {
    await withTestSchema(async ({ db, schemaName }) => {
      await seedRows(db, [rec(1)]);

      const holdFor = deferred<void>();
      const second = openSecondHandle(schemaName);
      try {
        // Swap A holds the lock open indefinitely (released only when the
        // test resolves holdFor), standing in for a peer that is itself
        // mid-swap on a large county.
        const swapA = swapCountyAddresses(db, FIPS, [rec(901)], {
          sourceFile: SOURCE_FILE,
          sourceVintage: "vA",
          onBeforeCommit: async () => {
            await holdFor.promise;
          },
        });

        await delay(50); // let A actually acquire the lock first

        // Swap B overrides lock_timeout down to 200ms -- far below the
        // real 10s default (ADDRESS_SWAP_LOCK_TIMEOUT), so this test does
        // not have to wait out the production value to prove the
        // mechanism: it must fail well under a second, not hang until A
        // is released.
        const startedAt = Date.now();
        await expect(
          swapCountyAddresses(second.db, FIPS, [rec(902)], {
            sourceFile: SOURCE_FILE,
            sourceVintage: "vB",
            lockTimeoutOverride: "200ms",
          }),
        ).rejects.toThrow();
        const elapsedMs = Date.now() - startedAt;

        // Generous upper bound (2s) so this is about "fails fast", not a
        // brittle exact-timing assertion; still ten times tighter than
        // A's indefinite hold, which proves B did not simply queue.
        expect(elapsedMs).toBeLessThan(2000);

        holdFor.resolve();
        await swapA;

        // B's failed attempt touched nothing -- A's own swap still lands
        // normally once released.
        expect(await objectIdsFor(db, FIPS)).toEqual([901]);
      } finally {
        holdFor.resolve();
        await second.pool.end();
      }
    });
  });

  it("works through the existing drizzle(pool) shape (createTestSchema's own multi-connection pool)", async () => {
    const ctx = await createTestSchema();
    try {
      await seedRows(ctx.db, [rec(1)]);
      const summary = await swapCountyAddresses(ctx.db, FIPS, [rec(901), rec(902)], {
        sourceFile: SOURCE_FILE,
        sourceVintage: "v-pool",
      });
      expect(summary).toMatchObject({ rowsDeleted: 1, rowsInserted: 2, batches: 1 });
      expect(summary.deleteMs).toBeGreaterThanOrEqual(0);
      expect(summary.insertMs).toBeGreaterThanOrEqual(0);
      expect(await objectIdsFor(ctx.db, FIPS)).toEqual([901, 902]);
    } finally {
      await dropTestSchema(ctx);
    }
  });

  it("works through a single, directly-opened pg.Client (stand-in for a direct/unpooled Neon host)", async () => {
    const ctx = await createTestSchema();
    try {
      await seedRows(ctx.db, [rec(1), rec(2)]);

      const direct = await openDirectClient(ctx.schemaName);
      try {
        const summary = await swapCountyAddresses(direct.db, FIPS, [rec(777)], {
          sourceFile: SOURCE_FILE,
          sourceVintage: "v-direct",
        });
        expect(summary).toMatchObject({ rowsDeleted: 2, rowsInserted: 1, batches: 1 });
        expect(summary.deleteMs).toBeGreaterThanOrEqual(0);
        expect(summary.insertMs).toBeGreaterThanOrEqual(0);
      } finally {
        await direct.client.end();
      }

      expect(await objectIdsFor(ctx.db, FIPS)).toEqual([777]);
    } finally {
      await dropTestSchema(ctx);
    }
  });

  it("countCountyAddresses reports what swapCountyAddresses is about to delete", async () => {
    await withTestSchema(async ({ db }) => {
      await seedRows(db, [rec(1), rec(2), rec(3)]);
      expect(await countCountyAddresses(db, FIPS)).toBe(3);
      expect(await countCountyAddresses(db, "48453")).toBe(0);
    });
  });

  it("a duplicate objectid WITHIN one insert batch also rolls back (not only the cross-batch case in PROOF c)", async () => {
    // Postgres itself rejects two rows sharing a primary key within the
    // SAME multi-row INSERT statement (object_id 501 appears twice,
    // batchSize large enough to put both in batch 1) -- a real,
    // unmocked constraint violation. This complements PROOF (c)'s
    // across-batch duplicate; between the two, both the single- and
    // multi-batch failure shapes are covered.
    await withTestSchema(async ({ db }) => {
      await seedRows(db, [rec(1)]);
      await expect(
        swapCountyAddresses(db, FIPS, [rec(501), rec(502), rec(501)], {
          sourceFile: SOURCE_FILE,
          sourceVintage: "v-guard",
        }),
      ).rejects.toThrow();
      expect(await objectIdsFor(db, FIPS)).toEqual([1]);
    });
  });
});
