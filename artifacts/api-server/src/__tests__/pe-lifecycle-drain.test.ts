/**
 * P-492 drain falsifiers on a REAL Postgres (plan section 6):
 *   - scheduled retry: one failed row, no new event; a drain tick sends it;
 *   - no double send: two drains on two separate connection pools (two App
 *     Platform instances) run at once and every row is sent exactly once;
 *   - the quiet and Claude-connected scans enqueue once per transition;
 *   - every tick records itself in ss_lifecycle_drain_run.
 *
 * The schema is built by applying the real migrations 0105 then 0109 to a
 * private schema, with a pre-P-492 row in place before 0109 runs, so this
 * also proves the migration and its hard-cut backfill on Postgres. Only the
 * tables those migrations touch are created (a minimal `users`, and
 * `pe_ai_connections` from 0090).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@workspace/db/schema";
import type { db as ProdDb } from "@workspace/db";
import { runLifecycleDrainTick } from "../lib/peLifecycleDrain";
import { sql } from "drizzle-orm";
import {
  drizzleOutboxStore,
  projectOutboxRowToContact,
  type CountReader,
} from "../lib/peLifecycleOutbox.drizzle";
import { enqueueLifecycleEvent, type LegDeps } from "../lib/peLifecycleOutbox";

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, "..", "..", "..", "..", "lib", "db", "drizzle");
const migration = (name: string) => readFileSync(join(drizzleDir, name), "utf8");

const DATABASE_URL = process.env["DATABASE_URL"];
const SCHEMA = `p492_drain_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

type Db = typeof ProdDb;
let admin: pg.Pool;
let poolA: pg.Pool;
let poolB: pg.Pool;
let dbA: Db;
let dbB: Db;

function poolFor(): pg.Pool {
  const url = new URL(DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${SCHEMA},public`);
  return new pg.Pool({ connectionString: url.toString(), max: 4 });
}

const T0 = new Date("2026-10-03T12:00:00Z");

beforeAll(async () => {
  admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${SCHEMA}`);
  poolA = poolFor();
  poolB = poolFor();
  const c = await poolA.connect();
  try {
    await c.query(`
      CREATE TABLE users (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        email text
      );
    `);
    await c.query(migration("0090_pe_ai_connections.sql"));
    // Stand-ins for pe_saved_properties / pe_share_grants: the projection
    // reads counts from the source tables, injected here as countsReader.
    await c.query(`CREATE TABLE p492_saves (owner text NOT NULL); CREATE TABLE p492_shares (grantor text NOT NULL);`);
    await c.query(migration("0105_p413_lifecycle_outbox.sql"));
    // A pre-P-492 row: Meta sent under P-413, never seen by Resend.
    await c.query(`INSERT INTO users (id, display_name, email) VALUES ('legacy', 'Legacy', 'legacy@example.com')`);
    await c.query(`
      INSERT INTO pe_lifecycle_outbox (id, owner_user_id, event_type, idempotency_key, email, status, attempts)
      VALUES ('legacy-row', 'legacy', 'e2_lot_saved', 'e2:legacy:1', 'legacy@example.com', 'sent', 1),
             ('legacy-pending', 'legacy', 'e2_lot_saved', 'e2:legacy:2', 'legacy@example.com', 'failed', 3)
    `);
    await c.query(migration("0109_p492_ss_contact_lifecycle_legs.sql"));
  } finally {
    c.release();
  }
  dbA = drizzle(poolA, { schema }) as unknown as Db;
  dbB = drizzle(poolB, { schema }) as unknown as Db;
});

afterAll(async () => {
  await poolA?.end();
  await poolB?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin?.end();
});

beforeEach(async () => {
  await poolA.query(
    `TRUNCATE ss_lifecycle_drain_run, pe_ai_connections, ss_contact, p492_saves, p492_shares RESTART IDENTITY CASCADE;
     DELETE FROM pe_lifecycle_outbox WHERE id NOT IN ('legacy-row', 'legacy-pending');
     DELETE FROM users WHERE id <> 'legacy';`,
  );
});

async function seedUsers(n: number, prefix: string): Promise<string[]> {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  for (const id of ids) {
    await poolA.query(`INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`, [
      id,
      `User ${id}`,
      `${id}@example.com`,
    ]);
  }
  return ids;
}

async function enqueueE2For(ids: string[]): Promise<void> {
  const store = drizzleOutboxStore(dbA);
  for (const id of ids) {
    await enqueueLifecycleEvent(
      {
        userId: id,
        email: `${id}@example.com`,
        event: "e2_lot_saved",
        idempotencyKey: `e2:${id}:1`,
        apply: { email: `${id}@example.com`, event: "e2_lot_saved", savedLots: 1 },
      },
      store,
      T0,
    );
  }
}

const countsReader: CountReader = async (tx, userId) => {
  const r = await tx.execute(
    sql`SELECT (SELECT count(*) FROM p492_saves WHERE owner = ${userId})::int AS saved,
               (SELECT count(*) FROM p492_shares WHERE grantor = ${userId})::int AS shares`,
  );
  const row = r.rows[0] as { saved: number; shares: number };
  return { savedLots: row.saved, shares: row.shares };
};

/** Real local projection on the given db; Resend and Meta are counting fakes. */
function legsOn(db: Db, sends: Map<string, number>, opts: { resendOk?: () => boolean; delayMs?: number } = {}): LegDeps {
  return {
    now: () => T0,
    project: (row) => projectOutboxRowToContact(row, db, T0, countsReader),
    sendMeta: async () => ({ ok: false, error: "meta_capi_token_absent", refusedByName: true }),
    sendResend: async (row) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.resendOk && !opts.resendOk()) return { ok: false, error: "resend_down" };
      sends.set(row.id, (sends.get(row.id) ?? 0) + 1);
      return { ok: true };
    },
  };
}

describe("migration 0109 on Postgres", () => {
  it("pre-P-492 rows are hard-cut: local and resend skipped, Meta keeps its outcome", async () => {
    const { rows } = await poolA.query(
      `SELECT id, status, local_status, resend_status, meta_status, resend_error
         FROM pe_lifecycle_outbox WHERE id IN ('legacy-row', 'legacy-pending') ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: "legacy-pending", status: "failed", local_status: "skipped", resend_status: "skipped", meta_status: "pending", resend_error: "pre_p492_row" },
      { id: "legacy-row", status: "sent", local_status: "skipped", resend_status: "skipped", meta_status: "sent", resend_error: "pre_p492_row" },
    ]);
  });
});

describe("scheduled retry (falsifier: a failed row is retried with no new event)", () => {
  it("a failed Resend leg is sent by a later drain tick without any new enqueue", async () => {
    const [id] = await seedUsers(1, "retry");
    await enqueueE2For([id!]);
    const sends = new Map<string, number>();
    let up = false;
    const legs = legsOn(dbA, sends, { resendOk: () => up });

    const first = await runLifecycleDrainTick({ db: dbA, legs, runScans: false, now: () => T0 });
    expect(first.failed).toBeGreaterThanOrEqual(1);

    up = true;
    const later = new Date(T0.getTime() + 2 * 60 * 1000);
    const second = await runLifecycleDrainTick({ db: dbA, legs: { ...legs, now: () => later }, runScans: false, now: () => later });
    expect(second.sent).toBeGreaterThanOrEqual(1);
    const { rows } = await poolA.query(
      `SELECT status, resend_status, resend_attempts FROM pe_lifecycle_outbox WHERE owner_user_id = $1 AND event_type = 'e2_lot_saved'`,
      [id],
    );
    expect(rows[0]).toEqual({ status: "sent", resend_status: "sent", resend_attempts: 2 });

    const runs = await poolA.query(`SELECT count(*)::int AS n, count(finished_at)::int AS done FROM ss_lifecycle_drain_run`);
    expect(runs.rows[0]).toEqual({ n: 2, done: 2 });
  });
});

describe("no double send (falsifier: two drains at once send each row once)", () => {
  it("two drains on two pools, run concurrently, send every row exactly once", async () => {
    const ids = await seedUsers(20, "dbl");
    await enqueueE2For(ids);
    const sends = new Map<string, number>();
    const [a, b] = await Promise.all([
      runLifecycleDrainTick({ db: dbA, legs: legsOn(dbA, sends, { delayMs: 5 }), runScans: false, now: () => T0 }),
      runLifecycleDrainTick({ db: dbB, legs: legsOn(dbB, sends, { delayMs: 5 }), runScans: false, now: () => T0 }),
    ]);
    const { rows } = await poolA.query(
      `SELECT id FROM pe_lifecycle_outbox WHERE event_type = 'e2_lot_saved' AND owner_user_id LIKE 'dbl%'`,
    );
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(sends.get(r.id as string)).toBe(1);
    // Both instances took work (the split is not asserted, only that the
    // claims were disjoint): the total claimed equals the row count.
    expect(a.claimed + b.claimed).toBe(20);
    const left = await poolA.query(
      `SELECT count(*)::int AS n FROM pe_lifecycle_outbox WHERE owner_user_id LIKE 'dbl%' AND status <> 'sent'`,
    );
    expect(left.rows[0].n).toBe(0);
  });
});

describe("no double claim under real contention (the SKIP LOCKED falsifier)", () => {
  // The drain-level test above can pass without SKIP LOCKED, because one
  // drain's claim can take every row and commit before the other's starts
  // (measured 2026-10-03: that test stayed green on the broken variant).
  // This one forces the claims to overlap: eight claim statements at once,
  // four per pool, each asking for every row.
  it("eight simultaneous claims across two pools never return the same row twice", async () => {
    const ids = await seedUsers(40, "claim");
    await enqueueE2For(ids);
    const storeA = drizzleOutboxStore(dbA);
    const storeB = drizzleOutboxStore(dbB);
    for (let round = 0; round < 3; round += 1) {
      await poolA.query(`UPDATE pe_lifecycle_outbox SET claimed_until = NULL WHERE owner_user_id LIKE 'claim%'`);
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 === 0 ? storeA : storeB).claimDue({ now: T0, limit: 40, leaseMs: 60_000 }),
        ),
      );
      const all = claims.flat().map((r) => r.id);
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBe(40);
    }
  });
});

describe("scans", () => {
  it("went_quiet is enqueued once per transition for a contact 14+ days past last active", async () => {
    const [id] = await seedUsers(1, "quiet");
    await poolA.query(
      `INSERT INTO ss_contact (user_id, email, last_active) VALUES ($1, $2, '2026-09-18')`,
      [id, `${id}@example.com`],
    );
    const sends = new Map<string, number>();
    const legs = legsOn(dbA, sends);
    const t1 = await runLifecycleDrainTick({ db: dbA, legs, runScans: true, now: () => T0 });
    expect(t1.quietEnqueued).toBe(1);
    const t2 = await runLifecycleDrainTick({ db: dbA, legs, runScans: true, now: () => T0 });
    expect(t2.quietEnqueued).toBe(0);
    const c = await poolA.query(`SELECT quiet FROM ss_contact WHERE user_id = $1`, [id]);
    expect(c.rows[0].quiet).toBe(true);
  });

  it("claude_connected is enqueued once for a Claude-named connection, never for another client", async () => {
    const [claude, other] = await seedUsers(2, "mcp");
    await poolA.query(
      `INSERT INTO pe_ai_connections (owner_user_id, client_name) VALUES ($1, 'Anthropic/ClaudeAI'), ($2, 'cursor')`,
      [claude, other],
    );
    const sends = new Map<string, number>();
    const legs = legsOn(dbA, sends);
    const t1 = await runLifecycleDrainTick({ db: dbA, legs, runScans: true, now: () => T0 });
    expect(t1.claudeEnqueued).toBe(1);
    const t2 = await runLifecycleDrainTick({ db: dbA, legs, runScans: true, now: () => T0 });
    expect(t2.claudeEnqueued).toBe(0);
    const c = await poolA.query(`SELECT user_id, claude_connected FROM ss_contact ORDER BY user_id`);
    expect(c.rows).toEqual([{ user_id: claude, claude_connected: true }]);
  });
});

describe("derived events on a real table", () => {
  it("the first share derives exactly one became_sharer row, in the projection's transaction", async () => {
    const [id] = await seedUsers(1, "share");
    await poolA.query(`INSERT INTO p492_shares (grantor) VALUES ($1), ($1)`, [id]);
    const store = drizzleOutboxStore(dbA);
    for (const n of [1, 2]) {
      await enqueueLifecycleEvent(
        {
          userId: id!,
          email: `${id}@example.com`,
          event: "e3_share_sent",
          idempotencyKey: `e3:grant-${n}`,
          apply: { email: `${id}@example.com`, event: "e3_share_sent", shares: n },
        },
        store,
        T0,
      );
    }
    const sends = new Map<string, number>();
    await runLifecycleDrainTick({ db: dbA, legs: legsOn(dbA, sends), runScans: false, now: () => T0 });
    await runLifecycleDrainTick({ db: dbA, legs: legsOn(dbA, sends), runScans: false, now: () => T0 });
    const { rows } = await poolA.query(
      `SELECT event_type, status FROM pe_lifecycle_outbox WHERE owner_user_id = $1 ORDER BY event_type`,
      [id],
    );
    expect(rows.filter((r) => r.event_type === "became_sharer")).toHaveLength(1);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    const c = await poolA.query(`SELECT stage, shares FROM ss_contact WHERE user_id = $1`, [id]);
    expect(c.rows[0]).toEqual({ stage: "Sharer", shares: 2 });
  });
  it("out-of-order projection cannot regress a count: the newer row projected first still ends on the true count", async () => {
    const [id] = await seedUsers(1, "order");
    await poolA.query(`INSERT INTO p492_saves (owner) VALUES ($1), ($1), ($1)`, [id]);
    const store = drizzleOutboxStore(dbA);
    // The row carrying savedLots 3 is due FIRST; the stale savedLots 1 row after it.
    for (const [n, at] of [[3, T0], [1, new Date(T0.getTime() + 1000)]] as const) {
      await enqueueLifecycleEvent(
        {
          userId: id!,
          email: `${id}@example.com`,
          event: "e2_lot_saved",
          idempotencyKey: `e2:${id}:${n}`,
          apply: { email: `${id}@example.com`, event: "e2_lot_saved", savedLots: n },
        },
        store,
        at,
      );
    }
    const later = () => new Date(T0.getTime() + 5000);
    const sends = new Map<string, number>();
    await runLifecycleDrainTick({ db: dbA, legs: { ...legsOn(dbA, sends), now: later }, runScans: false, now: later });
    const c = await poolA.query(`SELECT saved_lots FROM ss_contact WHERE user_id = $1`, [id]);
    expect(c.rows[0]).toEqual({ saved_lots: 3 });
  });
});
