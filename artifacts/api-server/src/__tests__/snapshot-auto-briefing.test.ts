// Auto-trigger briefing generation on `engagement.created` (Task #448).

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: vi.fn(async () => null),
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    keyFromEngagement: () => null,
    enqueueWarmupForJurisdiction: vi.fn(async () => ({
      enqueued: 0,
      skipped: 0,
    })),
  };
});

const realKickoffPromise = vi.hoisted(async () => {
  return await vi.importActual<typeof import("../routes/parcelBriefings")>(
    "../routes/parcelBriefings",
  );
});
const kickoffSpy = vi.hoisted(() => vi.fn());

vi.mock("../routes/parcelBriefings", async () => {
  const actual = await realKickoffPromise;
  kickoffSpy.mockImplementation(actual.kickoffBriefingGeneration);
  return { ...actual, kickoffBriefingGeneration: kickoffSpy };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  briefingGenerationJobs,
  parcelBriefings,
  briefingSources,
} = await import("@workspace/db");
const { eq, desc } = await import("drizzle-orm");
const { logger } = await import("../lib/logger");
const { kickoffBriefingGeneration } = await import("../routes/parcelBriefings");

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(async () => {
  const actual = await realKickoffPromise;
  kickoffSpy.mockReset();
  kickoffSpy.mockImplementation(actual.kickoffBriefingGeneration);
});

async function waitForJob(
  engagementId: string,
  expected: "completed" | "failed",
  timeoutMs = 2000,
): Promise<typeof briefingGenerationJobs.$inferSelect> {
  if (!ctx.schema) throw new Error("ctx");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await ctx.schema.db
      .select()
      .from(briefingGenerationJobs)
      .where(eq(briefingGenerationJobs.engagementId, engagementId))
      .orderBy(desc(briefingGenerationJobs.startedAt))
      .limit(1);
    if (row?.state === expected) return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`job did not reach ${expected} within ${timeoutMs}ms`);
}

describe("POST /api/snapshots — engagement.created auto-briefing", () => {
  it("ingest returns 201 and invokes the shared kickoff helper for the new engagement", async () => {
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Auto-Briefing Project",
        sheets: [],
      });
    expect(res.status).toBe(201);
    expect(res.body.autoCreated).toBe(true);

    await new Promise((r) => setTimeout(r, 50));

    expect(kickoffSpy).toHaveBeenCalledTimes(1);
    expect(kickoffSpy).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: res.body.engagementId }),
    );
  });

  it("logs structured no-sources warning and inserts no job rows when the new engagement has no briefing", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const warnSpy = vi.spyOn(logger, "warn");

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "No-Sources Project",
        sheets: [],
      });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 100));

    const jobs = await ctx.schema.db
      .select()
      .from(briefingGenerationJobs)
      .where(eq(briefingGenerationJobs.engagementId, res.body.engagementId));
    expect(jobs).toHaveLength(0);

    const skipCall = warnSpy.mock.calls.find(
      ([, msg]) => msg === "auto-briefing: skipped, no briefing sources yet",
    );
    expect(skipCall).toBeTruthy();
    expect(skipCall![0]).toMatchObject({
      engagementId: res.body.engagementId,
      jurisdiction: null,
      error: "no_briefing_sources_for_engagement",
    });

    warnSpy.mockRestore();
  });

  it("does not auto-trigger on the existing-engagement bind branch", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const [existing] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Pre-existing Project",
        nameLower: "pre-existing project",
      })
      .returning();

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({ engagementId: existing.id, sheets: [{ id: 1 }] });
    expect(res.status).toBe(201);
    expect(res.body.autoCreated).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(kickoffSpy).not.toHaveBeenCalled();
  });

  it("a thrown kickoff is caught — engagement still lands and ingest returns 201", async () => {
    if (!ctx.schema) throw new Error("ctx");
    kickoffSpy.mockImplementationOnce(async () => {
      throw new Error("simulated adapter timeout");
    });

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Failing Project",
        sheets: [],
      });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 100));

    const engs = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(engs).toHaveLength(1);
  });

  it("structured generation-failed log fires when onSettled reports a failed terminal state", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    kickoffSpy.mockImplementationOnce(async (args) => {
      queueMicrotask(() => {
        void args.onSettled?.({
          state: "failed",
          generationId: "00000000-0000-0000-0000-000000000fa1",
          error: "simulated engine timeout",
        });
      });
      return {
        kind: "started",
        generationId: "00000000-0000-0000-0000-000000000fa1",
        sourceCount: 1,
      };
    });

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Engine-Fails Project",
        sheets: [],
      });
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 100));

    const failedCall = errorSpy.mock.calls.find(
      ([, msg]) => msg === "auto-briefing: generation failed",
    );
    expect(failedCall).toBeTruthy();
    expect(failedCall![0]).toMatchObject({
      engagementId: res.body.engagementId,
      jurisdiction: null,
      generationId: "00000000-0000-0000-0000-000000000fa1",
      error: "simulated engine timeout",
    });

    errorSpy.mockRestore();
  });
});

describe("kickoffBriefingGeneration — end-to-end success path", () => {
  it("auto-trigger inserts a generation-job row and runs to completion when briefing + sources exist", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Auto Success Engagement",
        nameLower: "auto success engagement",
        jurisdiction: "Boulder, CO",
        address: "1 Pearl St",
      })
      .returning();
    const [briefing] = await ctx.schema.db
      .insert(parcelBriefings)
      .values({ engagementId: eng.id })
      .returning();
    await ctx.schema.db.insert(briefingSources).values({
      briefingId: briefing.id,
      layerKind: "qgis-zoning",
      sourceKind: "manual-upload",
      provider: "City of Boulder QGIS",
      note: "test seed",
      uploadObjectPath: "/objects/zoning",
      uploadOriginalFilename: "zoning.geojson",
      uploadContentType: "application/geo+json",
      uploadByteSize: 1024,
      snapshotDate: new Date("2026-01-01T00:00:00Z"),
    });

    const settled: Array<{ state: string; error: string | null }> = [];
    const outcome = await kickoffBriefingGeneration({
      engagementId: eng.id,
      reqLog: logger,
      onSettled: (s) => {
        settled.push({ state: s.state, error: s.error });
      },
    });

    expect(outcome.kind).toBe("started");
    const job = await waitForJob(eng.id, "completed");
    expect(job.state).toBe("completed");
    expect(job.completedAt).toBeTruthy();

    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toEqual([{ state: "completed", error: null }]);
  });
});
