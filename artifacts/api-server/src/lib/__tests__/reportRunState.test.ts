/**
 * Durable report-run STATE — cross-instance correctness.
 *
 * The bug this fixes: report-run state used to live in three instance-local
 * Maps (inFlightReports / lastReportRunFailure / reportResultCache) in
 * planReviewBff.ts. On multi-instance Cloud Run a status GET that landed on a
 * different instance than the one that ran the job saw `not-run` even though a
 * sibling instance held the real running/failed/done record. The #249
 * watchdog bounded a forever-`running` state but did NOT fix cross-instance
 * visibility.
 *
 * The proof (first test): write run state through ONE drizzle handle and read
 * it back through a SECOND, independent handle on the SAME Postgres schema —
 * two distinct clients, exactly as two Cloud Run instances are two distinct
 * clients against one shared DB. Every write is visible to the other reader.
 *
 * Uses the real-PG tooling (withTestSchema). Requires TEST_DATABASE_URL /
 * DATABASE_URL — skipped-by-tooling / CI-authoritative when unset.
 */

import { describe, it, expect } from "vitest";
import { openSecondHandle, withTestSchema } from "@workspace/db/testing";
import {
  clearReportRun,
  isReportRunStale,
  loadReportRun,
  markReportRunError,
  markReportRunOk,
  markReportRunRunning,
} from "../reportRunState";

const ENGAGEMENT = "11111111-1111-1111-1111-111111111111";

/**
 * A SECOND drizzle handle pointed at the SAME test schema — the stand-in for
 * a second Cloud Run instance (a distinct client against the shared DB).
 */
const secondInstanceDb = openSecondHandle;

describe("durable report-run state — cross-instance", () => {
  it("running record written on instance A is visible on instance B", async () => {
    await withTestSchema(async ({ db: instanceA, schemaName }) => {
      const { db: instanceB, pool: poolB } = secondInstanceDb(schemaName);
      try {
        // Instance A starts a run.
        await markReportRunRunning(
          ENGAGEMENT,
          "topography",
          "gen-1000",
          1_000_000,
          instanceA,
        );

        // Instance B — a DIFFERENT client — reads the same shared row.
        const seen = await loadReportRun(ENGAGEMENT, "topography", instanceB);
        expect(seen).not.toBeNull();
        expect(seen?.status).toBe("running");
        expect(seen?.generationId).toBe("gen-1000");
        expect(seen?.startedAt.getTime()).toBe(1_000_000);
      } finally {
        await poolB.end();
      }
    });
  });

  it("failure written on A carries its true reason to B (not 'not-run')", async () => {
    await withTestSchema(async ({ db: instanceA, schemaName }) => {
      const { db: instanceB, pool: poolB } = secondInstanceDb(schemaName);
      try {
        await markReportRunRunning(
          ENGAGEMENT,
          "drainage",
          "gen-2000",
          2_000_000,
          instanceA,
        );
        await markReportRunError(
          ENGAGEMENT,
          "drainage",
          "no-topography",
          "run topography first",
          "gen-2000",
          instanceA,
        );

        const seen = await loadReportRun(ENGAGEMENT, "drainage", instanceB);
        expect(seen?.status).toBe("error");
        expect(seen?.error).toBe("no-topography");
        expect(seen?.reason).toBe("run topography first");
      } finally {
        await poolB.end();
      }
    });
  });

  it("inline ok+result written on A is readable on B (subsurface path)", async () => {
    await withTestSchema(async ({ db: instanceA, schemaName }) => {
      const { db: instanceB, pool: poolB } = secondInstanceDb(schemaName);
      try {
        await markReportRunOk(ENGAGEMENT, "subsurface", "gen-3000", {
          status: "ok",
          result: { mapunit: "TeC2", pct: 55 },
        });
        const seen = await loadReportRun(ENGAGEMENT, "subsurface", instanceB);
        expect(seen?.status).toBe("ok");
        expect(seen?.result).toEqual({
          status: "ok",
          result: { mapunit: "TeC2", pct: 55 },
        });
      } finally {
        await poolB.end();
      }
    });
  });
});

describe("durable report-run state — status transitions", () => {
  it("running → ok → clear leaves no row (status GET falls through)", async () => {
    await withTestSchema(async ({ db }) => {
      await markReportRunRunning(ENGAGEMENT, "topography", "gen-1", 1_000, db);
      expect((await loadReportRun(ENGAGEMENT, "topography", db))?.status).toBe(
        "running",
      );
      // Materialized-result types clear the row on success.
      await clearReportRun(ENGAGEMENT, "topography", db);
      expect(await loadReportRun(ENGAGEMENT, "topography", db)).toBeNull();
    });
  });

  it("running → error records classifier + reason and stamps finished_at", async () => {
    await withTestSchema(async ({ db }) => {
      await markReportRunRunning(ENGAGEMENT, "drainage", "gen-1", 1_000, db);
      await markReportRunError(
        ENGAGEMENT,
        "drainage",
        "upstream-error",
        "spine 502",
        "gen-1",
        db,
      );
      const row = await loadReportRun(ENGAGEMENT, "drainage", db);
      expect(row?.status).toBe("error");
      expect(row?.error).toBe("upstream-error");
      expect(row?.reason).toBe("spine 502");
      expect(row?.finishedAt).toBeInstanceOf(Date);
    });
  });

  it("a fresh running upsert clears a prior failure's error/reason", async () => {
    await withTestSchema(async ({ db }) => {
      await markReportRunError(
        ENGAGEMENT,
        "drainage",
        "old-error",
        "stale",
        "gen-old",
        db,
      );
      // Retry: the same (engagement, type) upserts back to running and must
      // NOT inherit the prior error/reason.
      await markReportRunRunning(ENGAGEMENT, "drainage", "gen-new", 9_000, db);
      const row = await loadReportRun(ENGAGEMENT, "drainage", db);
      expect(row?.status).toBe("running");
      expect(row?.generationId).toBe("gen-new");
      expect(row?.error).toBeNull();
      expect(row?.reason).toBeNull();
      expect(row?.finishedAt).toBeNull();
    });
  });

  it("upsert is idempotent on the (engagement, report_type) pk — one row", async () => {
    await withTestSchema(async ({ db, pool }) => {
      await markReportRunRunning(ENGAGEMENT, "hazard", "gen-1", 1_000, db);
      await markReportRunRunning(ENGAGEMENT, "hazard", "gen-2", 2_000, db);
      const count = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text c FROM report_run WHERE engagement_id = $1 AND report_type = 'hazard'`,
        [ENGAGEMENT],
      );
      expect(Number(count.rows[0].c)).toBe(1);
      const row = await loadReportRun(ENGAGEMENT, "hazard", db);
      expect(row?.generationId).toBe("gen-2");
    });
  });
});

describe("durable report-run state — stale expiry via the table", () => {
  it("a running row past budget + grace reads stale (cross-instance watchdog)", async () => {
    await withTestSchema(async ({ db }) => {
      const startedAtMs = 1_000_000;
      await markReportRunRunning(
        ENGAGEMENT,
        "topography",
        "gen-1",
        startedAtMs,
        db,
      );
      const row = await loadReportRun(ENGAGEMENT, "topography", db);
      expect(row).not.toBeNull();
      const budgetMs = 10_000;
      // Fresh within budget.
      expect(isReportRunStale(row!, startedAtMs + 5_000, budgetMs)).toBe(false);
      // Stale past budget + grace (30s).
      expect(
        isReportRunStale(row!, startedAtMs + budgetMs + 30_001, budgetMs),
      ).toBe(true);
    });
  });
});
