/**
 * Tests for the `parcel_briefings.prior_generated_at` backfill — Task #324.
 *
 * Why this exists
 * ---------------
 * The backfill is a one-shot post-merge step that walks every parcel
 * briefing whose `prior_generated_at` is NULL but whose
 * `prior_generated_by` is set, and stamps the timestamp with the
 * `completed_at` of the most recent completed `briefing_generation_jobs`
 * row that finished before the briefing's current `generated_at`.
 *
 * Two safety properties have to hold before we can safely wire this
 * into post-merge:
 *
 *   1. Idempotency. Running it a second time on an already-backfilled
 *      DB MUST be a no-op — `matched=0`, no rows touched. Post-merge
 *      re-runs it on every deploy, so a non-idempotent backfill would
 *      thrash the column (or worse, re-pick a different prior on a
 *      later deploy if the heuristic is non-deterministic).
 *
 *   2. Dry-run is non-destructive. `--dry-run` MUST report the same
 *      "would match" tally as a real run but MUST NOT mutate the
 *      database. Operators rely on it to preview before committing.
 *
 * We additionally pin the heuristic with fixture-led cases so a
 * refactor that, say, drops the `state = 'completed'` guard or the
 * `completed_at < pb.generated_at` guard fails loudly in CI:
 *
 *   - A briefing whose prior producing job was pruned stays NULL.
 *   - The picked job is the most recent one BEFORE the current
 *     generation — never the current job itself, even though the
 *     current one shares the same `briefing_id`.
 *   - Pending and failed jobs are ignored.
 *   - Briefings without `prior_generated_by` are skipped (no
 *     prior to backfill).
 *   - Briefings with `prior_generated_at` already set are skipped
 *     (avoids overwriting accurate data).
 *
 * Strategy
 * --------
 * We use `withTestSchema` from `@workspace/db/testing` so each test
 * gets a fresh empty schema with the production DDL replayed. We seed
 * `engagements`, `briefing_generation_jobs`, and `parcel_briefings`
 * directly via raw SQL — the backfill operates on raw SQL, so the
 * test exercises the same code path that runs in production.
 */

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";
import { backfill, parseArgs } from "../backfillPriorGeneratedAt";

/**
 * Wrap the test schema's `Pool` in a Drizzle client narrowed to the
 * `.execute()` shape the backfill expects. Mirrors the wrapper used
 * in `backfillBriefingGenerationIds.test.ts` — same reasoning: the
 * backfill's `BackfillDb` interface is private to the script and
 * runtime-compatible with `drizzle(pool)` but the variance can't be
 * reconciled by TS without exposing internals.
 */
function makeDb(ctx: TestSchemaContext): Parameters<typeof backfill>[1] {
  return drizzle(ctx.pool) as unknown as Parameters<typeof backfill>[1];
}

/**
 * Seed one engagement, two completed jobs (an older "prior" and a
 * newer "current"), and a parcel briefing whose `generated_at` falls
 * inside the current job's window and whose prior_* columns carry an
 * actor but no timestamp — exactly the legacy shape the backfill
 * targets. Returns the seeded ids so individual tests can assert
 * against them.
 */
async function seedHappyPath(ctx: TestSchemaContext): Promise<{
  engagementId: string;
  priorJobId: string;
  currentJobId: string;
  briefingId: string;
  priorJobCompletedAt: Date;
}> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('Test Engagement', 'test engagement', 'Moab, UT', '1 Test Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0].id;

  // Briefing must exist before the jobs because the heuristic joins
  // on `briefing_generation_jobs.briefing_id = parcel_briefings.id`.
  // The briefing's `generated_at` is t-7s (inside the current job's
  // window of t-10s..t-5s), and the prior_* columns carry an actor
  // but a null timestamp — the legacy shape we backfill.
  const briefing = await ctx.pool.query<{ id: string }>(
    `INSERT INTO parcel_briefings
       (engagement_id, section_a, generated_at, generated_by,
        prior_section_a, prior_generated_by)
       VALUES ($1, 'current body', NOW() - interval '7 seconds',
               'system:briefing-engine',
               'older body', 'user:legacy-actor')
       RETURNING id`,
    [engagementId],
  );
  const briefingId = briefing.rows[0].id;

  // Prior job ran from t-100s to t-95s — well before the current
  // generation. The backfill should pick this one's completed_at.
  const priorJob = await ctx.pool.query<{ id: string; completed_at: Date }>(
    `INSERT INTO briefing_generation_jobs
       (engagement_id, briefing_id, state, started_at, completed_at)
       VALUES ($1, $2, 'completed', NOW() - interval '100 seconds',
               NOW() - interval '95 seconds')
       RETURNING id, completed_at`,
    [engagementId, briefingId],
  );

  // Current job ran from t-10s to t-5s — its window contains the
  // briefing's generated_at (t-7s). The backfill must NOT pick this
  // one even though it shares the same briefing_id.
  const currentJob = await ctx.pool.query<{ id: string }>(
    `INSERT INTO briefing_generation_jobs
       (engagement_id, briefing_id, state, started_at, completed_at)
       VALUES ($1, $2, 'completed', NOW() - interval '10 seconds',
               NOW() - interval '5 seconds')
       RETURNING id`,
    [engagementId, briefingId],
  );

  return {
    engagementId,
    priorJobId: priorJob.rows[0].id,
    currentJobId: currentJob.rows[0].id,
    briefingId,
    priorJobCompletedAt: priorJob.rows[0].completed_at,
  };
}

describe("backfillPriorGeneratedAt — Task #324", () => {
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

  it("matches a briefing to its prior producing job and writes prior_generated_at", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId, priorJobCompletedAt } = await seedHappyPath(ctx);

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 1, unmatched: 0 });

      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      // The stamped timestamp must be the prior job's completed_at —
      // not the current job's, not the briefing's generated_at.
      expect(after.rows[0].prior_generated_at).not.toBeNull();
      expect(after.rows[0].prior_generated_at?.getTime()).toBe(
        priorJobCompletedAt.getTime(),
      );
    });
  });

  it("is idempotent — a second run touches zero rows", async () => {
    await withTestSchema(async (ctx) => {
      const { briefingId, priorJobCompletedAt } = await seedHappyPath(ctx);

      const first = await backfill({ dryRun: false }, makeDb(ctx));
      expect(first.matched).toBe(1);

      // Second run: the WHERE clause filters out rows with a non-null
      // prior_generated_at, so no UPDATE fires. Both `matched` and
      // `unmatched` should be 0.
      const second = await backfill({ dryRun: false }, makeDb(ctx));
      expect(second).toEqual({ scanned: 0, matched: 0, unmatched: 0 });

      // Belt-and-braces: the column still points at the prior job's
      // completed_at — a stale UPDATE running on the second pass
      // could in principle re-write to a different value, but
      // skipping the UPDATE means the value can't drift.
      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].prior_generated_at?.getTime()).toBe(
        priorJobCompletedAt.getTime(),
      );
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
      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      expect(after.rows[0].prior_generated_at).toBeNull();
    });
  });

  it("leaves a briefing unmatched when its prior producing job was already pruned", async () => {
    await withTestSchema(async (ctx) => {
      // Seed a briefing in the legacy shape (current generated_at,
      // prior_generated_by set, prior_generated_at null), but only
      // one completed job exists — the current generation. The prior
      // producing job has been pruned by the briefing-jobs sweeper,
      // so the backfill can't find a candidate and must leave the
      // column NULL.
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('Pruned Prior', 'pruned prior', 'Moab, UT', '2 Test Way')
           RETURNING id`,
      );
      const engagementId = eng.rows[0].id;
      const briefing = await ctx.pool.query<{ id: string }>(
        `INSERT INTO parcel_briefings
           (engagement_id, section_a, generated_at, generated_by,
            prior_section_a, prior_generated_by)
           VALUES ($1, 'current body', NOW() - interval '7 seconds',
                   'system:briefing-engine',
                   'older body', 'user:legacy-actor')
           RETURNING id`,
        [engagementId],
      );
      // Only the current job survives.
      await ctx.pool.query(
        `INSERT INTO briefing_generation_jobs
           (engagement_id, briefing_id, state, started_at, completed_at)
           VALUES ($1, $2, 'completed', NOW() - interval '10 seconds',
                   NOW() - interval '5 seconds')`,
        [engagementId, briefing.rows[0].id],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 0, unmatched: 1 });

      // The column stays NULL — the UI surfaces this as the legacy
      // "by …" only meta line rather than synthesising a fictitious
      // timestamp.
      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].prior_generated_at).toBeNull();
    });
  });

  it("ignores pending and failed jobs even if they completed before generated_at", async () => {
    await withTestSchema(async (ctx) => {
      // A pending job (no completed_at) and a failed job (with a
      // completed_at before generated_at) both exist alongside the
      // current job. Neither should be picked — only the
      // `state = 'completed'` rows count. Two wrong-state rows guard
      // against a refactor that drops the state filter and accepts
      // the most-recent one regardless.
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('Wrong States', 'wrong states', 'Moab, UT', '3 Test Way')
           RETURNING id`,
      );
      const engagementId = eng.rows[0].id;
      const briefing = await ctx.pool.query<{ id: string }>(
        `INSERT INTO parcel_briefings
           (engagement_id, section_a, generated_at, generated_by,
            prior_section_a, prior_generated_by)
           VALUES ($1, 'current body', NOW() - interval '7 seconds',
                   'system:briefing-engine',
                   'older body', 'user:legacy-actor')
           RETURNING id`,
        [engagementId],
      );
      await ctx.pool.query(
        `INSERT INTO briefing_generation_jobs
           (engagement_id, briefing_id, state, started_at, completed_at)
           VALUES ($1, $2, 'failed', NOW() - interval '100 seconds',
                   NOW() - interval '95 seconds'),
                  ($1, $2, 'pending', NOW() - interval '50 seconds',
                   NULL),
                  ($1, $2, 'completed', NOW() - interval '10 seconds',
                   NOW() - interval '5 seconds')`,
        [engagementId, briefing.rows[0].id],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      expect(summary).toEqual({ scanned: 1, matched: 0, unmatched: 1 });

      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].prior_generated_at).toBeNull();
    });
  });

  it("never picks the current job, even though it shares briefing_id", async () => {
    // Belt-and-braces test for the `completed_at < pb.generated_at`
    // guard. The current job's window CONTAINS pb.generated_at —
    // i.e. its `completed_at >= pb.generated_at` — so the strict
    // less-than excludes it. If the guard ever loosened to `<=` or
    // dropped, this test would catch the regression by seeing the
    // current job's completed_at land in prior_generated_at.
    await withTestSchema(async (ctx) => {
      const { briefingId, priorJobCompletedAt } = await seedHappyPath(ctx);

      await backfill({ dryRun: false }, makeDb(ctx));

      const after = await ctx.pool.query<{
        prior_generated_at: Date | null;
        generated_at: Date | null;
      }>(
        `SELECT prior_generated_at, generated_at
           FROM parcel_briefings WHERE id = $1`,
        [briefingId],
      );
      // prior_generated_at must equal the prior job's completed_at,
      // not the current job's, and must be strictly before
      // generated_at.
      expect(after.rows[0].prior_generated_at?.getTime()).toBe(
        priorJobCompletedAt.getTime(),
      );
      expect(after.rows[0].prior_generated_at!.getTime()).toBeLessThan(
        after.rows[0].generated_at!.getTime(),
      );
    });
  });

  it("skips briefings whose prior_generated_by is null", async () => {
    // Briefings that have never been regenerated have null prior_*
    // columns by design. The backfill must NOT touch them — there is
    // no prior to backfill. Pinning this guards against a refactor
    // that drops the `prior_generated_by IS NOT NULL` guard and
    // starts inventing a "prior" generation for first-only runs.
    await withTestSchema(async (ctx) => {
      const eng = await ctx.pool.query<{ id: string }>(
        `INSERT INTO engagements (name, name_lower, jurisdiction, address)
           VALUES ('First Gen Only', 'first gen only', 'Moab, UT', '4 Test Way')
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
      // An older completed job exists (which COULD be picked if the
      // guard were dropped), but because prior_generated_by is null
      // the backfill must skip this briefing entirely.
      await ctx.pool.query(
        `INSERT INTO briefing_generation_jobs
           (engagement_id, briefing_id, state, started_at, completed_at)
           VALUES ($1, $2, 'completed', NOW() - interval '100 seconds',
                   NOW() - interval '95 seconds')`,
        [engagementId, briefing.rows[0].id],
      );

      const summary = await backfill({ dryRun: false }, makeDb(ctx));
      // scanned=0 because the briefing was filtered out before the
      // candidate-job lookup ran.
      expect(summary).toEqual({ scanned: 0, matched: 0, unmatched: 0 });

      const after = await ctx.pool.query<{ prior_generated_at: Date | null }>(
        `SELECT prior_generated_at FROM parcel_briefings WHERE id = $1`,
        [briefing.rows[0].id],
      );
      expect(after.rows[0].prior_generated_at).toBeNull();
    });
  });
});
