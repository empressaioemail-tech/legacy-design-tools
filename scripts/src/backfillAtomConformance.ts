/**
 * Architecture-homes Track A — in-place conformance backfill for mutable /
 * tenant atom families. Does not re-mint tenant-owned rows.
 *
 *   pnpm --filter @workspace/scripts run backfill:atom-conformance
 *   pnpm --filter @workspace/scripts run backfill:atom-conformance -- --dry-run
 *
 * Idempotent. Safe to re-run.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

function parseArgs(argv: string[]) {
  return { dryRun: argv.includes("--dry-run") };
}

export async function backfillAtomConformance(options?: {
  dryRun?: boolean;
}): Promise<{
  reasoningTenantScopedNormalized: number;
  encumbranceInstrumentCount: number;
  encumbranceClauseCount: number;
  findingEventCount: number;
  submissionClassificationCount: number;
}> {
  const dryRun = options?.dryRun ?? false;

  const reasoningBefore = (
    await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM reasoning_atoms
    WHERE access_policy = 'tenant-scoped'
  `)
  ).rows[0];
  const reasoningTenantScoped = Number(reasoningBefore?.count ?? 0);

  if (!dryRun && reasoningTenantScoped > 0) {
    await db.execute(sql`
      UPDATE reasoning_atoms
      SET access_policy = 'tenant-private', updated_at = NOW()
      WHERE access_policy = 'tenant-scoped'
    `);
  }

  const inst = (
    await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM recorded_instruments
  `)
  ).rows[0];
  const clauses = (
    await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM restriction_clauses
  `)
  ).rows[0];
  const findings = (
    await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM atom_events
    WHERE entity_type = 'finding'
      AND event_type IN (
        'finding.accepted',
        'finding.rejected',
        'finding.overridden',
        'finding.generated'
      )
  `)
  ).rows[0];
  const classifications = (
    await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM submission_classifications
  `)
  ).rows[0];

  return {
    reasoningTenantScopedNormalized: dryRun
      ? reasoningTenantScoped
      : reasoningTenantScoped,
    encumbranceInstrumentCount: Number(inst?.count ?? 0),
    encumbranceClauseCount: Number(clauses?.count ?? 0),
    findingEventCount: Number(findings?.count ?? 0),
    submissionClassificationCount: Number(classifications?.count ?? 0),
  };
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const stats = await backfillAtomConformance({ dryRun });
  console.log(
    JSON.stringify(
      {
        dryRun,
        ...stats,
        note:
          "readContract is derived at read (not stored). accessPolicy DB backfill: reasoning tenant-scoped→tenant-private only.",
      },
      null,
      2,
    ),
  );
}

const invokedAsEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /backfillAtomConformance\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (invokedAsEntrypoint) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
