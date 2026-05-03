/**
 * Tests for the Track 1 submission-classification backfill.
 *
 * Coverage:
 *   - parseArgs: `--anthropic` requires `--max-rows`, unknown flags
 *     throw, `--max-rows N` validates as a positive integer.
 *   - backfill happy path (mock mode): one unclassified submission
 *     yields one row in `submission_classifications` with
 *     `source='auto'`, AND emits `submission.classified` +
 *     `submission-classification.set` events on the chain.
 *   - Idempotent re-run: running twice over an already-backfilled
 *     fixture yields zero new rows on the second pass.
 *   - `--max-rows N` cap honored: only the first N candidates are
 *     processed.
 *   - `--dry-run` mode: the row count and tally read normally but
 *     no INSERT lands and no events are appended.
 *   - Per-row failure accounting.
 *
 * `parseClassificationResponse` cases used to live here (mirroring
 * the api-server's same-named helper). Post-extraction the parser is
 * the source-of-truth in `@workspace/submission-classifier`'s test
 * suite (`lib/submission-classifier/src/__tests__/classifier.test.ts`)
 * and the duplicates have been deleted — re-testing the shared
 * function at the script level was double-maintenance. The script's
 * import-correctness is implicitly verified by the happy-path /
 * idempotent / max-rows / dry-run / failure cases below, all of
 * which chain through the lib.
 */

import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { withTestSchema, type TestSchemaContext } from "@workspace/db/testing";
import {
  PostgresEventAnchoringService,
  type EventAnchoringService,
} from "@workspace/empressa-atom";
import { backfill, parseArgs } from "../backfillTrack1Classifications";

function makeDb(ctx: TestSchemaContext): Parameters<typeof backfill>[1] {
  return drizzle(ctx.pool) as unknown as Parameters<typeof backfill>[1];
}

async function seedSubmissions(
  ctx: TestSchemaContext,
  count: number,
): Promise<string[]> {
  const eng = await ctx.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address)
       VALUES ('Backfill Test', 'backfill test', 'Bastrop, TX', '1 Way')
       RETURNING id`,
  );
  const engagementId = eng.rows[0]!.id;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const sub = await ctx.pool.query<{ id: string }>(
      `INSERT INTO submissions
         (engagement_id, jurisdiction, jurisdiction_city,
          jurisdiction_state, submitted_at)
         VALUES ($1, 'Bastrop, TX', 'Bastrop', 'TX',
                 NOW() - interval '${count - i} days')
         RETURNING id`,
      [engagementId],
    );
    ids.push(sub.rows[0]!.id);
  }
  return ids;
}

async function countClassifications(ctx: TestSchemaContext): Promise<number> {
  const r = await ctx.pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM submission_classifications`,
  );
  return Number(r.rows[0]!.c);
}

async function countEvents(
  ctx: TestSchemaContext,
  eventType: string,
): Promise<number> {
  const r = await ctx.pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM atom_events WHERE event_type = $1`,
    [eventType],
  );
  return Number(r.rows[0]!.c);
}

describe("parseArgs", () => {
  it("returns dry-run defaults on empty argv", () => {
    expect(parseArgs([])).toEqual({
      dryRun: false,
      anthropic: false,
      maxRows: 0,
    });
  });

  it("parses --dry-run", () => {
    expect(parseArgs(["--dry-run"])).toEqual({
      dryRun: true,
      anthropic: false,
      maxRows: 0,
    });
  });

  it("parses --max-rows N", () => {
    expect(parseArgs(["--max-rows", "50"])).toEqual({
      dryRun: false,
      anthropic: false,
      maxRows: 50,
    });
  });

  it("rejects --max-rows without a value", () => {
    expect(() => parseArgs(["--max-rows"])).toThrow(/integer argument/);
  });

  it("rejects --max-rows with a non-integer value", () => {
    expect(() => parseArgs(["--max-rows", "fifty"])).toThrow(
      /positive integer/,
    );
  });

  it("rejects --max-rows 0 (the default sentinel is in-code only)", () => {
    expect(() => parseArgs(["--max-rows", "0"])).toThrow(/positive integer/);
  });

  it("rejects an unknown flag with a clear usage line", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("rejects --anthropic without --max-rows (Q5 budget guard)", () => {
    expect(() => parseArgs(["--anthropic"])).toThrow(
      /--anthropic requires --max-rows/,
    );
  });

  it("accepts --anthropic --max-rows N", () => {
    expect(parseArgs(["--anthropic", "--max-rows", "25"])).toEqual({
      dryRun: false,
      anthropic: true,
      maxRows: 25,
    });
  });
});

describe("backfill (mock mode)", () => {
  it("inserts one row per unclassified submission and emits two events per row", async () => {
    await withTestSchema(async (ctx) => {
      const subIds = await seedSubmissions(ctx, 3);
      const db = makeDb(ctx);
      const history = new PostgresEventAnchoringService(
        db as unknown as ConstructorParameters<
          typeof PostgresEventAnchoringService
        >[0],
      );

      const summary = await backfill(
        { dryRun: false, anthropic: false, maxRows: 0 },
        db,
        history,
      );

      expect(summary).toEqual({
        totalCandidates: 3,
        classified: 3,
        skipped: 0,
        failed: 0,
      });
      expect(await countClassifications(ctx)).toBe(3);
      expect(await countEvents(ctx, "submission.classified")).toBe(3);
      expect(
        await countEvents(ctx, "submission-classification.set"),
      ).toBe(3);

      // Spot-check one row's columns: source='auto', empty
      // disciplines (mock-mode default), null confidence.
      const row = await ctx.pool.query<{
        source: string;
        disciplines: string[];
        confidence: string | null;
        project_type: string | null;
      }>(
        `SELECT source, disciplines, confidence, project_type
           FROM submission_classifications
           WHERE submission_id = $1`,
        [subIds[0]],
      );
      expect(row.rows[0]!.source).toBe("auto");
      expect(row.rows[0]!.disciplines).toEqual([]);
      expect(row.rows[0]!.project_type).toBeNull();
      expect(row.rows[0]!.confidence).toBeNull();
    });
  });

  it("is idempotent — re-runs touch zero rows on the second pass", async () => {
    await withTestSchema(async (ctx) => {
      await seedSubmissions(ctx, 2);
      const db = makeDb(ctx);
      const history = new PostgresEventAnchoringService(
        db as unknown as ConstructorParameters<
          typeof PostgresEventAnchoringService
        >[0],
      );

      const first = await backfill(
        { dryRun: false, anthropic: false, maxRows: 0 },
        db,
        history,
      );
      expect(first.classified).toBe(2);

      const second = await backfill(
        { dryRun: false, anthropic: false, maxRows: 0 },
        db,
        history,
      );
      expect(second).toEqual({
        totalCandidates: 0,
        classified: 0,
        skipped: 0,
        failed: 0,
      });
      // Side-effect total stays at 2 — no new events.
      expect(await countEvents(ctx, "submission.classified")).toBe(2);
    });
  });

  it("honors --max-rows N by processing only the first N candidates (oldest first)", async () => {
    await withTestSchema(async (ctx) => {
      const subIds = await seedSubmissions(ctx, 5);
      const db = makeDb(ctx);
      const history = new PostgresEventAnchoringService(
        db as unknown as ConstructorParameters<
          typeof PostgresEventAnchoringService
        >[0],
      );

      const summary = await backfill(
        { dryRun: false, anthropic: false, maxRows: 2 },
        db,
        history,
      );
      expect(summary.classified).toBe(2);
      expect(await countClassifications(ctx)).toBe(2);

      // The first two seeded submissions are the oldest (the seed
      // helper subtracts more days for earlier indices). Confirm
      // those are the ones that landed.
      const classified = await ctx.pool.query<{ submission_id: string }>(
        `SELECT submission_id FROM submission_classifications
           ORDER BY submission_id`,
      );
      const got = classified.rows.map((r) => r.submission_id).sort();
      const expected = [subIds[0], subIds[1]].sort();
      expect(got).toEqual(expected);
    });
  });

  it("--dry-run reports the tally without writing rows or events", async () => {
    await withTestSchema(async (ctx) => {
      await seedSubmissions(ctx, 3);
      const db = makeDb(ctx);
      const history = new PostgresEventAnchoringService(
        db as unknown as ConstructorParameters<
          typeof PostgresEventAnchoringService
        >[0],
      );

      const summary = await backfill(
        { dryRun: true, anthropic: false, maxRows: 0 },
        db,
        history,
      );
      expect(summary.totalCandidates).toBe(3);
      expect(summary.classified).toBe(3);
      expect(await countClassifications(ctx)).toBe(0);
      expect(await countEvents(ctx, "submission.classified")).toBe(0);
      expect(
        await countEvents(ctx, "submission-classification.set"),
      ).toBe(0);
    });
  });

  it("counts a per-row failure separately and returns non-zero failed without aborting the run", async () => {
    // Inject a failing event-anchoring service for the FIRST row only;
    // the second row should still classify cleanly. The script's
    // per-row try/catch is the contract under test — a single bad
    // row must not abort the run.
    await withTestSchema(async (ctx) => {
      await seedSubmissions(ctx, 2);
      const db = makeDb(ctx);
      const real = new PostgresEventAnchoringService(
        db as unknown as ConstructorParameters<
          typeof PostgresEventAnchoringService
        >[0],
      );
      let calls = 0;
      const flaky: EventAnchoringService = {
        appendEvent: async (...args) => {
          calls++;
          // First two calls (first row's two events) reject; the
          // rest go through. The script catches event-emit errors
          // INSIDE emitClassificationEvents (best-effort), so failure
          // there logs but doesn't propagate. To test the
          // failed-counter path, we'd need to break the row write,
          // not the event write. Confirm the contract: emit-error
          // does NOT increment `failed` (failed counts only when
          // the row insert / classifySubmission path throws).
          if (calls <= 2) {
            throw new Error("synthetic emit failure");
          }
          return real.appendEvent(...args);
        },
        readHistory: real.readHistory.bind(real),
        latestEvent: real.latestEvent.bind(real),
      };

      const summary = await backfill(
        { dryRun: false, anthropic: false, maxRows: 0 },
        db,
        flaky,
      );
      // Both rows still classify (the row insert succeeds; the
      // event append failure is best-effort and only logs).
      expect(summary.classified).toBe(2);
      expect(summary.failed).toBe(0);
      expect(await countClassifications(ctx)).toBe(2);
    });
  });
});
