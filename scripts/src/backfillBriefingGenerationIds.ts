/**
 * Backfill `parcel_briefings.generation_id` for rows that pre-date
 * Task #281.
 *
 * Why: Task #281 added a direct FK from `parcel_briefings` to the
 * `briefing_generation_jobs` row that produced its current
 * `section_a..g` body. New runs stamp the column inside the same
 * transaction that overwrites the section columns
 * (`persistGenerationResult`), so anything generated *after* the
 * column landed is correct by construction. Briefings generated
 * *before* it landed have a non-null `generated_at` but a null
 * `generation_id`, which the UI's "Current" pill in
 * `BriefingRecentRunsPanel` reads as "no producing run on file"
 * — accurate for pruned rows but a regression for legacy rows
 * whose producing job is still in the keep window.
 *
 * What we do: for every parcel briefing whose `generation_id` is
 * null but whose `generated_at` is set, find the most recent
 * `completed` job in `briefing_generation_jobs` for the same
 * `briefingId` whose [`startedAt`, `completedAt`] window contains
 * `generatedAt`, and stamp it. The interval match is the same
 * heuristic the old `BriefingRecentRunsPanel` used (Task #263) —
 * deterministic when the producing job survived the sweep, honest
 * (leaves NULL) when it didn't. We restrict to `state = 'completed'`
 * because `pending` and `failed` rows never set `generated_at` on
 * the briefing.
 *
 * Idempotency: the WHERE clause filters out rows that already have
 * a `generation_id`, so re-running is a no-op once the backfill
 * succeeds. Rows whose producing job has already aged out of the
 * keep window stay NULL on purpose — the UI surfaces that as "no
 * producing run on file" rather than mislabelling an unrelated
 * later row "Current".
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill:briefing-generation-ids
 *   pnpm --filter @workspace/scripts run backfill:briefing-generation-ids -- --dry-run
 *
 * Wired into `scripts/post-merge.sh` so a deploy that picks up the
 * Task #281 column also picks up the backfill — no manual operator
 * step required.
 */

import { sql } from "drizzle-orm";
import { db as defaultDb, pool } from "@workspace/db";

export interface CliOptions {
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

export interface BackfillSummary {
  scanned: number;
  matched: number;
  unmatched: number;
}

/**
 * Drizzle-or-pg interface the backfill needs — narrowed to just
 * `.execute()` so tests can pass a `withTestSchema` db without
 * pulling in the full Drizzle type surface (Task #303 B.7).
 */
type BackfillDb = {
  execute: <T>(query: ReturnType<typeof sql>) => Promise<{ rows: T[] }>;
};

export async function backfill(
  opts: CliOptions,
  dbArg: BackfillDb = defaultDb as unknown as BackfillDb,
): Promise<BackfillSummary> {
  const db = dbArg;
  // One UPDATE…FROM (LATERAL) round trip — Postgres picks the
  // most-recent matching completed job per briefing in a single
  // statement. Doing this in SQL rather than fetching+looping in
  // application code matters because the briefing table can hold
  // tens of thousands of rows on busy installs and the per-row
  // lookups would dominate run time. The lateral subquery scoped
  // by `briefing_id` plus the `completed_at IS NOT NULL` and
  // interval-containment guards mirror the old UI heuristic the
  // task is replacing, so the backfill picks the same row the
  // panel would have picked yesterday for any briefing whose
  // producer survived the sweep.
  if (opts.dryRun) {
    const preview = await db.execute<{
      briefing_id: string;
      generation_id: string | null;
    }>(
      sql`SELECT pb.id AS briefing_id,
             (
               SELECT bgj.id
               FROM briefing_generation_jobs bgj
               WHERE bgj.briefing_id = pb.id
                 AND bgj.state = 'completed'
                 AND bgj.completed_at IS NOT NULL
                 AND pb.generated_at >= bgj.started_at
                 AND pb.generated_at <= bgj.completed_at
               ORDER BY bgj.completed_at DESC
               LIMIT 1
             ) AS generation_id
          FROM parcel_briefings pb
          WHERE pb.generation_id IS NULL
            AND pb.generated_at IS NOT NULL`,
    );
    const matched = preview.rows.filter((r) => r.generation_id !== null)
      .length;
    for (const row of preview.rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] briefing ${row.briefing_id} → ` +
          (row.generation_id ?? "no matching job (would stay NULL)"),
      );
    }
    return {
      scanned: preview.rows.length,
      matched,
      unmatched: preview.rows.length - matched,
    };
  }

  const updated = await db.execute<{ id: string; generation_id: string }>(
    sql`UPDATE parcel_briefings AS pb
        SET generation_id = sub.generation_id
        FROM (
          SELECT pb_inner.id AS briefing_id,
                 (
                   SELECT bgj.id
                   FROM briefing_generation_jobs bgj
                   WHERE bgj.briefing_id = pb_inner.id
                     AND bgj.state = 'completed'
                     AND bgj.completed_at IS NOT NULL
                     AND pb_inner.generated_at >= bgj.started_at
                     AND pb_inner.generated_at <= bgj.completed_at
                   ORDER BY bgj.completed_at DESC
                   LIMIT 1
                 ) AS generation_id
          FROM parcel_briefings pb_inner
          WHERE pb_inner.generation_id IS NULL
            AND pb_inner.generated_at IS NOT NULL
        ) AS sub
        WHERE pb.id = sub.briefing_id
          AND sub.generation_id IS NOT NULL
        RETURNING pb.id, pb.generation_id`,
  );

  // Count what we *could not* match so the operator sees the
  // honest "this many rows have no producing job left" tally
  // without having to re-query.
  const remainder = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count
        FROM parcel_briefings
        WHERE generation_id IS NULL
          AND generated_at IS NOT NULL`,
  );
  const unmatched = Number(remainder.rows[0]?.count ?? "0");

  return {
    scanned: updated.rows.length + unmatched,
    matched: updated.rows.length,
    unmatched,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(
    `Backfilling parcel_briefings.generation_id (dryRun=${opts.dryRun})`,
  );
  const summary = await backfill(opts);
  // eslint-disable-next-line no-console
  console.log(
    `Done. scanned=${summary.scanned} matched=${summary.matched} ` +
      `unmatched=${summary.unmatched} (unmatched rows stay NULL — ` +
      `their producing job was pruned out of the keep window)`,
  );
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
