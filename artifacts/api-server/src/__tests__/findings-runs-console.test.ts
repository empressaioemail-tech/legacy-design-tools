/**
 * Task #493 — Compliance Engine console route tests.
 *
 * Covers `GET /api/findings/runs` (cross-submission feed) and
 * `GET /api/findings/runs/summary` (trailing 30-day rollup).
 *
 * Mirrors `findings-route.test.ts` lifecycle: schema-mocked db,
 * setupRouteTests for the express harness, REVIEWER_HEADERS for
 * the audience-gated endpoints.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("findings-runs-console.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions, findingRuns } = await import(
  "@workspace/db"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_HEADERS = {
  "x-audience": "internal",
  "x-requestor": "user:reviewer-test",
};

beforeEach(() => {
  // Each test seeds its own engagements/runs after the suite-level
  // truncate; nothing to reset here.
});

async function seedEngagementSubmission(name: string, jurisdiction: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction,
      address: "1 Pine St",
      status: "active",
    })
    .returning();
  const [sub] = await ctx.schema.db
    .insert(submissions)
    .values({ engagementId: eng.id, jurisdiction })
    .returning();
  return { engagement: eng, submission: sub };
}

interface SeedRunOpts {
  submissionId: string;
  state: "pending" | "completed" | "failed";
  startedAtIso: string;
  completedAtIso?: string | null;
  error?: string | null;
  invalidCitationCount?: number | null;
  invalidCitations?: string[] | null;
  discardedFindingCount?: number | null;
}

async function seedRun(o: SeedRunOpts) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [row] = await ctx.schema.db
    .insert(findingRuns)
    .values({
      submissionId: o.submissionId,
      state: o.state,
      startedAt: new Date(o.startedAtIso),
      completedAt: o.completedAtIso ? new Date(o.completedAtIso) : null,
      error: o.error ?? null,
      invalidCitationCount: o.invalidCitationCount ?? 0,
      invalidCitations: o.invalidCitations ?? null,
      discardedFindingCount: o.discardedFindingCount ?? 0,
    })
    .returning();
  return row;
}

describe("GET /api/findings/runs — audience gate", () => {
  it("403s on non-internal audience", async () => {
    const res = await request(getApp()).get("/api/findings/runs");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("findings_require_internal_audience");
  });
});

describe("GET /api/findings/runs", () => {
  it("returns recent runs across submissions newest-first with engagement join", async () => {
    const a = await seedEngagementSubmission("Alpha Site", "Bastrop, TX");
    const b = await seedEngagementSubmission("Bravo Site", "Smithville, TX");

    const now = Date.now();
    await seedRun({
      submissionId: a.submission.id,
      state: "completed",
      startedAtIso: new Date(now - 30_000).toISOString(),
      completedAtIso: new Date(now - 25_000).toISOString(),
      invalidCitationCount: 2,
      invalidCitations: ["foo", "bar"],
      discardedFindingCount: 1,
    });
    await seedRun({
      submissionId: b.submission.id,
      state: "failed",
      startedAtIso: new Date(now - 10_000).toISOString(),
      completedAtIso: new Date(now - 5_000).toISOString(),
      error: "engine boom",
    });

    const res = await request(getApp())
      .get("/api/findings/runs")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.runs)).toBe(true);
    expect(res.body.runs).toHaveLength(2);

    // Newest first.
    expect(res.body.runs[0].submissionId).toBe(b.submission.id);
    expect(res.body.runs[0].state).toBe("failed");
    expect(res.body.runs[0].engagementName).toBe("Bravo Site");
    expect(res.body.runs[0].jurisdiction).toBe("Smithville, TX");
    expect(res.body.runs[0].error).toBe("engine boom");
    expect(res.body.runs[0].durationMs).toBe(5_000);

    expect(res.body.runs[1].submissionId).toBe(a.submission.id);
    expect(res.body.runs[1].state).toBe("succeeded"); // completed → succeeded
    expect(res.body.runs[1].invalidCitations).toEqual(["foo", "bar"]);
    expect(res.body.runs[1].invalidCitationCount).toBe(2);
    expect(res.body.runs[1].discardedFindingCount).toBe(1);
    expect(res.body.runs[1].engagementId).toBe(a.engagement.id);
  });

  it("filters by state, mapping succeeded → completed", async () => {
    const a = await seedEngagementSubmission("Alpha", "Bastrop, TX");
    const now = Date.now();
    await seedRun({
      submissionId: a.submission.id,
      state: "completed",
      startedAtIso: new Date(now - 20_000).toISOString(),
      completedAtIso: new Date(now - 15_000).toISOString(),
    });
    await seedRun({
      submissionId: a.submission.id,
      state: "failed",
      startedAtIso: new Date(now - 10_000).toISOString(),
      completedAtIso: new Date(now - 5_000).toISOString(),
      error: "x",
    });

    const succ = await request(getApp())
      .get("/api/findings/runs?state=succeeded")
      .set(REVIEWER_HEADERS);
    expect(succ.status).toBe(200);
    expect(succ.body.runs).toHaveLength(1);
    expect(succ.body.runs[0].state).toBe("succeeded");

    const fail = await request(getApp())
      .get("/api/findings/runs?state=failed")
      .set(REVIEWER_HEADERS);
    expect(fail.status).toBe(200);
    expect(fail.body.runs).toHaveLength(1);
    expect(fail.body.runs[0].state).toBe("failed");
  });

  it("400s on an unknown state filter", async () => {
    const res = await request(getApp())
      .get("/api/findings/runs?state=completed")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_state_filter");
  });

  it("caps to FINDING_RUNS_KEEP_PER_SUBMISSION rows per submission", async () => {
    const a = await seedEngagementSubmission("Alpha", "Bastrop, TX");
    const b = await seedEngagementSubmission("Bravo", "Smithville, TX");
    const now = Date.now();
    // 8 runs for A — should cap at default 5.
    for (let i = 0; i < 8; i++) {
      await seedRun({
        submissionId: a.submission.id,
        state: "completed",
        startedAtIso: new Date(now - (100 - i) * 1000).toISOString(),
        completedAtIso: new Date(now - (99 - i) * 1000).toISOString(),
      });
    }
    // 2 runs for B — should pass through.
    for (let i = 0; i < 2; i++) {
      await seedRun({
        submissionId: b.submission.id,
        state: "completed",
        startedAtIso: new Date(now - (50 - i) * 1000).toISOString(),
        completedAtIso: new Date(now - (49 - i) * 1000).toISOString(),
      });
    }

    const res = await request(getApp())
      .get("/api/findings/runs")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    const perSubmission = new Map<string, number>();
    for (const r of res.body.runs as Array<{ submissionId: string }>) {
      perSubmission.set(
        r.submissionId,
        (perSubmission.get(r.submissionId) ?? 0) + 1,
      );
    }
    expect(perSubmission.get(a.submission.id)).toBe(5);
    expect(perSubmission.get(b.submission.id)).toBe(2);
  });
});

describe("GET /api/findings/runs/summary", () => {
  it("403s on non-internal audience", async () => {
    const res = await request(getApp()).get("/api/findings/runs/summary");
    expect(res.status).toBe(403);
  });

  it("returns null KPI tiles when there are no runs", async () => {
    const res = await request(getApp())
      .get("/api/findings/runs/summary")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalRuns: { value: null, trend: null, trendLabel: null },
      successRate: { value: null, trend: null, trendLabel: null },
      avgDurationMs: { value: null, trend: null, trendLabel: null },
    });
    // With no rows in either window the per-bucket aggregate produces
    // no group at all, so every metric collapses to the null sentinel
    // (same shape as totalRuns). The KPI tile renders "—" in that case.
    expect(res.body.invalidCitationsTotal).toMatchObject({
      value: null,
      trend: null,
      trendLabel: null,
    });
    expect(res.body.discardedFindingsTotal).toMatchObject({
      value: null,
      trend: null,
      trendLabel: null,
    });
  });

  it("rolls up totals, success rate, and avg duration over the trailing 30d", async () => {
    const a = await seedEngagementSubmission("Alpha", "Bastrop, TX");
    const now = Date.now();
    // 2 succeeded, 1 failed, 1 pending — durations 1s + 3s.
    await seedRun({
      submissionId: a.submission.id,
      state: "completed",
      startedAtIso: new Date(now - 60_000).toISOString(),
      completedAtIso: new Date(now - 59_000).toISOString(),
      invalidCitationCount: 1,
      discardedFindingCount: 0,
    });
    await seedRun({
      submissionId: a.submission.id,
      state: "completed",
      startedAtIso: new Date(now - 50_000).toISOString(),
      completedAtIso: new Date(now - 47_000).toISOString(),
      invalidCitationCount: 2,
      discardedFindingCount: 1,
    });
    await seedRun({
      submissionId: a.submission.id,
      state: "failed",
      startedAtIso: new Date(now - 40_000).toISOString(),
      completedAtIso: new Date(now - 39_000).toISOString(),
      error: "x",
      invalidCitationCount: 0,
      discardedFindingCount: 0,
    });
    await seedRun({
      submissionId: a.submission.id,
      state: "pending",
      startedAtIso: new Date(now - 1_000).toISOString(),
    });

    const res = await request(getApp())
      .get("/api/findings/runs/summary")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.totalRuns.value).toBe(4);
    // 2 succeeded out of (2 + 1) judged → 66.66…%
    expect(Math.round(res.body.successRate.value)).toBe(67);
    // (1000 + 3000 + 1000) / 3 = 1666.66… ms
    expect(Math.round(res.body.avgDurationMs.value)).toBe(1667);
    expect(res.body.invalidCitationsTotal.value).toBe(3);
    expect(res.body.discardedFindingsTotal.value).toBe(1);
  });
});
