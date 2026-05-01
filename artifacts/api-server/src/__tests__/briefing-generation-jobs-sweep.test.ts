/**
 * Unit tests for `pruneOldBriefingGenerationJobs` — the helper the
 * periodic sweeper calls to trim terminal `briefing_generation_jobs`
 * rows.
 *
 * Boundary cases (kept vs deleted):
 *   - pending rows are NEVER deleted, even if older than the cutoff;
 *   - the most recent N rows per engagement are ALWAYS kept regardless
 *     of age (audit story — auditors need to compare the last few
 *     attempts when investigating a regression);
 *   - terminal rows older than the cutoff AND with at least N newer
 *     rows for the same engagement ARE deleted;
 *   - terminal rows newer than the cutoff are kept regardless of how
 *     many newer rows exist.
 *
 * The first block exercises the legacy "keep the latest only" mode by
 * passing `keepPerEngagement: 1`. The second block exercises the new
 * default N=5 behavior, including the (Nth-most-recent kept) vs
 * (N+1)th-most-recent deleted boundary that defines the per-engagement
 * cap.
 *
 * The test seeds rows directly via the per-file test schema's drizzle
 * client. The sweep helper accepts a `db` override so the DELETE
 * lands in the test schema instead of the dev DB.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  type TestSchemaContext,
} from "@workspace/db/testing";

// The sweep module imports `db` from `@workspace/db` at top level for
// its production default, but our tests pass an explicit `db` override
// so that import is never exercised here. We still need the table
// reference (`briefingGenerationJobs`) — the sql tag interpolates it
// to the unqualified table name, which the per-suite `search_path`
// resolves into the test schema.
const { briefingGenerationJobs, engagements } = await import(
  "@workspace/db"
);
const { eq } = await import("drizzle-orm");
const {
  pruneOldBriefingGenerationJobs,
  BRIEFING_GENERATION_JOBS_SWEEP_LOCK_NAMESPACE,
} = await import("../lib/briefingGenerationJobsSweep");

let schema: TestSchemaContext;

beforeAll(async () => {
  schema = await createTestSchema();
});

afterEach(async () => {
  await truncateAll(schema.pool, [
    "engagements",
    "parcel_briefings",
    "briefing_sources",
    "briefing_generation_jobs",
  ]);
});

afterAll(async () => {
  await dropTestSchema(schema);
});

async function seedEngagement(name: string) {
  const [eng] = await schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  return eng!;
}

interface SeedJobOpts {
  engagementId: string;
  state: "pending" | "completed" | "failed";
  startedAt: Date;
  completedAt?: Date | null;
}

async function seedJob(opts: SeedJobOpts) {
  const [row] = await schema.db
    .insert(briefingGenerationJobs)
    .values({
      engagementId: opts.engagementId,
      state: opts.state,
      startedAt: opts.startedAt,
      completedAt:
        opts.completedAt ??
        (opts.state === "pending" ? null : opts.startedAt),
    })
    .returning();
  return row!;
}

async function liveJobIds(engagementId: string): Promise<string[]> {
  const rows = await schema.db
    .select({ id: briefingGenerationJobs.id })
    .from(briefingGenerationJobs)
    .where(eq(briefingGenerationJobs.engagementId, engagementId));
  return rows.map((r) => r.id).sort();
}

// Pin "now" so the cutoff math is independent of wall-clock drift.
const NOW = new Date("2026-05-01T00:00:00.000Z");
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const cutoff = new Date(NOW.getTime() - RETENTION_MS); // 2026-04-01

// Convenience builders for "old vs young" timestamps relative to
// the cutoff. Old rows are eligible for the older-than-cutoff arm
// of the WHERE; young rows protect the "newer than cutoff" path.
const OLD = (offsetMs: number) =>
  new Date(cutoff.getTime() - offsetMs); // < cutoff
const YOUNG = (offsetMs: number) =>
  new Date(cutoff.getTime() + offsetMs); // > cutoff

describe("pruneOldBriefingGenerationJobs (keepPerEngagement: 1)", () => {
  // The original "keep only the latest row per engagement" contract
  // is still supported by passing keepPerEngagement: 1. Each test
  // below pins it explicitly so the boundary they exercise stays the
  // single-row case even though the production default is now 5.

  it("returns 0 and deletes nothing when the table is empty", async () => {
    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(0);
  });

  it("never deletes a pending row, even when it's old AND a newer row exists", async () => {
    // A pending row could only happen if the previous run never
    // settled (process crashed mid-run). The single-flight unique
    // index keeps at most one — but if it does exist, the sweep must
    // leave it alone because it's still load-bearing for the status
    // endpoint and the in-flight 409 path.
    const eng = await seedEngagement("Pending Always Kept");
    const oldPending = await seedJob({
      engagementId: eng.id,
      state: "pending",
      startedAt: OLD(10 * 24 * 60 * 60 * 1000),
    });
    const newerCompleted = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: YOUNG(1 * 24 * 60 * 60 * 1000),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(0);

    expect(await liveJobIds(eng.id)).toEqual(
      [oldPending.id, newerCompleted.id].sort(),
    );
  });

  it("keeps the most recent terminal row per engagement even if it's older than the cutoff", async () => {
    // The sole terminal row for an engagement is what GET
    // /briefing/status returns. Pruning it would surface as "no run
    // on record" to the UI — strictly worse than letting one ancient
    // row stick around. The "N newer rows exist" arm of the WHERE
    // protects this (with N=1, the latest row has 0 newer siblings
    // and is therefore safe).
    const eng = await seedEngagement("Sole Old Row Kept");
    const ancientCompleted = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(365 * 24 * 60 * 60 * 1000),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual([ancientCompleted.id]);
  });

  it("deletes terminal rows older than cutoff that are not the latest for their engagement", async () => {
    // The canonical "trim dead weight" case: many ancient terminal
    // rows for the same engagement, only the latest survives.
    const eng = await seedEngagement("Trim Old History");
    const ancient = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(90 * 24 * 60 * 60 * 1000),
    });
    const middleOld = await seedJob({
      engagementId: eng.id,
      state: "failed",
      startedAt: OLD(45 * 24 * 60 * 60 * 1000),
    });
    const latestOld = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(1 * 24 * 60 * 60 * 1000), // still older than cutoff
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    // ancient + middleOld removed; latestOld is the most-recent and
    // therefore protected by the per-engagement keep cap (N=1 keeps
    // the single latest row regardless of age).
    expect(deleted).toBe(2);
    expect(await liveJobIds(eng.id)).toEqual([latestOld.id]);
    // Belt-and-suspenders: confirm the specific ids that were
    // dropped, not just the count, so a future change to the WHERE
    // clause can't accidentally swap which row survives.
    void ancient;
    void middleOld;
  });

  it("keeps terminal rows that are newer than the cutoff regardless of age-vs-latest", async () => {
    // Cutoff arm: a terminal row inside the retention window is part
    // of the recent audit trail, so it stays even if a newer
    // terminal row also exists.
    const eng = await seedEngagement("Inside Retention Window");
    const youngFailed = await seedJob({
      engagementId: eng.id,
      state: "failed",
      startedAt: YOUNG(1 * 24 * 60 * 60 * 1000),
    });
    const youngerCompleted = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: YOUNG(2 * 24 * 60 * 60 * 1000),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual(
      [youngFailed.id, youngerCompleted.id].sort(),
    );
  });

  it("does not delete a row exactly at the cutoff (strict-less-than boundary)", async () => {
    // Boundary case: `started_at < cutoff` — equality is NOT a match,
    // so a row whose timestamp is exactly the cutoff stays even if a
    // newer row exists. This pins the boundary so a future swap to
    // `<=` is caught.
    const eng = await seedEngagement("Cutoff Boundary");
    const atCutoff = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: cutoff,
    });
    const newer = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: YOUNG(1000),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual(
      [atCutoff.id, newer.id].sort(),
    );
  });

  it("scopes 'latest per engagement' correctly across multiple engagements", async () => {
    // A newer row in engagement A must NOT protect old rows in
    // engagement B. The newer-rows COUNT is keyed on
    // `engagement_id`, so a cross-engagement leak would surface as
    // engagement-B history sticking around forever.
    const engA = await seedEngagement("Engagement A");
    const engB = await seedEngagement("Engagement B");

    const aOld = await seedJob({
      engagementId: engA.id,
      state: "completed",
      startedAt: OLD(60 * 24 * 60 * 60 * 1000),
    });
    const aLatest = await seedJob({
      engagementId: engA.id,
      state: "completed",
      startedAt: OLD(1 * 24 * 60 * 60 * 1000),
    });
    // Engagement B has only one ancient row — even though A has a
    // newer row in absolute time, that does NOT count for B.
    const bSole = await seedJob({
      engagementId: engB.id,
      state: "completed",
      startedAt: OLD(120 * 24 * 60 * 60 * 1000),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 1,
    });
    expect(deleted).toBe(1);
    expect(await liveJobIds(engA.id)).toEqual([aLatest.id]);
    expect(await liveJobIds(engB.id)).toEqual([bSole.id]);
    void aOld;
  });
});

describe("pruneOldBriefingGenerationJobs (keepPerEngagement: 5, default)", () => {
  // The production sweep keeps the most recent 5 rows per engagement
  // so auditors comparing a regression can look at "the run before the
  // bad one" without it having been reaped. These tests pin the
  // Nth-vs-(N+1)th boundary that defines that cap.

  it("keeps the 5 most recent terminal rows per engagement when 5 or fewer rows exist (all old)", async () => {
    // Even though every row is older than the cutoff and terminal,
    // none should be deleted because none has 5 newer siblings.
    const eng = await seedEngagement("Five Or Fewer All Kept");
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    // Seed 5 ancient terminal rows, each progressively newer.
    const rows = [];
    for (let i = 5; i >= 1; i--) {
      rows.push(
        await seedJob({
          engagementId: eng.id,
          state: "completed",
          startedAt: OLD(days(i)),
        }),
      );
    }

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      // Default — but pinned for clarity at the boundary.
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual(rows.map((r) => r.id).sort());
  });

  it("keeps the 5th-most-recent and deletes the 6th-most-recent (Nth vs (N+1)th boundary)", async () => {
    // The headline boundary the task asks for. Six ancient terminal
    // rows for the same engagement: the most recent 5 stay, the 6th
    // (oldest) is reaped. A future regression that swaps `>= N` for
    // `> N` (off-by-one) or `> N - 1` would be caught here.
    const eng = await seedEngagement("Sixth Reaped Fifth Kept");
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    // i=6 is oldest, i=1 is newest. All older than the cutoff so the
    // age arm of the WHERE matches; the keep cap is the only thing
    // protecting the kept rows.
    const seeded = [];
    for (let i = 6; i >= 1; i--) {
      seeded.push(
        await seedJob({
          engagementId: eng.id,
          state: "completed",
          startedAt: OLD(days(i)),
        }),
      );
    }
    const oldest = seeded[0]!; // i=6
    const keptFifth = seeded[1]!; // i=5 — the Nth-most-recent
    const keptRest = seeded.slice(2); // i=4..1 — the 4 newest

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(1);
    const survivors = await liveJobIds(eng.id);
    expect(survivors).toEqual(
      [keptFifth.id, ...keptRest.map((r) => r.id)].sort(),
    );
    // Belt-and-suspenders: the specific row dropped is the oldest.
    expect(survivors).not.toContain(oldest.id);
  });

  it("counts a pending row toward the keep cap (so it shields one fewer terminal row)", async () => {
    // A pending row is the auditor's "currently in flight" attempt
    // and it counts as one of the most-recent N. Concretely: with a
    // pending row + 5 older terminal rows, the pending row + 4
    // youngest terminal rows survive, and the 5th-oldest terminal
    // row is reaped (it has 5 newer siblings: the 4 newer terminals
    // plus the pending).
    const eng = await seedEngagement("Pending Counts Toward Cap");
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    const oldest = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(days(10)),
    });
    const t4 = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(days(8)),
    });
    const t3 = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(days(6)),
    });
    const t2 = await seedJob({
      engagementId: eng.id,
      state: "failed",
      startedAt: OLD(days(4)),
    });
    const t1 = await seedJob({
      engagementId: eng.id,
      state: "completed",
      startedAt: OLD(days(2)),
    });
    // Pending row is the newest of all — it occupies one of the 5
    // slots, pushing `oldest` out.
    const pending = await seedJob({
      engagementId: eng.id,
      state: "pending",
      startedAt: OLD(days(1)),
    });

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(1);
    expect(await liveJobIds(eng.id)).toEqual(
      [pending.id, t1.id, t2.id, t3.id, t4.id].sort(),
    );
    // The reaped row is the oldest terminal, not the pending row.
    expect(await liveJobIds(eng.id)).not.toContain(oldest.id);
  });

  it("scopes the per-engagement cap correctly across multiple engagements", async () => {
    // Engagement A has 7 ancient terminals (cap of 5 → 2 reaped),
    // engagement B has 3 ancient terminals (under the cap → none
    // reaped). A cross-engagement leak in the COUNT subquery would
    // either spuriously protect A's 6th/7th rows or spuriously reap
    // B's history.
    const engA = await seedEngagement("Multi-Eng A");
    const engB = await seedEngagement("Multi-Eng B");
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    const aRows = [];
    for (let i = 7; i >= 1; i--) {
      aRows.push(
        await seedJob({
          engagementId: engA.id,
          state: "completed",
          startedAt: OLD(days(i)),
        }),
      );
    }
    const bRows = [];
    for (let i = 3; i >= 1; i--) {
      bRows.push(
        await seedJob({
          engagementId: engB.id,
          state: "completed",
          startedAt: OLD(days(i + 20)), // even older than A's, to be sure
        }),
      );
    }

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(2); // 7 - 5 = 2 reaped from A; 0 from B
    // A keeps its 5 newest (i=5..1, indices 2..6 in seed order).
    expect(await liveJobIds(engA.id)).toEqual(
      aRows.slice(2).map((r) => r.id).sort(),
    );
    // B keeps every row.
    expect(await liveJobIds(engB.id)).toEqual(
      bRows.map((r) => r.id).sort(),
    );
  });

  it("never deletes a row inside the retention window even if it's beyond the keep cap", async () => {
    // The two trim arms are AND-ed together: a row must be BOTH
    // older than the cutoff AND beyond the keep cap. So 6 young
    // terminal rows all stay, even though one of them is the 6th
    // most recent and would be reaped if it were old.
    const eng = await seedEngagement("Young Beyond Cap Still Kept");
    const minutes = (n: number) => n * 60 * 1000;
    const rows = [];
    for (let i = 6; i >= 1; i--) {
      rows.push(
        await seedJob({
          engagementId: eng.id,
          state: "completed",
          startedAt: YOUNG(minutes(i)),
        }),
      );
    }

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual(rows.map((r) => r.id).sort());
  });

  it("breaks ties on identical started_at deterministically using id (still keeps exactly N)", async () => {
    // If two rows share the same `started_at`, the keep cap must
    // still admit exactly N survivors. Without a tiebreaker, both
    // tied rows would each see "no newer sibling" and the cap would
    // silently let an extra row through. Six rows seeded at the SAME
    // ancient timestamp — exactly 1 must be reaped (cap of 5).
    const eng = await seedEngagement("Tie Breaker Boundary");
    const tied = OLD(60 * 24 * 60 * 60 * 1000); // single shared timestamp
    const rows = [];
    for (let i = 0; i < 6; i++) {
      rows.push(
        await seedJob({
          engagementId: eng.id,
          state: "completed",
          startedAt: tied,
        }),
      );
    }

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(deleted).toBe(1);
    expect((await liveJobIds(eng.id)).length).toBe(5);
    // The deterministic tiebreaker is `id ASC`, so the row with the
    // smallest UUID is the one that gets reaped (it has 5 newer
    // siblings under the (started_at, id) comparator). Compute the
    // expected survivor set the same way the SQL does.
    const sortedIds = rows.map((r) => r.id).sort();
    expect(await liveJobIds(eng.id)).toEqual(sortedIds.slice(1));
  });

  it("falls back to the default keep cap when keepPerEngagement is 0 or negative", async () => {
    // Defensive clamp: a misconfigured env var (`KEEP=0`) must not
    // be allowed to delete the latest row per engagement. The helper
    // falls through to the default of 5 in that case.
    const eng = await seedEngagement("Defensive Clamp");
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    // 6 ancient terminal rows. With cap=5 (the default), one is
    // reaped; with cap=0 (no clamp), all six would be reaped.
    const rows = [];
    for (let i = 6; i >= 1; i--) {
      rows.push(
        await seedJob({
          engagementId: eng.id,
          state: "completed",
          startedAt: OLD(days(i)),
        }),
      );
    }

    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 0,
    });
    // Default of 5 applied → 6 - 5 = 1 reaped.
    expect(deleted).toBe(1);
    expect((await liveJobIds(eng.id)).length).toBe(5);
  });
});

describe("pruneOldBriefingGenerationJobs (multi-instance safety, Task #238)", () => {
  // The sweep runs as a node-local setInterval inside every api-server
  // process, so once we run more than one instance every instance
  // would independently scan the table and contend on row locks for
  // the same DELETE every 24h. The helper now wraps its DELETE in a
  // transaction that first tries `pg_try_advisory_xact_lock` on a
  // cluster-wide key; the loser short-circuits to 0 without scanning.
  //
  // These tests pin both the "peer holds the lock" short-circuit and
  // the "two ticks race in parallel" invariant that the table is
  // pruned exactly once per tick across all contenders.

  async function seedAncientHistoryFor(name: string) {
    // Helper for the concurrency tests: an engagement with 6 ancient
    // terminal rows. With the production cap of 5, a single sweep
    // tick should reap exactly one row (the oldest). The reap count
    // is what we use as the "did this tick do the work?" signal.
    const eng = await seedEngagement(name);
    const days = (n: number) => n * 24 * 60 * 60 * 1000;
    for (let i = 6; i >= 1; i--) {
      await seedJob({
        engagementId: eng.id,
        state: "completed",
        startedAt: OLD(days(i)),
      });
    }
    return eng;
  }

  it("returns 0 and deletes nothing when a peer instance holds the sweep advisory lock", async () => {
    // Simulates two api-server instances ticking simultaneously: a
    // peer holds the cluster-wide sweep lock on its own connection
    // (session-scoped), so this instance's tick must short-circuit
    // and delete nothing. We then release the peer lock and re-run
    // the sweep to prove the helper isn't permanently wedged — the
    // rows are pruned exactly once total, never zero times after
    // contention clears.
    const eng = await seedAncientHistoryFor("Peer Holds Lock");

    // Borrow a dedicated client from the test schema's pool and
    // acquire a SESSION-scoped lock on the same key the production
    // sweeper uses. Session and xact advisory locks share one
    // keyspace, so this blocks the helper's pg_try_advisory_xact_lock
    // from acquiring. `current_schema()` resolves to the per-suite
    // test schema (set via the pool's search_path), so this peer
    // lock only contends with sweeps inside this suite.
    const peer = await schema.pool.connect();
    try {
      await peer.query(
        `SELECT pg_advisory_lock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [BRIEFING_GENERATION_JOBS_SWEEP_LOCK_NAMESPACE],
      );

      const skipped = await pruneOldBriefingGenerationJobs({
        db: schema.db,
        retentionMs: RETENTION_MS,
        now: NOW,
        keepPerEngagement: 5,
      });
      expect(skipped).toBe(0);
      // All 6 rows are still there — the peer's lock kept the helper
      // from scanning or DELETE-ing anything.
      expect((await liveJobIds(eng.id)).length).toBe(6);

      // Release the peer's lock and re-run: this tick should now do
      // the work the first one would have done.
      await peer.query(
        `SELECT pg_advisory_unlock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [BRIEFING_GENERATION_JOBS_SWEEP_LOCK_NAMESPACE],
      );
    } finally {
      peer.release();
    }

    const swept = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    // Cap is 5 → 1 ancient row reaped, 5 survive.
    expect(swept).toBe(1);
    expect((await liveJobIds(eng.id)).length).toBe(5);
  });

  it("two concurrent ticks plus a follow-up sweep prune the table exactly once", async () => {
    // Fires two pruneOldBriefingGenerationJobs() calls in parallel
    // while a peer connection is holding the cluster-wide advisory
    // lock, then releases the peer lock and runs a follow-up tick.
    // Each tick runs in its own transaction on its own pool
    // connection and tries to acquire the same advisory lock with
    // `pg_try_advisory_xact_lock` — non-blocking, so a contender
    // either sees the lock free and reaps, or sees it taken and
    // returns 0 without ever entering a wait state we could observe.
    //
    // We can't pin both contenders behind the peer lock for their
    // entire lifetime (there is no "waiting on the lock" state to
    // sync against under non-blocking try-acquire), so the invariant
    // we assert is the strong one a multi-instance deploy depends on:
    // across the two contenders AND a follow-up cleanup tick, the
    // table is pruned exactly once — never zero times (sweep is not
    // permanently wedged) and never twice (the cluster lock prevents
    // double-delete even if a tick wakes up after the peer releases
    // but before its sibling resolves).
    const eng = await seedAncientHistoryFor("Concurrent Ticks");

    const peer = await schema.pool.connect();
    let firstResult: number;
    let secondResult: number;
    try {
      await peer.query(
        `SELECT pg_advisory_lock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [BRIEFING_GENERATION_JOBS_SWEEP_LOCK_NAMESPACE],
      );
      const ticks = Promise.all([
        pruneOldBriefingGenerationJobs({
          db: schema.db,
          retentionMs: RETENTION_MS,
          now: NOW,
          keepPerEngagement: 5,
        }),
        pruneOldBriefingGenerationJobs({
          db: schema.db,
          retentionMs: RETENTION_MS,
          now: NOW,
          keepPerEngagement: 5,
        }),
      ]);
      // Give both ticks a moment to BEGIN and try the lock while it
      // is taken by `peer`. Even under load where a tick wakes up
      // after the unlock, the sum-of-reaps invariant below still
      // holds because the SUT lock serializes the actual DELETE.
      await new Promise((r) => setTimeout(r, 50));
      await peer.query(
        `SELECT pg_advisory_unlock(
           hashtextextended($1 || '|' || current_schema(), 0)
         )`,
        [BRIEFING_GENERATION_JOBS_SWEEP_LOCK_NAMESPACE],
      );
      [firstResult, secondResult] = await ticks;
    } finally {
      peer.release();
    }

    // No double-delete: across the two contenders at most one reap
    // happened (either both short-circuited on the peer lock, or one
    // slipped through after the unlock and reaped a single row).
    // Their product is 0 because at most one acquired the SUT lock.
    expect(firstResult + secondResult).toBeLessThanOrEqual(1);
    expect(firstResult * secondResult).toBe(0);

    // A follow-up tick guarantees any deferred cleanup runs, proving
    // the worker isn't permanently wedged. Across all three calls
    // exactly one prune happened — the table ends at the keep cap.
    const cleanup = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
      keepPerEngagement: 5,
    });
    expect(firstResult + secondResult + cleanup).toBe(1);
    expect((await liveJobIds(eng.id)).length).toBe(5);
  });

  it("racing ticks elect exactly one winner — sum of reap counts equals one tick's work, never twice", async () => {
    // Natural-race variant: no pre-held peer lock. Both ticks fire
    // simultaneously and contend on the cluster-wide advisory lock
    // directly. The invariant we assert is the strong one a multi-
    // instance deploy depends on — across the two contenders the
    // table is pruned exactly once, never zero times and never twice.
    //
    // Concretely with 6 ancient terminal rows and cap=5, one caller
    // returns 1 (it acquired the lock and did the DELETE) and the
    // other returns 0 (it either lost the lock race, OR it acquired
    // cleanly after the winner finished but found nothing left to
    // reap). Either way: sum is 1 and product is 0.
    const eng = await seedAncientHistoryFor("Racing Ticks");

    const [a, b] = await Promise.all([
      pruneOldBriefingGenerationJobs({
        db: schema.db,
        retentionMs: RETENTION_MS,
        now: NOW,
        keepPerEngagement: 5,
      }),
      pruneOldBriefingGenerationJobs({
        db: schema.db,
        retentionMs: RETENTION_MS,
        now: NOW,
        keepPerEngagement: 5,
      }),
    ]);
    expect(a + b).toBe(1);
    expect(a * b).toBe(0);
    expect((await liveJobIds(eng.id)).length).toBe(5);
  });
});

// The actual setInterval/setTimeout wiring is exercised by the
// production app — we don't fake-timer-test the start helper here
// because Vitest already keeps tests offline (no app.ts import) and
// the pure pruning logic above is what the kept-vs-deleted contract
// actually rides on.
