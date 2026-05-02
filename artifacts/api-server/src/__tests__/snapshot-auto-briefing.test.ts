/**
 * POST /api/snapshots — auto-trigger briefing on `engagement.created`
 * (Task #448).
 *
 * The snapshot ingest's create-new branch fires
 * {@link kickoffBriefingGeneration} via a `void`-launched subscriber so
 * the architect lands on the engagement detail page and sees Site
 * Context populating without clicking "Generate Layers". This file
 * pins the contract:
 *
 *   - the ingest response is not blocked by briefing work
 *     (snapshot-ingest still returns 201 with `autoCreated: true`);
 *   - the auto-trigger calls the same shared kickoff helper the
 *     manual `POST /briefing/generate` route uses (verified with a
 *     `vi.spyOn` on the helper);
 *   - the auto-trigger NEVER fires on the existing-engagement bind
 *     branch (autoCreated=false);
 *   - a kickoff that throws is caught and logged with structured
 *     fields `{ engagementId, jurisdiction, error }` and the snapshot
 *     ingest still returns 201 with no briefing rows persisted.
 *
 * Geocoding is mocked to return null so the create-new branch's
 * best-effort geocode/warmup path does not hit the real network. The
 * `kickoffBriefingGeneration` helper is the real implementation under
 * test — we wrap it in a spy so we can assert it was called with the
 * freshly-created engagement id, but we do not stub its body except
 * in the failure-path test.
 */

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
      if (!ctx.schema)
        throw new Error("snapshot-auto-briefing.test: ctx.schema not set");
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

// Briefing-engine mock that the engine-failure test below flips on.
// Default behavior delegates to the real mock generator so the rest
// of the suite (which never reaches the engine because no briefing
// row exists) is unaffected.
const generateBriefingMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => {
    throw new Error("generateBriefing default mock — should not be reached");
  }),
);
vi.mock("@workspace/briefing-engine", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/briefing-engine")>(
      "@workspace/briefing-engine",
    );
  return {
    ...actual,
    generateBriefing: (...args: Parameters<typeof actual.generateBriefing>) =>
      generateBriefingMock(...args),
  };
});

// Wrap `kickoffBriefingGeneration` in a spy that defaults to the real
// implementation. Tests can override per-case via `mockImplementationOnce`
// to force a throw without touching the manual-route's tests. The mock
// factory returns the wrapped helper as the module's exported value;
// snapshots.ts imports the same module and so picks up the spy.
const realKickoffPromise = vi.hoisted(async () => {
  const actual =
    await vi.importActual<typeof import("../routes/parcelBriefings")>(
      "../routes/parcelBriefings",
    );
  return actual;
});
const kickoffSpy = vi.hoisted(() => vi.fn());

vi.mock("../routes/parcelBriefings", async () => {
  const actual = await realKickoffPromise;
  kickoffSpy.mockImplementation(actual.kickoffBriefingGeneration);
  return {
    ...actual,
    kickoffBriefingGeneration: kickoffSpy,
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  briefingGenerationJobs,
  parcelBriefings,
  briefingSources,
} = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { logger } = await import("../lib/logger");

const SECRET = process.env["SNAPSHOT_SECRET"]!;

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(async () => {
  // Reset the spy so call counts / overrides do not leak across
  // tests; the default implementation is restored on the next call
  // via the mock factory's closure.
  const actual = await realKickoffPromise;
  kickoffSpy.mockReset();
  kickoffSpy.mockImplementation(actual.kickoffBriefingGeneration);
});

describe("POST /api/snapshots — engagement.created auto-briefing", () => {
  it("create-new branch returns 201 immediately and invokes the shared kickoff helper for the freshly-created engagement", async () => {
    const start = Date.now();
    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Auto-Briefing Project",
        sheets: [],
      });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(201);
    expect(res.body.autoCreated).toBe(true);
    // Generous bound — the auto-trigger is fire-and-forget so the
    // ingest response should not be paying the cost of a DB
    // briefing-row lookup before returning. 5s is plenty even on a
    // slow CI host; what we are pinning is "no synchronous wait on
    // briefing work", not a tight latency budget.
    expect(elapsed).toBeLessThan(5000);

    // Allow the void-launched subscriber's microtask to drain.
    await new Promise((r) => setTimeout(r, 50));

    // The shared helper was invoked with the freshly-created
    // engagement id — proves the auto-trigger wired through to the
    // same code path the manual `POST /briefing/generate` route uses.
    expect(kickoffSpy).toHaveBeenCalledTimes(1);
    expect(kickoffSpy).toHaveBeenCalledWith(
      expect.objectContaining({ engagementId: res.body.engagementId }),
    );
  });

  it("a freshly-created engagement with no briefing/sources cleanly no-ops (no generation-job row inserted)", async () => {
    if (!ctx.schema) throw new Error("ctx");
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

    // The helper hit `no_briefing_sources_for_engagement` and
    // returned cleanly. No `briefing_generation_jobs` row was
    // inserted, no `parcel_briefings` row was conjured, the
    // engagement is still there, and the snapshot was persisted.
    const jobs = await ctx.schema.db
      .select()
      .from(briefingGenerationJobs)
      .where(eq(briefingGenerationJobs.engagementId, res.body.engagementId));
    expect(jobs).toHaveLength(0);
    const briefs = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.engagementId, res.body.engagementId));
    expect(briefs).toHaveLength(0);
    const engs = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(engs).toHaveLength(1);
  });

  it("does NOT auto-trigger on the existing-engagement bind branch (autoCreated=false)", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const [existing] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Pre-existing Project",
        nameLower: "pre-existing project",
        address: "100 Existing Ave",
      })
      .returning();

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        engagementId: existing.id,
        sheets: [{ id: 1 }],
      });
    expect(res.status).toBe(201);
    expect(res.body.autoCreated).toBe(false);

    await new Promise((r) => setTimeout(r, 50));

    expect(kickoffSpy).not.toHaveBeenCalled();
  });

  it("structured `auto-briefing: generation failed` log fires when the async runner reports a failed terminal state", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const errorSpy = vi.spyOn(logger, "error");
    // Override the helper to simulate a successful kickoff (a real
    // briefing-generation job row was inserted and the runner is
    // executing) followed by an asynchronous failed terminal state.
    // The snapshot.ts subscriber's `onSettled` callback is what we
    // are exercising here — it must emit a structured
    // `{ engagementId, jurisdiction, error }` log so operators can
    // grep auto-trigger failures without first correlating across
    // engagement+briefing ids.
    kickoffSpy.mockImplementationOnce(async (args) => {
      // Fire the subscriber on a microtask so the kickoff path
      // returns to the snapshot-ingest response first — this
      // mirrors the real helper, where onSettled fires after the
      // void-launched runner finalizes the job row.
      queueMicrotask(() => {
        void args.onSettled?.({
          state: "failed",
          generationId: "00000000-0000-0000-0000-000000000fa1",
          error: "simulated adapter timeout",
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

    // Allow the queued microtask + async logger call to settle.
    await new Promise((r) => setTimeout(r, 100));

    const failedCall = errorSpy.mock.calls.find(
      ([, msg]) => msg === "auto-briefing: generation failed",
    );
    expect(failedCall, "expected a structured generation-failed log").toBeTruthy();
    expect(failedCall![0]).toMatchObject({
      engagementId: res.body.engagementId,
      jurisdiction: null,
      generationId: "00000000-0000-0000-0000-000000000fa1",
      error: "simulated adapter timeout",
    });

    // Engagement still in place — failure on the briefing side never
    // unwinds the engagement creation.
    const engs = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(engs).toHaveLength(1);

    errorSpy.mockRestore();
  });

  it("a failing kickoff is caught — engagement stays created, no briefing rows surface, snapshot ingest still returns 201", async () => {
    if (!ctx.schema) throw new Error("ctx");
    kickoffSpy.mockImplementationOnce(async () => {
      throw new Error("simulated adapter timeout");
    });

    const res = await request(getApp())
      .post("/api/snapshots")
      .set("x-snapshot-secret", SECRET)
      .send({
        createNewEngagement: true,
        projectName: "Failing-Auto-Briefing Project",
        sheets: [],
      });
    expect(res.status).toBe(201);
    expect(res.body.autoCreated).toBe(true);

    await new Promise((r) => setTimeout(r, 100));

    // The helper threw, but the engagement stayed in place and no
    // briefing rows were conjured behind it.
    const engs = await ctx.schema.db
      .select()
      .from(engagements)
      .where(eq(engagements.id, res.body.engagementId));
    expect(engs).toHaveLength(1);
    const jobs = await ctx.schema.db
      .select()
      .from(briefingGenerationJobs)
      .where(eq(briefingGenerationJobs.engagementId, res.body.engagementId));
    expect(jobs).toHaveLength(0);
    const briefs = await ctx.schema.db
      .select()
      .from(parcelBriefings)
      .where(eq(parcelBriefings.engagementId, res.body.engagementId));
    expect(briefs).toHaveLength(0);
  });
});
