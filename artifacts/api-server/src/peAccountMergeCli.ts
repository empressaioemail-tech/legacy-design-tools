/**
 * T1-A (2026-10-22) — operator CLI for the one-time duplicate-account merge
 * (ruling 3). See `lib/peAccountMerge.ts` for the rules.
 *
 *   DATABASE_URL=… pnpm exec tsx src/peAccountMergeCli.ts            # dry run
 *   DATABASE_URL=… pnpm exec tsx src/peAccountMergeCli.ts --apply    # writes
 *
 * The dry run only READS and prints counts: groups, users to merge, rows per
 * table, attention flags. It never prints an email address. `--apply` also
 * requires PE_ACCOUNT_MERGE_APPLY=yes in the environment, so a copied dry-run
 * command line can never write by accident. Run the dry run first, and run
 * migration 0115 before either.
 *
 * Lanes never run this against a remote database; the integration seat does.
 */

import pg from "pg";
import {
  applyPeAccountMerge,
  countRowsToMove,
  planPeAccountMerge,
} from "./lib/peAccountMerge";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  if (apply && process.env["PE_ACCOUNT_MERGE_APPLY"] !== "yes") {
    console.error("--apply also requires PE_ACCOUNT_MERGE_APPLY=yes");
    return 2;
  }
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const groups = await planPeAccountMerge(client);
    const mergedIds = groups.flatMap((g) => g.merged.map((m) => m.id));
    const flags = new Map<string, number>();
    for (const g of groups) for (const f of g.flags) flags.set(f, (flags.get(f) ?? 0) + 1);
    console.log(`mode: ${apply ? "APPLY" : "dry-run (read only)"}`);
    console.log(`groups (verified email shared by >1 user): ${groups.length}`);
    console.log(`users to merge away: ${mergedIds.length}`);
    console.log(`survivors that are paid: ${groups.filter((g) => g.survivor.paid).length}`);
    for (const [flag, n] of [...flags.entries()].sort()) console.log(`flag ${flag}: ${n}`);
    if (mergedIds.length > 0) {
      for (const c of await countRowsToMove(client, mergedIds)) {
        if (c.rows > 0) console.log(`rows ${c.table}.${c.column}: ${c.rows}`);
      }
    }
    if (!apply) return 0;
    const result = await applyPeAccountMerge(client);
    console.log(`run_id: ${result.runId}`);
    console.log(`merged users: ${result.mergedUsers}`);
    console.log(`skipped (already merged): ${result.skippedAlreadyMerged}`);
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
