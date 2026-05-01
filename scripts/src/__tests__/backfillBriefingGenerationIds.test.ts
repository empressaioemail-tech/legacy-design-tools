/**
 * Tests for the `parcel_briefings.generation_id` backfill — Task #303 B.7.
 *
 * Why this exists
 * ---------------
 * The backfill is a one-shot post-merge step (Task #281) that walks every
 * parcel_briefing whose `generation_id` column is still NULL and tries to
 * map it back to the most-recent `briefing_generation_jobs` row whose
 * `[started_at, completed_at]` window contains the briefing's
 * `generated_at`. We need automated coverage for two safety properties
 * before we can confidently re-run it on production:
 *
 *   1. Idempotency. Running the backfill a second time over an already-
 *      backfilled DB MUST be a no-op — `matched=0`, no rows touched. The
 *      script is wired into post-merge, so any operator merging into main
 *      effectively re-runs it; if it weren't idempotent the column would
 *      thrash on every deploy.
 *
 *   2. Dry-run is non-destructive. `--dry-run` MUST report the same
 *      "would match" tally as a real run but MUST NOT mutate the
 *      database. Operators rely on it to preview a backfill before
 *      committing.
 *
 * We additionally pin the heuristic itself with a couple of fixture-led
 * cases so a refactor that, say, drops the `state = 'completed'` guard
 * or the interval-containment check fails loudly in CI:
 *
 *   - A briefing whose producing job was pruned before the backfill
 *     ran stays NULL (and is reported as `unmatched`).
 *   - A briefing whose `generated_at` lies outside the candidate job's
 *     [started_at, completed_at] window is NOT matched to that job —
 *     the heuristic deliberately refuses ambiguous joins rather than
 *     guessing.
 *
 * Strategy
 * --------
 * We use `withTestSchema` from `@workspace/db/testing` so each test gets
 * a fresh empty schema with the production DDL replayed. We then seed
 * `engagements`, `briefing_generation_jobs`, and `parcel_briefings`
 * directly via raw SQL (rather than building a Drizzle client) — the
 * backfill operates on raw SQL, so the test exercises the same code
 * path that runs in production without dragging the full Drizzle
 * relations graph through the test.
 */

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";
import { backfill, parseArgs } from "../backfillBriefingGenerationIds";

/**
 * Wrap the test schema's `Pool` in a Drizzle client narrowed to the
 * `.execute()` shape the backfill expects. We can't use
 * `ctx.db` directly because the testing helper's `db` is typed against
 * the production schema relations object, not the bare pool the script
 * targets — but `drizzle(pool)` from a node-postgres pool exposes the
 * same `.execute(sql\`…\`)` surface and is shape-compatible at runtime
 * with the `BackfillDb` interface in the script.
 *
 * The cast through `unknown` is intentional: Drizzle's `execute()`
 * returns `QueryResult<Record<string, unknown>>` and the script's
 * `BackfillDb` interface declares the same `.rows` array under a
 * generic `T`. They are runtime-compatible (same node-postgres pool,
 * same `.rows` shape) but TS can't reconcile the variance because
 * the script's helper is private to the script. Casting here keeps
 * the script's surface narrow without exporting an internal helper
 * just to satisfy a test-only type relationship.
 */
function makeDb(ctx: TestSchemaContext): Parameters<typeof backfill>[1] {
  return drizzle(ctx.pool) as unknown as Parameters<typeof backfill>[1];
}

/**
 * Seed one engagement, one briefing-generation job, and the parcel
 * briefing whose `generated_at` falls inside the job's window. Returns
 * the seeded ids so individual tests can assert against them.
 */
async function seedHappyPath(ctx: TestSchemaContext): Promise<{
  engagementId: string;
  jobId: string;
  briefingId: string;
}> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('Test Engagement', 'test engagement', 'Moab, UT', '1 Test Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0].id;

  // Briefing must exist before the job because the heuristic joins
  // on `briefing_generation_jobs.briefing_id = parcel_briefings.id`,
  // which the kickoff route stamps on the job row inside the same
  // transaction it creates the briefing in.
  const briefing = await ctx.pool.query<{ id: string }>(
    `INSERT INTO parcel_briefings
       (engagement_id, section_a, generated_at, generated_by)
       VALUES ($1, 'body', NOW() - interval '7 seconds',
               'system:briefing-engine')
       RETURNING id`,
    [engagementId],
  );
  const briefingId = briefing.rows[0].id;

  // Job ran from t-10s to t-5s, so a briefing generated_at t-7s is
  // inside the window and should be matched.
  const job = await ctx.pool.query<{ id: string }>(
    `INSERT INTO briefing_generation_jobs
       (engagement_id, briefing_id, state, started_at, completed_at)
       VALUES ($1, $2, 'completed', NOW() - interval '10 seconds',
               NOW() - interval '5 seconds')
       RETURNING id`,
    [engagementId, briefingId],
  );
  return { engagementId, jobId: job.rows[0].id, briefingId };
}

describe("backfillBriefingGenerationIds — Task #303 B.7", () => {
  describe("parseArgs", () => {
    // CliOption parsing is trivial but we still pin it because the
    // post-merge script is invoked with hand-typed argv strings and
    // a typo would silently flip dry-run off.
    it("treats --dry-run as opting in", () => {
      expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    });
    it("defaults to a real run when --dry-run is absent", () => {
      expect(parseArgs([]).dryRun).toBe(false);
    });
    // Post-merge wires this script into every deploy, so a silent
    // accept of `--dryrun` (typo) would mutate production. We pin the
    // reject so a refactor that loosens the parser fails loudly.
    it("throws on an unknown flag rather than silently ignoring it", () => {
      expect(() => parseArgs(["--dryrun"])).toThrow(/Unknown argument/);
      expect(() => parseArgs(["--dry-run", "--bogus"])).toThrow(
        /Unknown argument/,
      );
    });
  });

  it("matches a briefing to its producing job and writes generation_id", async () => {
    await withTestSchema(async (ctx) => {
      const { jobId, briefingId } = await seedHappyPath(ctx);

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 1, unmatched: 0 });

      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].generation_id).toBe(jobId);
    });
  });

  it("is idempotent — a second run touches zero rows", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId, jobId } = await seedHappyPath(ctx);

      const first = await backfill({ dryRun: false }, makeDb(ctx));
      expect(first.matched).toBe(1);

      // Second run: every briefing already has generation_id set, so
      // the WHERE clause filters them all out before the UPDATE
      // touches anything. Both `matched` and `unmatched` should be 0.
      const second = await backfill({ dryRun: false }, makeDb(ctx));
      expect(second).toEqual({ scanned: 0, matched: 0, unmatched: 0 });

      // Belt-and-braces: the column still points at the original job.
      // (If the second run had run a stale UPDATE it might have
      // re-written it to a duplicate.)
      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].generation_id).toBe(jobId);
    });
  });

  it("does not mutate the database in --dry-run mode", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId } = await seedHappyPath(ctx);

      const summary = await backfill({ dryRun: true }, makeDb(ctx));
      // The dry-run reports the same "would match" tally a real run
      // would have produced, so the operator sees what they're about
      // to commit to.
      expect(summary).toEqual({ scanned: 1, matched: 1, unmatched: 0 });

      // …but the column is still NULL because dry-run takes the read
      // branch only.
      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].generation_id).toBeNull();
    });
  });

  it("leaves a briefing unmatched when its producing job was already pruned", async () => {
    await withTestSchema(async (ctx) => {
      // Seed a briefing with a generated_at, but no jobs at all —
      // mirroring the production case where the briefing-job sweeper
      // aged the producer out before this column existed.
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('Pruned Producer', 'pruned producer', 'Moab, UT', '2 Test Way')
           RETURNING id`,
      );
      const engagementId = eng.rows[0].id;
      const briefing = await ctx.pool.query<{ id: string }>(
        `INSERT INTO parcel_briefings
           (engagement_id, section_a, generated_at, generated_by)
           VALUES ($1, 'body', NOW() - interval '1 day',
                   'system:briefing-engine')
           RETURNING id`,
        [engagementId],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 0, unmatched: 1 });

      // The column stays NULL — the UI surfaces this as "producing
      // run pruned from history" via the B.8 pill rather than
      // mislabelling some unrelated job as "Current".
      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].generation_id).toBeNull();
    });
  });

  it("refuses to match when generated_at falls outside the job's window", async () => {
    await withTestSchema(async (ctx) => {
      // Job ran 10–5 seconds ago, but the briefing claims it was
      // generated 30 seconds ago — that's outside the job's window
      // so the heuristic must NOT match them. Guards against a
      // refactor that drops the interval-containment guard.
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('Out Of Window', 'out of window', 'Moab, UT', '3 Test Way')
           RETURNING id`,
      );
      const engagementId = eng.rows[0].id;
      const briefing = await ctx.pool.query<{ id: string }>(
        `INSERT INTO parcel_briefings
           (engagement_id, section_a, generated_at, generated_by)
           VALUES ($1, 'body', NOW() - interval '30 seconds',
                   'system:briefing-engine')
           RETURNING id`,
        [engagementId],
      );
      await ctx.pool.query(
        `INSERT INTO briefing_generation_jobs
           (engagement_id, briefing_id, state, started_at, completed_at)
           VALUES ($1, $2, 'completed', NOW() - interval '10 seconds',
                   NOW() - interval '5 seconds')`,
        [engagementId, briefing.rows[0].id],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 0, unmatched: 1 });

      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].generation_id).toBeNull();
    });
  });

  it("ignores pending and failed jobs even if the window matches", async () => {
    await withTestSchema(async (ctx) => {
      // Two jobs that share the same window as the happy path, but
      // one is pending and one is failed. The heuristic only matches
      // `state = 'completed'`, so the briefing should stay NULL.
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('Wrong States', 'wrong states', 'Moab, UT', '4 Test Way')
           RETURNING id`,
      );
      const engagementId = eng.rows[0].id;
      const briefing = await ctx.pool.query<{ id: string }>(
        `INSERT INTO parcel_briefings
           (engagement_id, section_a, generated_at, generated_by)
           VALUES ($1, 'body', NOW() - interval '7 seconds',
                   'system:briefing-engine')
           RETURNING id`,
        [engagementId],
      );
      // Both jobs target this briefing on briefing_id, but the
      // heuristic only matches `state = 'completed'` so neither
      // should be picked. Two rows guards against a refactor that
      // accidentally accepts the *first* job rather than filtering
      // by state.
      await ctx.pool.query(
        `INSERT INTO briefing_generation_jobs
           (engagement_id, briefing_id, state, started_at, completed_at)
           VALUES ($1, $2, 'failed', NOW() - interval '10 seconds',
                   NOW() - interval '5 seconds'),
                  ($1, $2, 'pending', NOW() - interval '10 seconds',
                   NULL)`,
        [engagementId, briefing.rows[0].id],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 0, unmatched: 1 });

      const after = await ctx.pool.query<{ generation_id: string | null }>(
        `SELECT generation_id FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].generation_id).toBeNull();
    });
  });
});
