/**
 * Unit tests for `pruneOldBriefingGenerationJobs` — the helper the
 * periodic sweeper calls to trim terminal `briefing_generation_jobs`
 * rows.
 *
 * Boundary cases (kept vs deleted):
 *   - pending rows are NEVER deleted, even if older than the cutoff;
 *   - the most recent row per engagement is ALWAYS kept (audit story);
 *   - terminal rows older than the cutoff AND not the latest for their
 *     engagement ARE deleted;
 *   - terminal rows newer than the cutoff are kept regardless of
 *     whether a newer row exists.
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
const { pruneOldBriefingGenerationJobs } = await import(
  "../lib/briefingGenerationJobsSweep"
);

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

describe("pruneOldBriefingGenerationJobs", () => {
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

  it("returns 0 and deletes nothing when the table is empty", async () => {
    const deleted = await pruneOldBriefingGenerationJobs({
      db: schema.db,
      retentionMs: RETENTION_MS,
      now: NOW,
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
    // row stick around. The "newer row exists" arm of the WHERE
    // protects this.
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
    });
    // ancient + middleOld removed; latestOld is the most-recent and
    // therefore protected by the EXISTS predicate.
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
    });
    expect(deleted).toBe(0);
    expect(await liveJobIds(eng.id)).toEqual(
      [atCutoff.id, newer.id].sort(),
    );
  });

  it("scopes 'latest per engagement' correctly across multiple engagements", async () => {
    // A newer row in engagement A must NOT protect old rows in
    // engagement B. The EXISTS predicate is keyed on
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
    });
    expect(deleted).toBe(1);
    expect(await liveJobIds(engA.id)).toEqual([aLatest.id]);
    expect(await liveJobIds(engB.id)).toEqual([bSole.id]);
    void aOld;
  });
});

// The actual setInterval/setTimeout wiring is exercised by the
// production app — we don't fake-timer-test the start helper here
// because Vitest already keeps tests offline (no app.ts import) and
// the pure pruning logic above is what the kept-vs-deleted contract
// actually rides on.
