/**
 * Backfill `sheet.created` history events for sheets that were ingested
 * before history-event tracking went live (Task #32).
 *
 * Why: the plan-review Sheets page renders a "first ingested" chip from
 * the sheet atom's `historyProvenance.latestEventId`. When that field is
 * empty (no `atom_events` rows for the entity) the chip falls back to
 * "Not tracked", which is misleading for legacy snapshots that were
 * uploaded before the producer in `routes/sheets.ts` started appending
 * `sheet.created`. Synthesising one event per legacy row, anchored to
 * the row's `created_at`, restores accurate provenance without touching
 * the source-of-truth `sheets` table.
 *
 * Idempotency: a sheet is only touched if it has no `sheet.created`
 * row in `atom_events`. The check is event-type specific (rather than
 * "any event for this entity") because a legacy sheet can plausibly
 * have only later lifecycle events — for example a `sheet.updated`
 * emitted by a re-upload after tracking went live, or a
 * `sheet.removed` written by the snapshot-diff path — without ever
 * having had its `sheet.created` recorded. Those rows still need a
 * synthetic `sheet.created` to satisfy the chip's "first ingested"
 * provenance and to mirror the contract that every sheet's chain
 * starts with `sheet.created`. The new event is appended at the tail
 * of the existing chain (the framework's `appendEvent` walks to the
 * tail and links from there); we never prepend or fork. The script is
 * safe to re-run because subsequent passes find the just-written
 * `sheet.created` and skip.
 *
 * The synthetic event is marked `backfilled: true` in its payload and
 * uses a distinct system actor id (`history-backfill`) so downstream
 * consumers can distinguish it from real ingest events emitted by
 * `snapshot-ingest`.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill:sheet-created
 *   pnpm --filter @workspace/scripts run backfill:sheet-created -- --dry-run
 *
 * Exit code is non-zero if any append fails so CI / operators notice
 * partial completion.
 */

import { sql } from "drizzle-orm";
import { db as defaultDb, pool, sheets } from "@workspace/db";
import {
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";

export interface CliOptions {
  dryRun: boolean;
}

/**
 * Parse the script's argv. Mirrors the strict policy used by the
 * `parcel_briefings.generation_id` backfill (Task #303 B.7): unknown
 * flags throw rather than silently no-oping, because both scripts are
 * candidates for the post-merge deploy path and a typo like `--dryrun`
 * must not look like a clean real run that mutated production.
 */
export function parseArgs(argv: string[]): CliOptions {
  const known = new Set(["--dry-run"]);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown argument(s): ${unknown.join(", ")}. ` +
        `Usage: backfill:sheet-created [--dry-run]`,
    );
  }
  return {
    dryRun: argv.includes("--dry-run"),
  };
}

export interface BackfillSummary {
  totalSheets: number;
  alreadyHasCreated: number;
  backfilled: number;
  failed: number;
}

/**
 * Drizzle db surface this script needs. Spelled as the concrete
 * `defaultDb` type so it stays in sync with `@workspace/db` (which
 * also backs `withTestSchema`'s `ctx.db`) without re-stating every
 * query-builder method we happen to use here.
 */
export type BackfillDb = typeof defaultDb;

async function fetchSheetIdsWithCreatedEvent(
  db: BackfillDb,
): Promise<Set<string>> {
  // One round trip: every sheet entity that already has a
  // `sheet.created` row in atom_events. The filter is event-type
  // specific because a sheet may legitimately have only later events
  // (`sheet.updated`/`sheet.removed`) but still be missing the
  // `sheet.created` we need to record here.
  const result = await db.execute<{ entity_id: string }>(
    sql`SELECT DISTINCT entity_id
        FROM atom_events
        WHERE entity_type = 'sheet'
          AND event_type = 'sheet.created'`,
  );
  const out = new Set<string>();
  for (const row of result.rows) {
    if (typeof row.entity_id === "string") out.add(row.entity_id);
  }
  return out;
}

/**
 * Run the backfill against the supplied `db` (defaults to the
 * production singleton). The optional `history` argument lets tests
 * inject a fake `EventAnchoringService` if they want to assert on the
 * append calls without touching `atom_events`; in production we
 * construct a `PostgresEventAnchoringService` over the same `db` so
 * the synthetic events land in the chain alongside real ones.
 */
export async function backfill(
  opts: CliOptions,
  db: BackfillDb = defaultDb,
  history?: EventAnchoringService,
): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    totalSheets: 0,
    alreadyHasCreated: 0,
    backfilled: 0,
    failed: 0,
  };

  const hasCreated = await fetchSheetIdsWithCreatedEvent(db);

  // Pull every sheet row. The columns we need fit comfortably in memory
  // for the snapshot sizes this app handles; if the table grows beyond
  // a sensible limit a streaming cursor is the next step. Sorted by
  // `created_at` so the chain hashes in `atom_events` reflect the
  // ingest order legacy operators would expect to see in logs.
  const rows = await db
    .select({
      id: sheets.id,
      snapshotId: sheets.snapshotId,
      engagementId: sheets.engagementId,
      sheetNumber: sheets.sheetNumber,
      sheetName: sheets.sheetName,
      createdAt: sheets.createdAt,
    })
    .from(sheets)
    .orderBy(sheets.createdAt);

  summary.totalSheets = rows.length;

  const anchoring: EventAnchoringService =
    history ??
    new PostgresEventAnchoringService(
      db as unknown as ConstructorParameters<
        typeof PostgresEventAnchoringService
      >[0],
    );

  for (const row of rows) {
    if (hasCreated.has(row.id)) {
      summary.alreadyHasCreated++;
      continue;
    }
    if (opts.dryRun) {
      summary.backfilled++;
      // eslint-disable-next-line no-console
      console.log(
        `[dry-run] would append sheet.created for sheet ${row.id} ` +
          `(${row.sheetNumber} — "${row.sheetName}") at ${row.createdAt.toISOString()}`,
      );
      continue;
    }
    try {
      const event = await anchoring.appendEvent({
        entityType: "sheet",
        entityId: row.id,
        eventType: "sheet.created",
        actor: { kind: "system", id: "history-backfill" },
        occurredAt: row.createdAt,
        payload: {
          sheetNumber: row.sheetNumber,
          sheetName: row.sheetName,
          snapshotId: row.snapshotId,
          engagementId: row.engagementId,
          backfilled: true,
        },
      });
      summary.backfilled++;
      // eslint-disable-next-line no-console
      console.log(
        `appended sheet.created for sheet ${row.id} ` +
          `(${row.sheetNumber}) eventId=${event.id} chainHash=${event.chainHash}`,
      );
    } catch (err) {
      summary.failed++;
      // eslint-disable-next-line no-console
      console.error(
        `failed to append sheet.created for sheet ${row.id} (${row.sheetNumber}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return summary;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // eslint-disable-next-line no-console
  console.log(
    `backfillSheetCreatedEvents: starting${opts.dryRun ? " (dry-run)" : ""}`,
  );
  let exitCode = 0;
  try {
    const summary = await backfill(opts);
    // eslint-disable-next-line no-console
    console.log("backfillSheetCreatedEvents: done", summary);
    if (summary.failed > 0) exitCode = 1;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("backfillSheetCreatedEvents: fatal error", err);
    exitCode = 1;
  } finally {
    // Drizzle's `db` holds a long-lived `pg.Pool`; tsx will hang on the
    // open sockets if we don't close it explicitly.
    await pool.end().catch(() => {
      /* best-effort */
    });
  }
  process.exit(exitCode);
}

// Only invoke `main()` when this module is executed as the script's
// entrypoint (i.e. `tsx backfillSheetCreatedEvents.ts`). Without
// this guard, merely `import`-ing the module — as the unit and
// integration tests do to reach the exported `backfill()` — would
// run the CLI, hit `process.exit()` inside Vitest, and abort the
// test runner.
//
// Mirrors the regex check in `sweepOrphanAvatars.ts` rather than the
// `import.meta.url === \`file://${process.argv[1]}\`` style so all
// three one-shot scripts (`sweepOrphanAvatars`, this one, and
// `smokeConverter`) share one pattern. The regex form also tolerates
// path normalisation differences (symlinks, trailing query strings)
// that the strict URL-equality form can trip over.
const invokedAsEntrypoint =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /backfillSheetCreatedEvents\.(ts|js|mjs|cjs)$/.test(process.argv[1]);

if (invokedAsEntrypoint) {
  void main();
}
