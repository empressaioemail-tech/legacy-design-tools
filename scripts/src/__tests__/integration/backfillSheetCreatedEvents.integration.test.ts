/**
 * Integration tests for the `sheet.created` history-event backfill
 * (Task #311).
 *
 * Why this exists
 * ---------------
 * `backfillSheetCreatedEvents.ts` is a candidate for the same
 * post-merge wiring that already runs the `parcel_briefings.
 * generation_id` backfill (`scripts/post-merge.sh`, Task #281). It
 * paves over a class of legacy data — sheet rows ingested before
 * `routes/sheets.ts` started appending `sheet.created` to
 * `atom_events` — by synthesising one event per untracked sheet so
 * the plan-review "first ingested" chip stops falling back to
 * "Not tracked" on those rows.
 *
 * Until this file landed there was no automated coverage of the
 * script's heuristics. A future change that, say, dropped the
 * event-type filter in `fetchSheetIdsWithCreatedEvent`, swapped the
 * `ORDER BY created_at` for something non-deterministic, or wired
 * the actor id to a real user would silently regress on every
 * install with legacy sheets — the only signal would be a quiet
 * operator log line in the next deploy.
 *
 * What we pin
 * -----------
 *   1. Legacy split. A sheet with zero history events MUST be
 *      backfilled; a sheet with a real `sheet.created` MUST NOT.
 *      The matched/unmatched tally MUST reflect that exactly.
 *   2. Updated-without-created edge. A sheet that has only later
 *      lifecycle events (e.g. a `sheet.updated` from a re-upload
 *      after tracking went live) is still missing its
 *      `sheet.created` and MUST be backfilled. Guards the comment
 *      in the script that explains why the existence check is
 *      event-type-specific rather than "any event for this entity".
 *   3. Idempotency. A second run over an already-backfilled DB MUST
 *      report zero new appends. Without this, post-merge wiring
 *      would mutate `atom_events` on every deploy.
 *   4. Dry-run is non-destructive. `--dry-run` MUST report the same
 *      "would backfill" tally a real run would produce but MUST NOT
 *      insert any rows into `atom_events`.
 *   5. Synthetic event provenance. The appended row MUST carry the
 *      distinct system actor id `history-backfill` and a
 *      `backfilled: true` payload flag — that's the contract
 *      downstream consumers rely on to distinguish synthetic events
 *      from real ingest events emitted by `snapshot-ingest`.
 *
 * Strategy
 * --------
 * Mirrors `scripts/src/__tests__/backfillBriefingGenerationIds.test.ts`:
 * each test gets a fresh schema via `withTestSchema`, seeds raw rows
 * via `ctx.pool.query` (so we don't drag the full Drizzle relations
 * graph into the test fixture), then calls the exported `backfill()`
 * with the test schema's Drizzle client. The script's real
 * `PostgresEventAnchoringService` is exercised end-to-end against
 * the test schema's `atom_events` table — the same code path
 * production uses.
 *
 * Like the briefing-id backfill test, this file reaches `withTestSchema`
 * which throws when neither `TEST_DATABASE_URL` nor `DATABASE_URL` is
 * set — that's how the suite is implicitly gated on a Postgres being
 * reachable (the same gate `pnpm --filter @workspace/scripts test`
 * inherits in CI).
 */

import { describe, it, expect } from "vitest";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";
import {
  backfill,
  parseArgs,
  type BackfillDb,
} from "../../backfillSheetCreatedEvents";

/**
 * `ctx.db` is typed against `@workspace/db`'s schema bag, which is
 * the same schema the script's `defaultDb` uses, but TS sees the
 * two as distinct nominal types when the script imports through the
 * package barrel and the test imports through `@workspace/db/testing`.
 * Casting through `unknown` keeps the script's signature narrow
 * (`BackfillDb = typeof defaultDb`) without forcing the test to
 * re-state every Drizzle method we touch.
 */
function asBackfillDb(ctx: TestSchemaContext): BackfillDb {
  return ctx.db as unknown as BackfillDb;
}

const TINY_PNG = Buffer.from([0]);

interface SeedResult {
  engagementId: string;
  snapshotId: string;
  /** Sheet ingested before tracking — has zero `atom_events` rows. */
  legacySheetId: string;
  /**
   * Sheet ingested after tracking — already has a real
   * `sheet.created` event so the backfill MUST skip it.
   */
  trackedSheetId: string;
  /**
   * Sheet ingested after tracking but for which only `sheet.updated`
   * was ever recorded (e.g. a re-upload landed before the original
   * `sheet.created` was emitted). MUST be backfilled.
   */
  updatedOnlySheetId: string;
}

/**
 * Seed one engagement/snapshot plus three sheets covering the
 * legacy/non-legacy split the backfill is meant to fix:
 *
 *   - legacy:        no events at all → must be backfilled
 *   - tracked:       a real `sheet.created` event → must be skipped
 *   - updated-only:  only `sheet.updated` event(s) → must be backfilled
 *
 * Inserts go through raw SQL because the script reads the underlying
 * tables (sheets, atom_events) directly; this keeps the fixture
 * shape tied to the SQL the script targets rather than to the
 * Drizzle relations graph.
 */
async function seedLegacySplit(ctx: TestSchemaContext): Promise<SeedResult> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('Sheet Backfill Engagement', 'sheet backfill engagement',
               'Moab, UT', '11 Sheet Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0].id;

  const snap = await ctx.pool.query<{ id: string }>(
    `INSERT INTO snapshots (engagement_id, project_name, payload)
       VALUES ($1, 'Sheet Backfill Snapshot', '{}'::jsonb)
       RETURNING id`,
    [engagementId],
  );
  const snapshotId = snap.rows[0].id;

  // Legacy sheet — created_at is older than the others so the
  // backfill's `ORDER BY created_at` processes it first. No
  // `atom_events` rows at all.
  const legacy = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sheets
       (snapshot_id, engagement_id, sheet_number, sheet_name,
        thumbnail_png, thumbnail_width, thumbnail_height,
        full_png, full_width, full_height, sort_order, created_at)
       VALUES ($1, $2, 'A100', 'Legacy Sheet',
               $3, 1, 1, $3, 1, 1, 0, NOW() - interval '30 days')
       RETURNING id`,
    [snapshotId, engagementId, TINY_PNG],
  );
  const legacySheetId = legacy.rows[0].id;

  // Tracked sheet — has a pre-existing `sheet.created` row that
  // mimics what `routes/sheets.ts` would have written at ingest.
  const tracked = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sheets
       (snapshot_id, engagement_id, sheet_number, sheet_name,
        thumbnail_png, thumbnail_width, thumbnail_height,
        full_png, full_width, full_height, sort_order, created_at)
       VALUES ($1, $2, 'A101', 'Tracked Sheet',
               $3, 1, 1, $3, 1, 1, 1, NOW() - interval '7 days')
       RETURNING id`,
    [snapshotId, engagementId, TINY_PNG],
  );
  const trackedSheetId = tracked.rows[0].id;
  // Use a deterministic chain hash here — the value is opaque to
  // the backfill (it only filters by entity_type/event_type), and
  // the schema's UNIQUE constraint on `chain_hash` rejects
  // duplicates, so we stamp a per-sheet literal.
  await ctx.pool.query(
    `INSERT INTO atom_events
       (id, entity_type, entity_id, event_type, actor, payload,
        prev_hash, chain_hash, occurred_at)
       VALUES ('01EXISTINGREALEVENT00000', 'sheet', $1, 'sheet.created',
               '{"kind":"system","id":"snapshot-ingest"}'::jsonb,
               '{"sheetNumber":"A101"}'::jsonb,
               NULL, 'chain-hash-tracked-created', NOW() - interval '7 days')`,
    [trackedSheetId],
  );

  // Updated-only sheet — has a `sheet.updated` from a later
  // re-upload but never got a `sheet.created`. The backfill MUST
  // still synthesise one and append it to the existing chain (the
  // framework's `appendEvent` walks to the tail and links from
  // there); this is the case the script's idempotency comment
  // singles out.
  const updatedOnly = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sheets
       (snapshot_id, engagement_id, sheet_number, sheet_name,
        thumbnail_png, thumbnail_width, thumbnail_height,
        full_png, full_width, full_height, sort_order, created_at)
       VALUES ($1, $2, 'A102', 'Updated-Only Sheet',
               $3, 1, 1, $3, 1, 1, 2, NOW() - interval '3 days')
       RETURNING id`,
    [snapshotId, engagementId, TINY_PNG],
  );
  const updatedOnlySheetId = updatedOnly.rows[0].id;
  await ctx.pool.query(
    `INSERT INTO atom_events
       (id, entity_type, entity_id, event_type, actor, payload,
        prev_hash, chain_hash, occurred_at)
       VALUES ('01EXISTINGUPDATED0000000', 'sheet', $1, 'sheet.updated',
               '{"kind":"system","id":"snapshot-ingest"}'::jsonb,
               '{"sheetNumber":"A102"}'::jsonb,
               NULL, 'chain-hash-updated-only', NOW() - interval '3 days')`,
    [updatedOnlySheetId],
  );

  return {
    engagementId,
    snapshotId,
    legacySheetId,
    trackedSheetId,
    updatedOnlySheetId,
  };
}

describe("backfillSheetCreatedEvents — Task #311", () => {
  describe("parseArgs", () => {
    // CLI parsing is trivial but pinned because the script is a
    // candidate for the post-merge deploy path (`scripts/post-merge.sh`)
    // — a typo on the command line silently flipping dry-run off
    // would mutate production.
    it("treats --dry-run as opting in", () => {
      expect(parseArgs(["--dry-run"]).dryRun).toBe(true);
    });
    it("defaults to a real run when --dry-run is absent", () => {
      expect(parseArgs([]).dryRun).toBe(false);
    });
    it("throws on an unknown flag rather than silently ignoring it", () => {
      expect(() => parseArgs(["--dryrun"])).toThrow(/Unknown argument/);
      expect(() => parseArgs(["--dry-run", "--bogus"])).toThrow(
        /Unknown argument/,
      );
    });
  });

  it("backfills legacy sheets and skips ones that already have sheet.created", async () => {
    await withTestSchema(async (ctx) => {
      const seeded = await seedLegacySplit(ctx);

      const summary = await backfill({ dryRun: false }, asBackfillDb(ctx));

      // Three sheets total. Tracked sheet has `sheet.created`
      // already → skipped. Legacy + updated-only sheets are
      // missing `sheet.created` → both backfilled. No failures.
      expect(summary).toEqual({
        totalSheets: 3,
        alreadyHasCreated: 1,
        backfilled: 2,
        failed: 0,
      });

      // Side effect: every sheet now has exactly one `sheet.created`.
      // A miscount here (e.g. a refactor that drops the WHERE on
      // event_type) would either over- or under-write events on the
      // tracked sheet.
      const counts = await ctx.pool.query<{
        entity_id: string;
        c: string;
      }>(
        `SELECT entity_id, COUNT(*)::text c
           FROM atom_events
           WHERE entity_type = 'sheet' AND event_type = 'sheet.created'
           GROUP BY entity_id`,
      );
      const byId = new Map(counts.rows.map((r) => [r.entity_id, Number(r.c)]));
      expect(byId.get(seeded.legacySheetId)).toBe(1);
      expect(byId.get(seeded.trackedSheetId)).toBe(1);
      expect(byId.get(seeded.updatedOnlySheetId)).toBe(1);

      // The updated-only sheet's existing `sheet.updated` is
      // untouched — the script appends, never replaces.
      const updatedRows = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c
           FROM atom_events
           WHERE entity_type = 'sheet'
             AND entity_id = $1
             AND event_type = 'sheet.updated'`,
        [seeded.updatedOnlySheetId],
      );
      expect(Number(updatedRows.rows[0].c)).toBe(1);
    });
  });

  it("stamps the synthetic event with the history-backfill actor and backfilled=true payload", async () => {
    await withTestSchema(async (ctx) => {
      const seeded = await seedLegacySplit(ctx);
      await backfill({ dryRun: false }, asBackfillDb(ctx));

      // Pull the synthetic event for the legacy sheet and verify
      // its provenance. Downstream consumers (UI chip, audit log)
      // rely on these two flags to distinguish synthesised events
      // from real ingest events emitted by `snapshot-ingest`.
      const synthetic = await ctx.pool.query<{
        actor: { kind: string; id: string };
        payload: { backfilled?: boolean; sheetNumber?: string };
        occurred_at: Date;
      }>(
        `SELECT actor, payload, occurred_at
           FROM atom_events
           WHERE entity_type = 'sheet'
             AND entity_id = $1
             AND event_type = 'sheet.created'`,
        [seeded.legacySheetId],
      );
      expect(synthetic.rows).toHaveLength(1);
      expect(synthetic.rows[0].actor).toEqual({
        kind: "system",
        id: "history-backfill",
      });
      expect(synthetic.rows[0].payload.backfilled).toBe(true);
      expect(synthetic.rows[0].payload.sheetNumber).toBe("A100");

      // The real event on the tracked sheet must NOT have been
      // overwritten with the synthetic actor — guards a future
      // refactor that accidentally re-stamps already-tracked rows.
      const real = await ctx.pool.query<{
        actor: { kind: string; id: string };
      }>(
        `SELECT actor FROM atom_events
           WHERE entity_type = 'sheet'
             AND entity_id = $1
             AND event_type = 'sheet.created'`,
        [seeded.trackedSheetId],
      );
      expect(real.rows[0].actor.id).toBe("snapshot-ingest");
    });
  });

  it("is idempotent — a second run touches zero rows", async () => {
    await withTestSchema(async (ctx) => {
      await seedLegacySplit(ctx);

      const first = await backfill({ dryRun: false }, asBackfillDb(ctx));
      expect(first.backfilled).toBe(2);
      expect(first.failed).toBe(0);

      // Snapshot the row count so we can prove the second pass
      // didn't append anything new (a regression that, say, dropped
      // the event-type filter from `fetchSheetIdsWithCreatedEvent`
      // would re-stamp every sheet on every deploy).
      const beforeCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );

      const second = await backfill({ dryRun: false }, asBackfillDb(ctx));
      expect(second).toEqual({
        totalSheets: 3,
        alreadyHasCreated: 3,
        backfilled: 0,
        failed: 0,
      });

      const afterCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );
      expect(afterCount.rows[0].c).toBe(beforeCount.rows[0].c);
    });
  });

  it("does not mutate atom_events in --dry-run mode", async () => {
    await withTestSchema(async (ctx) => {
      await seedLegacySplit(ctx);

      const beforeCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );

      const summary = await backfill({ dryRun: true }, asBackfillDb(ctx));
      // The dry-run reports the same "would backfill" tally a real
      // run would produce, so operators see what they're about to
      // commit to before flipping the flag off.
      expect(summary).toEqual({
        totalSheets: 3,
        alreadyHasCreated: 1,
        backfilled: 2,
        failed: 0,
      });

      // …but the table is untouched. If a future change accidentally
      // falls through into the append branch this assertion catches it.
      const afterCount = await ctx.pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM atom_events`,
      );
      expect(afterCount.rows[0].c).toBe(beforeCount.rows[0].c);
    });
  });

  it("reports zero work when there are no sheets at all", async () => {
    await withTestSchema(async (ctx) => {
      // No fixture — the schema is empty. The summary should
      // indicate nothing to do; this guards against a refactor that
      // assumes at least one row exists (e.g. unguarded
      // `rows[0].id`).
      const summary = await backfill({ dryRun: false }, asBackfillDb(ctx));
      expect(summary).toEqual({
        totalSheets: 0,
        alreadyHasCreated: 0,
        backfilled: 0,
        failed: 0,
      });
    });
  });
});
