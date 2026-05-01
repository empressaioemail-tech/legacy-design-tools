/**
 * Backfill `parcel_briefings.prior_generated_at` for legacy briefing
 * rows whose `prior_generated_by` is set but whose timestamp is null —
 * Task #324.
 *
 * Why: Task #313 made the recent-runs panel surface the actor on
 * legacy backups even when the prior timestamp is missing, but the
 * meta line still has to render only the "by …" half because
 * `prior_generated_at` is null on those rows. Stamping a real
 * timestamp lets the existing UI render the full "Generated … by …"
 * pair via the same interval matcher it already uses for the current
 * generation — no UI changes required.
 *
 * What we do: for every parcel briefing whose `prior_generated_at`
 * is null but whose `prior_generated_by` is set (and whose `generated_at`
 * is set, so we have an upper-bound for "before the current run"),
 * find the most recent `completed` job in `briefing_generation_jobs`
 * for the same `briefing_id` whose `completed_at` is strictly less
 * than `generated_at`, and copy its `completed_at` into
 * `prior_generated_at`.
 *
 * Why "most recent completed job before `generated_at`": the current
 * generation's window contains `pb.generated_at` (i.e. its
 * `completed_at >= pb.generated_at`), so any completed job whose
 * `completed_at < pb.generated_at` cannot be the current one. The
 * regeneration path captures the previous-current narrative into the
 * prior_* slots, so the producing job for the prior body is whichever
 * completed job ran most recently before the current one — the same
 * heuristic the old `BriefingRecentRunsPanel` used to label legacy
 * runs (Task #263).
 *
 * Idempotency: the WHERE clause filters out rows that already have
 * a `prior_generated_at`, so re-running is a no-op once the backfill
 * succeeds. Rows whose prior producing job has already aged out of
 * the keep window stay NULL on purpose — the UI surfaces that as
 * the existing "by …" only meta line rather than synthesising a
 * fictitious timestamp.
 *
 * Going-forward invariant: `routes/parcelBriefings.ts`
 * (`persistGenerationResult`) writes `priorGeneratedAt` and
 * `priorGeneratedBy` together inside the same transaction that
 * overwrites the section columns, so any briefing regenerated AFTER
 * this column landed already has the pair populated; only legacy rows
 * need the backfill.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill:prior-generated-at
 *   pnpm --filter @workspace/scripts run backfill:prior-generated-at -- --dry-run
 *
 * Wired into `scripts/post-merge.sh` so a deploy that picks up the
 * Task #324 column also picks up the backfill — no manual operator
 * step required.
 */

import { sql } from "drizzle-orm";
import { db as defaultDb, pool } from "@workspace/db";

export interface CliOptions {
  dryRun: boolean;
}

/**
 * Parse the script's argv. We deliberately reject anything we don't
 * recognise rather than silently ignoring it: this script is wired
 * into post-merge (`scripts/post-merge.sh`), so a typo like
 * `--dryrun` would otherwise look like a successful real run and
 * mutate the production DB. The CLI surface is tiny on purpose
 * (just `--dry-run`); enumerating known flags here keeps the contract
 * obvious for the next person to extend it.
 */
export function parseArgs(argv: string[]): CliOptions {
  const known = new Set(["--dry-run"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. ` +
        `Usage: backfill:prior-generated-at [--dry-run]`,
    );
  }
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
 * pulling in the full Drizzle type surface (mirrors the pattern in
 * `backfillBriefingGenerationIds.ts`).
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
  // by `briefing_id` plus the `state = 'completed'` and
  // `completed_at < pb.generated_at` guards mirror the heuristic
  // documented at the top of this file.
  if (opts.dryRun) {
    const preview = await db.execute<{
      briefing_id: string;
      prior_generated_at: string | null;
    }>(
      sql`SELECT pb.id AS briefing_id,
             (
               SELECT bgj.completed_at
               FROM briefing_generation_jobs bgj
               WHERE bgj.briefing_id = pb.id
                 AND bgj.state = 'completed'
                 AND bgj.completed_at IS NOT NULL
                 AND bgj.completed_at < pb.generated_at
               ORDER BY bgj.completed_at DESC
               LIMIT 1
             ) AS prior_generated_at
          FROM parcel_briefings pb
          WHERE pb.prior_generated_at IS NULL
            AND pb.prior_generated_by IS NOT NULL
            AND pb.generated_at IS NOT NULL`,
    );
    const matched = preview.rows.filter(
      (r) => r.prior_generated_at !== null,
    ).length;
    for (const row of preview.rows) {
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] briefing ${row.briefing_id} → ` +
          (row.prior_generated_at ?? "no matching prior job (would stay NULL)"),
      );
    }
    return {
      scanned: preview.rows.length,
      matched,
      unmatched: preview.rows.length - matched,
    };
  }

  const updated = await db.execute<{
    id: string;
    prior_generated_at: string;
  }>(
    sql`UPDATE parcel_briefings AS pb
        SET prior_generated_at = sub.prior_generated_at
        FROM (
          SELECT pb_inner.id AS briefing_id,
                 (
                   SELECT bgj.completed_at
                   FROM briefing_generation_jobs bgj
                   WHERE bgj.briefing_id = pb_inner.id
                     AND bgj.state = 'completed'
                     AND bgj.completed_at IS NOT NULL
                     AND bgj.completed_at < pb_inner.generated_at
                   ORDER BY bgj.completed_at DESC
                   LIMIT 1
                 ) AS prior_generated_at
          FROM parcel_briefings pb_inner
          WHERE pb_inner.prior_generated_at IS NULL
            AND pb_inner.prior_generated_by IS NOT NULL
            AND pb_inner.generated_at IS NOT NULL
        ) AS sub
        WHERE pb.id = sub.briefing_id
          AND sub.prior_generated_at IS NOT NULL
        RETURNING pb.id, pb.prior_generated_at`,
  );

  // Count what we *could not* match so the operator sees the
  // honest "this many rows have no prior producing job left" tally
  // without having to re-query.
  const remainder = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*)::text AS count
        FROM parcel_briefings
        WHERE prior_generated_at IS NULL
          AND prior_generated_by IS NOT NULL
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
    `Backfilling parcel_briefings.prior_generated_at (dryRun=${opts.dryRun})`,
  );
  const summary = await backfill(opts);
  // eslint-disable-next-line no-console
  console.log(
    `Done. scanned=${summary.scanned} matched=${summary.matched} ` +
      `unmatched=${summary.unmatched} (unmatched rows stay NULL — ` +
      `their prior producing job was pruned out of the keep window)`,
  );
  await pool.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
  void pool.end();
});
