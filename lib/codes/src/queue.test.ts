/**
 * Integration tests for queue mechanics.
 *
 * The "queue worker" (queue.ts) is just a setInterval poller; the real lease,
 * complete, and fail logic lives inside `drainQueue()` + `markFailed()` +
 * `reapStaleLeases()` in orchestrator.ts. These tests drive that surface
 * directly with a controllable adapter and a real Postgres test schema.
 *
 * Strategy:
 *   - Mock @workspace/db so its `db` export resolves to the per-test
 *     drizzle instance bound to a freshly-created `test_<ts>_<rand>` schema.
 *     The Drizzle table objects (codeAtomFetchQueue, etc.) come through from
 *     the real module so identifier resolution still uses the real schema
 *     definitions; search_path on the test pool sends them to the test schema.
 *   - Mock @workspace/codes-sources/getSource to return a stub adapter whose
 *     fetchSection result is controlled per test.
 *   - Mock ./embeddings so we never need a network or API key.
 *   - Use `withTestSchema` per test (~300ms each — acceptable for ~6 tests).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  CodeSource,
  AtomCandidate,
  FetchContext,
} from "@workspace/codes-sources";
import type pg from "pg";

// Hoisted state shared between mocks and the test bodies.
const mocks = vi.hoisted(() => ({
  db: null as unknown,
  fetchSectionImpl: null as
    | null
    | ((url: string, ctx: FetchContext) => Promise<AtomCandidate[]>),
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!mocks.db) throw new Error("queue.test: mocks.db not initialized");
      return mocks.db;
    },
  };
});

vi.mock("@workspace/codes-sources", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes-sources")>(
      "@workspace/codes-sources",
    );
  const adapter: CodeSource = {
    id: "test_source",
    label: "Test Source",
    sourceType: "html",
    licenseType: "public_record",
    listToc: async () => [],
    fetchSection: async (url, ctx) => {
      if (!mocks.fetchSectionImpl)
        throw new Error("queue.test: fetchSectionImpl not set");
      return mocks.fetchSectionImpl(url, ctx);
    },
  };
  return {
    ...actual,
    getSource: () => adapter,
  };
});

vi.mock("./embeddings", () => ({
  embedTexts: async (texts: string[]) => ({
    vectors: texts.map(() => null),
    embeddedAny: false,
    skipReason: "no_api_key" as const,
  }),
  EMBEDDING_MODEL: "text-embedding-3-small",
  EMBEDDING_DIMENSIONS: 1536,
}));

// Imports that depend on the mocks above. Vitest hoists vi.mock so this is OK.
import { withTestSchema } from "@workspace/db/testing";
import { codeAtomFetchQueue, codeAtomSources } from "@workspace/db";
import { drainQueue, type OrchestratorLogger } from "./orchestrator";

const silentLogger: OrchestratorLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeEach(() => {
  mocks.db = null;
  mocks.fetchSectionImpl = null;
});

interface SeededSource {
  id: string;
}

async function seedSource(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  sourceName = "test_source",
): Promise<SeededSource> {
  const [row] = await db
    .insert(codeAtomSources)
    .values({
      sourceName,
      label: "Test Source",
      sourceType: "html",
      licenseType: "public_record",
    })
    .returning({ id: codeAtomSources.id });
  return { id: row.id };
}

function rawSetAttempts(
  pool: pg.Pool,
  rowId: string,
  attempts: number,
): Promise<unknown> {
  return pool.query(
    `UPDATE code_atom_fetch_queue SET attempts = $2 WHERE id = $1`,
    [rowId, attempts],
  );
}

describe("drainQueue: happy path", () => {
  it("claims a pending row, marks it completed, clears the lease, leaves attempts at 0", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => []; // no candidates → no atom writes
      const src = await seedSource(db);
      await db.insert(codeAtomFetchQueue).values({
        sourceId: src.id,
        jurisdictionKey: "j1",
        codeBook: "B1",
        edition: "E1",
        sectionUrl: "https://example.com/r1",
        nextAttemptAt: new Date(),
      });

      const result = await drainQueue(silentLogger, 5);
      expect(result.picked).toBe(1);
      expect(result.completed).toBe(1);
      expect(result.failed).toBe(0);

      const after = await pool.query<{
        status: string;
        attempts: number;
        lease_expires_at: Date | null;
        completed_at: Date | null;
        last_error: string | null;
      }>(
        `SELECT status, attempts, lease_expires_at, completed_at, last_error FROM code_atom_fetch_queue`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].status).toBe("completed");
      expect(after.rows[0].attempts).toBe(0);
      expect(after.rows[0].lease_expires_at).toBeNull();
      expect(after.rows[0].completed_at).toBeInstanceOf(Date);
      expect(after.rows[0].last_error).toBeNull();
    });
  });
});

describe("drainQueue: failure path + backoff", () => {
  it("on adapter throw: status=pending, attempts=1, lastError set, nextAttemptAt advanced ~60s", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => {
        throw new Error("boom from adapter");
      };
      const src = await seedSource(db);
      const before = Date.now();
      await db.insert(codeAtomFetchQueue).values({
        sourceId: src.id,
        jurisdictionKey: "j",
        codeBook: "B",
        edition: "E",
        sectionUrl: "https://example.com/x",
        nextAttemptAt: new Date(),
      });

      const result = await drainQueue(silentLogger, 5);
      expect(result.picked).toBe(1);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(1);

      const [r] = await db.select().from(codeAtomFetchQueue);
      expect(r.status).toBe("pending"); // still retryable
      expect(r.attempts).toBe(1);
      expect(r.lastError).toMatch(/boom from adapter/);
      expect(r.leaseExpiresAt).toBeNull();
      const delaySec = (r.nextAttemptAt!.getTime() - before) / 1000;
      // Ladder slot 0 = 60s. Allow generous slack for test execution.
      expect(delaySec).toBeGreaterThanOrEqual(55);
      expect(delaySec).toBeLessThanOrEqual(75);
      // Sanity: pool was used via the mock
      expect(pool).toBeDefined();
    });
  });

  it("after 5 attempts the row is parked as 'failed' (no further retries)", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => {
        throw new Error("perma-fail");
      };
      const src = await seedSource(db);
      const [row] = await db
        .insert(codeAtomFetchQueue)
        .values({
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/perma",
          nextAttemptAt: new Date(),
        })
        .returning({ id: codeAtomFetchQueue.id });
      // Pre-set attempts to 4 so this drain pass becomes attempt #5.
      await rawSetAttempts(pool, row.id, 4);

      await drainQueue(silentLogger, 5);

      const [after] = await db.select().from(codeAtomFetchQueue);
      expect(after.attempts).toBe(5);
      expect(after.status).toBe("failed");
    });
  });
});

describe("drainQueue: batch size cap", () => {
  it("picks at most batchSize rows in a single pass", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [];
      const src = await seedSource(db);
      const now = new Date();
      await db.insert(codeAtomFetchQueue).values(
        Array.from({ length: 10 }, (_, i) => ({
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: `https://example.com/${i}`,
          nextAttemptAt: now,
        })),
      );

      const result = await drainQueue(silentLogger, 3);
      expect(result.picked).toBe(3);

      const completed = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.status, "completed"));
      expect(completed).toHaveLength(3);
      const pending = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.status, "pending"));
      expect(pending).toHaveLength(7);
    });
  });
});

describe("drainQueue: jurisdiction filter", () => {
  it("when jurisdictionKey is supplied, only rows for that jurisdiction are claimed", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [];
      const src = await seedSource(db);
      const now = new Date();
      await db.insert(codeAtomFetchQueue).values([
        {
          sourceId: src.id,
          jurisdictionKey: "wanted",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/a",
          nextAttemptAt: now,
        },
        {
          sourceId: src.id,
          jurisdictionKey: "wanted",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/b",
          nextAttemptAt: now,
        },
        {
          sourceId: src.id,
          jurisdictionKey: "other",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/c",
          nextAttemptAt: now,
        },
      ]);

      const result = await drainQueue(silentLogger, 100, "wanted");
      expect(result.picked).toBe(2);

      const wantedDone = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.jurisdictionKey, "wanted"));
      const otherDone = await db
        .select()
        .from(codeAtomFetchQueue)
        .where(eq(codeAtomFetchQueue.jurisdictionKey, "other"));
      expect(wantedDone.every((r) => r.status === "completed")).toBe(true);
      expect(otherDone.every((r) => r.status === "pending")).toBe(true);
    });
  });
});

describe("drainQueue: nextAttemptAt gating", () => {
  it("rows whose next_attempt_at is in the future are not picked up", async () => {
    await withTestSchema(async ({ db }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [];
      const src = await seedSource(db);
      await db.insert(codeAtomFetchQueue).values({
        sourceId: src.id,
        jurisdictionKey: "j",
        codeBook: "B",
        edition: "E",
        sectionUrl: "https://example.com/z",
        nextAttemptAt: new Date(Date.now() + 60 * 60 * 1000), // +1h
      });

      const result = await drainQueue(silentLogger, 5);
      expect(result.picked).toBe(0);

      const [r] = await db.select().from(codeAtomFetchQueue);
      expect(r.status).toBe("pending");
      expect(r.attempts).toBe(0);
    });
  });
});

describe("drainQueue: lease reaper", () => {
  it("rescues in_progress rows whose lease has expired (re-claims and processes them)", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [];
      const src = await seedSource(db);
      // Manually insert a row in 'in_progress' with a lease in the past — simulates
      // a process that crashed mid-fetch.
      const [row] = await db
        .insert(codeAtomFetchQueue)
        .values({
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/stale",
          nextAttemptAt: new Date(),
        })
        .returning({ id: codeAtomFetchQueue.id });
      await pool.query(
        `UPDATE code_atom_fetch_queue
         SET status = 'in_progress',
             lease_expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [row.id],
      );

      const result = await drainQueue(silentLogger, 5);
      // The reaper requeued it back to pending, then drainQueue re-claimed
      // and completed it in the same pass.
      expect(result.picked).toBe(1);
      expect(result.completed).toBe(1);

      const [after] = await db.select().from(codeAtomFetchQueue);
      expect(after.status).toBe("completed");
      expect(after.leaseExpiresAt).toBeNull();
    });
  });

  it("leaves in_progress rows whose lease has NOT expired alone", async () => {
    await withTestSchema(async ({ db, pool }) => {
      mocks.db = db;
      mocks.fetchSectionImpl = async () => [];
      const src = await seedSource(db);
      const [row] = await db
        .insert(codeAtomFetchQueue)
        .values({
          sourceId: src.id,
          jurisdictionKey: "j",
          codeBook: "B",
          edition: "E",
          sectionUrl: "https://example.com/holding",
          nextAttemptAt: new Date(),
        })
        .returning({ id: codeAtomFetchQueue.id });
      // Lease expires in the future — another worker is "actively" processing it.
      await pool.query(
        `UPDATE code_atom_fetch_queue
         SET status = 'in_progress',
             lease_expires_at = now() + interval '5 minutes'
         WHERE id = $1`,
        [row.id],
      );

      const result = await drainQueue(silentLogger, 5);
      expect(result.picked).toBe(0);

      const [after] = await db.select().from(codeAtomFetchQueue);
      expect(after.status).toBe("in_progress");
      expect(after.leaseExpiresAt).toBeInstanceOf(Date);
    });
  });
});
