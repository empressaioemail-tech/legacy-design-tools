/**
 * /api/engagements/:id/bim-model + /api/bim-models/:id/* — DA-PI-5
 * Revit sensor materialization route tests.
 *
 * Covers the contract the four routes own:
 *   - GET on a fresh engagement returns `{ bimModel: null }` and
 *     does NOT create a row as a side effect.
 *   - First POST creates the bim-model row (server-side resolves
 *     the active briefing) and emits `bim-model.materialized`.
 *   - Second POST is idempotent at the engagement-id level: it
 *     updates the existing row's `materializedAt` instead of
 *     inserting a duplicate.
 *   - POST refuses (400) when the engagement has no active
 *     briefing.
 *   - GET /bim-models/:id/refresh returns the three statuses
 *     correctly (current / stale / not-pushed) and emits
 *     `bim-model.refreshed` on every poll.
 *   - POST /bim-models/:id/divergence rejects requests without the
 *     HMAC headers (400/401), accepts a correctly-signed body,
 *     inserts the row, and emits both `briefing-divergence.recorded`
 *     and `bim-model.diverged`.
 *   - POST /bim-models/:id/divergences/:divergenceId/resolve emits a
 *     `briefing-divergence.resolved` atom event on the *first*
 *     resolve (and only the first — an idempotent re-resolve does
 *     not double-emit), and *also* fans the resolve into the parent
 *     bim-model timeline as `bim-model.divergence-resolved` so the
 *     engagement-level view picks the acknowledgement up without
 *     walking per-divergence chains (Task #267) — also single-emit
 *     across an idempotent re-resolve.
 *   - 404 paths for unknown bim-model id, unknown element, and
 *     element belonging to a non-active briefing.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createHmac } from "node:crypto";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("bim-models.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const {
  engagements,
  parcelBriefings,
  bimModels,
  materializableElements,
  briefingDivergences,
  atomEvents,
  users,
} = await import("@workspace/db");
const { eq, desc } = await import("drizzle-orm");

const TEST_HMAC_SECRET = "bim-model-test-secret";

beforeAll(() => {
  process.env.BIM_MODEL_SHARED_SECRET = TEST_HMAC_SECRET;
});

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagementAndBriefing(
  name = "Bim-Model Route Engagement",
): Promise<{ engagementId: string; briefingId: string }> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Boulder, CO",
      address: "1 Pearl St",
      status: "active",
    })
    .returning();
  const [briefing] = await db
    .insert(parcelBriefings)
    .values({ engagementId: eng.id })
    .returning();
  return { engagementId: eng.id, briefingId: briefing.id };
}

function signDivergence(requestId: string, bimModelId: string): string {
  return createHmac("sha256", TEST_HMAC_SECRET)
    .update(`${requestId}.${bimModelId}`)
    .digest("hex");
}

/**
 * Send the dev-only `x-audience: internal` header so the architect-
 * scoped guard on the bim-model routes lets the request through. The
 * sessionMiddleware fails closed in production but honors this header
 * in test/dev — see `middlewares/session.ts`. Every architect-facing
 * call in this file must set the header; the divergence route does
 * NOT need it (it has its own HMAC trust contract).
 */
const ARCHITECT_AUDIENCE_HEADER = ["x-audience", "internal"] as const;

function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req.set(ARCHITECT_AUDIENCE_HEADER[0], ARCHITECT_AUDIENCE_HEADER[1]);
}

describe("GET /api/engagements/:id/bim-model", () => {
  it("returns { bimModel: null } before any push", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const res = await asArchitect(
      request(getApp()).get(`/api/engagements/${engagementId}/bim-model`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bimModel: null });

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const rows = await ctx.schema.db
      .select()
      .from(bimModels)
      .where(eq(bimModels.engagementId, engagementId));
    expect(rows).toHaveLength(0);
  });

  it("404s when the engagement does not exist", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/engagements/00000000-0000-0000-0000-000000000000/bim-model`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("403s when the caller is not architect-audience (default applicant session)", async () => {
    // No `x-audience: internal` header → the request lands as the
    // anonymous applicant default the sessionMiddleware emits, and
    // the architect-scoped guard refuses to surface the bim-model.
    const { engagementId } = await seedEngagementAndBriefing();
    const res = await request(getApp()).get(
      `/api/engagements/${engagementId}/bim-model`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
  });
});

describe("POST /api/engagements/:id/bim-model", () => {
  it("creates the bim-model row + emits bim-model.materialized", async () => {
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const res = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    expect(res.status).toBe(200);
    expect(res.body.bimModel.engagementId).toBe(engagementId);
    expect(res.body.bimModel.activeBriefingId).toBe(briefingId);
    expect(res.body.bimModel.materializedAt).toBeTruthy();
    expect(res.body.bimModel.refreshStatus).toBe("current");

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, res.body.bimModel.id))
      .orderBy(desc(atomEvents.occurredAt));
    expect(events.some((e) => e.eventType === "bim-model.materialized")).toBe(
      true,
    );
  });

  it("403s when the caller is not architect-audience", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const res = await request(getApp())
      .post(`/api/engagements/${engagementId}/bim-model`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
  });

  it("is idempotent at the engagement-id level (re-push updates, not inserts)", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const first = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    expect(first.status).toBe(200);
    const firstId = first.body.bimModel.id as string;

    // Sleep 5ms so the second push has a strictly-later
    // materializedAt without depending on the OS clock granularity.
    await new Promise((r) => setTimeout(r, 5));

    const second = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({ revitDocumentPath: "/projects/site.rvt" });
    expect(second.status).toBe(200);
    expect(second.body.bimModel.id).toBe(firstId);
    expect(second.body.bimModel.revitDocumentPath).toBe("/projects/site.rvt");
    expect(
      new Date(second.body.bimModel.materializedAt).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(first.body.bimModel.materializedAt).getTime(),
    );

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const rows = await ctx.schema.db
      .select()
      .from(bimModels)
      .where(eq(bimModels.engagementId, engagementId));
    expect(rows).toHaveLength(1);
  });

  it("400s when the engagement has no parcel briefing", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [eng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Engagement Without Briefing",
        nameLower: "engagement-without-briefing",
        jurisdiction: "Boulder, CO",
        address: "5 Pearl St",
        status: "active",
      })
      .returning();
    const res = await asArchitect(
      request(getApp()).post(`/api/engagements/${eng.id}/bim-model`),
    ).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("engagement_has_no_active_briefing");
  });
});

describe("GET /api/bim-models/:id/refresh", () => {
  it("returns refreshStatus current and an empty diff after a fresh push (no elements yet)", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    const res = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/refresh`),
    );
    expect(res.status).toBe(200);
    expect(res.body.refreshStatus).toBe("current");
    expect(res.body.bimModelId).toBe(bimModelId);
    expect(res.body.engagementId).toBe(engagementId);
    expect(res.body.diff).toBeDefined();
    expect(res.body.diff.elements).toEqual([]);
    expect(res.body.diff.addedCount).toBe(0);
    expect(res.body.diff.modifiedCount).toBe(0);
    expect(res.body.diff.unchangedCount).toBe(0);
  });

  it("returns refreshStatus stale + reports the per-element delta when the briefing is updated after the push", async () => {
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Insert an element strictly *after* the push so it's reported
    // as `added`. computeElementDiff keys off createdAt vs
    // materializedAt, so the test makes the inequality unambiguous.
    const futureTs = new Date(Date.now() + 60_000);
    await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId,
        elementKind: "buildable-envelope",
        label: "Late envelope",
        createdAt: futureTs,
        updatedAt: futureTs,
      });
    // Bump the briefing's updatedAt to be strictly after the push.
    await ctx.schema.db
      .update(parcelBriefings)
      .set({ updatedAt: futureTs })
      .where(eq(parcelBriefings.id, briefingId));

    const res = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/refresh`),
    );
    expect(res.status).toBe(200);
    expect(res.body.refreshStatus).toBe("stale");
    expect(res.body.diff.elements).toHaveLength(1);
    expect(res.body.diff.elements[0]).toMatchObject({
      diffStatus: "added",
      elementKind: "buildable-envelope",
      label: "Late envelope",
    });
    expect(res.body.diff.addedCount).toBe(1);
    expect(res.body.diff.modifiedCount).toBe(0);
    expect(res.body.diff.unchangedCount).toBe(0);
  });

  it("emits bim-model.refreshed on every poll", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/refresh`),
    );

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bimModelId));
    expect(events.some((e) => e.eventType === "bim-model.refreshed")).toBe(
      true,
    );
  });

  it("404s on unknown bim-model id", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/bim-models/00000000-0000-0000-0000-000000000000/refresh`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("bim_model_not_found");
  });

  it("403s when the caller is not architect-audience", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    const res = await request(getApp()).get(
      `/api/bim-models/${bimModelId}/refresh`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
  });
});

describe("GET /api/bim-models/:id/divergences", () => {
  it("returns an empty list when nothing has been recorded yet", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    const res = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/divergences`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ divergences: [] });
  });

  it("returns recorded divergences newest-first joined with element kind+label", async () => {
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [elem] = await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId,
        elementKind: "buildable-envelope",
        label: "North envelope",
        geometry: { ring: [] },
      })
      .returning();

    // Two divergences with explicit createdAt timestamps so the
    // newest-first ordering assertion is independent of clock
    // granularity.
    await ctx.schema.db.insert(briefingDivergences).values([
      {
        bimModelId,
        materializableElementId: elem.id,
        briefingId,
        reason: "geometry-edited",
        note: "moved a vertex",
        detail: { revitElementId: 12345 },
        createdAt: new Date("2026-04-01T12:00:00Z"),
      },
      {
        bimModelId,
        materializableElementId: elem.id,
        briefingId,
        reason: "unpinned",
        note: null,
        detail: {},
        createdAt: new Date("2026-04-02T12:00:00Z"),
      },
    ]);

    const res = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/divergences`),
    );
    expect(res.status).toBe(200);
    expect(res.body.divergences).toHaveLength(2);
    expect(res.body.divergences[0].reason).toBe("unpinned");
    expect(res.body.divergences[1].reason).toBe("geometry-edited");
    expect(res.body.divergences[0].elementKind).toBe("buildable-envelope");
    expect(res.body.divergences[0].elementLabel).toBe("North envelope");
    expect(res.body.divergences[1].note).toBe("moved a vertex");
    expect(res.body.divergences[1].detail).toMatchObject({
      revitElementId: 12345,
    });
  });

  it("404s on unknown bim-model id", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/bim-models/00000000-0000-0000-0000-000000000000/divergences`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("bim_model_not_found");
  });

  it("403s when the caller is not architect-audience", async () => {
    const { engagementId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    const res = await request(getApp()).get(
      `/api/bim-models/${bimModelId}/divergences`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
  });
});

describe("POST /api/bim-models/:id/divergences/:divergenceId/resolve", () => {
  /**
   * Helper that pushes a bim-model, seeds a materializable element,
   * and inserts a single open divergence row pointing at it.
   * Returns everything the resolve assertions need so each test can
   * stay short.
   */
  async function setupOpenDivergence(): Promise<{
    bimModelId: string;
    divergenceId: string;
    elementId: string;
  }> {
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [elem] = await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId,
        elementKind: "buildable-envelope",
        label: "North envelope",
      })
      .returning();
    const [div] = await ctx.schema.db
      .insert(briefingDivergences)
      .values({
        bimModelId,
        materializableElementId: elem.id,
        briefingId,
        reason: "geometry-edited",
        note: "moved a vertex",
        detail: { revitElementId: 12345 },
      })
      .returning();
    return { bimModelId, divergenceId: div.id, elementId: elem.id };
  }

  it("marks an open divergence resolved + attributes to the session requestor", async () => {
    const { bimModelId, divergenceId } = await setupOpenDivergence();

    const before = Date.now();
    const res = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:operator-1");
    expect(res.status).toBe(200);

    const wire = res.body.divergence;
    expect(wire.id).toBe(divergenceId);
    expect(wire.resolvedAt).not.toBeNull();
    expect(new Date(wire.resolvedAt).getTime()).toBeGreaterThanOrEqual(before);
    // `kind` / `id` are the contract guaranteed by the resolve
    // route. The optional `displayName` (Task #212) is exercised by
    // the dedicated hydration test below — here we deliberately
    // tolerate its presence/absence because the session middleware's
    // profile backfill is fire-and-forget and racy in tests.
    expect(wire.resolvedByRequestor).toMatchObject({
      kind: "user",
      id: "operator-1",
    });
    // The list-entry shape should ride along (so the FE can splice
    // the response into the cache without a follow-up fetch).
    expect(wire.elementKind).toBe("buildable-envelope");
    expect(wire.elementLabel).toBe("North envelope");

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [row] = await ctx.schema.db
      .select()
      .from(briefingDivergences)
      .where(eq(briefingDivergences.id, divergenceId));
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolvedByRequestorKind).toBe("user");
    expect(row.resolvedByRequestorId).toBe("operator-1");
  });

  it("is idempotent: re-resolving keeps the original timestamp + requestor", async () => {
    const { bimModelId, divergenceId } = await setupOpenDivergence();

    const first = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:first-operator");
    expect(first.status).toBe(200);
    const firstResolvedAt = first.body.divergence.resolvedAt as string;

    // Second call by a *different* requestor must not overwrite the
    // first acknowledger's attribution — the original audit trail
    // sticks.
    const second = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:second-operator");
    expect(second.status).toBe(200);
    expect(second.body.divergence.resolvedAt).toBe(firstResolvedAt);
    expect(second.body.divergence.resolvedByRequestor).toMatchObject({
      kind: "user",
      id: "first-operator",
    });
  });

  it("manually-resolved rows survive a re-push to Revit", async () => {
    // Spec call-out (Task #191): "manually-Resolved rows stay
    // Resolved unless re-recorded". Resolve a row, then trigger a
    // second push (which is the moment most likely to clobber
    // resolve state) and assert the row is still flagged Resolved.
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const firstPush = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = firstPush.body.bimModel.id as string;

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [elem] = await ctx.schema.db
      .insert(materializableElements)
      .values({ briefingId, elementKind: "terrain", label: "Site terrain" })
      .returning();
    const [div] = await ctx.schema.db
      .insert(briefingDivergences)
      .values({
        bimModelId,
        materializableElementId: elem.id,
        briefingId,
        reason: "deleted",
      })
      .returning();

    const resolveRes = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${div.id}/resolve`,
      ),
    ).set("x-requestor", "user:operator-1");
    expect(resolveRes.status).toBe(200);

    // Re-push the bim-model (idempotent at engagement-id level).
    const rePush = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    expect(rePush.status).toBe(200);

    const listRes = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/divergences`),
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.divergences).toHaveLength(1);
    expect(listRes.body.divergences[0].resolvedAt).not.toBeNull();
    expect(listRes.body.divergences[0].resolvedByRequestor).toMatchObject({
      kind: "user",
      id: "operator-1",
    });
  });

  it("returns Open and Resolved rows in the list with Open first", async () => {
    const { bimModelId, divergenceId } = await setupOpenDivergence();

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Seed a *second* open divergence, resolve only the first.
    const sib = await ctx.schema.db
      .select()
      .from(briefingDivergences)
      .where(eq(briefingDivergences.id, divergenceId));
    const [other] = await ctx.schema.db
      .insert(briefingDivergences)
      .values({
        bimModelId,
        materializableElementId: sib[0].materializableElementId,
        briefingId: sib[0].briefingId,
        reason: "unpinned",
      })
      .returning();
    void other;

    await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:operator-1");

    const listRes = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/divergences`),
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.divergences).toHaveLength(2);
    // Open row first (resolvedAt nulls first), resolved row last.
    expect(listRes.body.divergences[0].resolvedAt).toBeNull();
    expect(listRes.body.divergences[1].resolvedAt).not.toBeNull();
  });

  it("403s when the caller is not architect-audience", async () => {
    const { bimModelId, divergenceId } = await setupOpenDivergence();
    const res = await request(getApp()).post(
      `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("bim_model_requires_architect_audience");
  });

  it("404s on unknown bim-model id", async () => {
    const res = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/00000000-0000-0000-0000-000000000000/divergences/00000000-0000-0000-0000-000000000001/resolve`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("bim_model_not_found");
  });

  it("404s on a divergence id from a different bim-model", async () => {
    // Two engagements, each with its own bim-model + divergence.
    // Try to resolve engagement A's divergence under engagement B's
    // bim-model id — the route must refuse to acknowledge an
    // override outside its own bim-model scope.
    const a = await setupOpenDivergence();
    const b = await setupOpenDivergence();

    const res = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${b.bimModelId}/divergences/${a.divergenceId}/resolve`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("divergence_not_found");
  });

  it("hydrates the resolver's friendly displayName onto the resolve + list response (Task #212)", async () => {
    // The `users.displayName` column carries the friendly label
    // surfaced by the design-tools "Resolved by …" badge. The
    // session middleware backfills a default row keyed off the raw
    // id, but an admin can later edit the row to a real name —
    // here we pre-seed the `users` row so the displayName is
    // distinct from the id and the hydration path is unmistakable.
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await ctx.schema.db
      .insert(users)
      .values({
        id: "operator-7",
        displayName: "Alex Architect",
        email: null,
        avatarUrl: null,
      })
      .onConflictDoNothing({ target: users.id });

    const { bimModelId, divergenceId } = await setupOpenDivergence();
    const resolveRes = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:operator-7");
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.divergence.resolvedByRequestor).toEqual({
      kind: "user",
      id: "operator-7",
      displayName: "Alex Architect",
    });

    // The list endpoint must hydrate the same field — it's the
    // surface the design-tools panel re-fetches on cache invalidation,
    // so the display name has to ride along on every read.
    const listRes = await asArchitect(
      request(getApp()).get(`/api/bim-models/${bimModelId}/divergences`),
    );
    expect(listRes.status).toBe(200);
    expect(listRes.body.divergences[0].resolvedByRequestor).toEqual({
      kind: "user",
      id: "operator-7",
      displayName: "Alex Architect",
    });
  });

  it("resolves successfully without a session requestor (resolvedByRequestor null)", async () => {
    const { bimModelId, divergenceId } = await setupOpenDivergence();
    // Architect-audience but no `x-requestor` header → the row
    // still moves to Resolved, but the attribution column lands
    // null so the FE can render "system / unattributed".
    const res = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.divergence.resolvedAt).not.toBeNull();
    expect(res.body.divergence.resolvedByRequestor).toBeNull();
  });

  it("emits briefing-divergence.resolved exactly once across an idempotent re-resolve", async () => {
    // Closes Task #213: the first resolve must append a
    // `briefing-divergence.resolved` atom event (so the engagement
    // timeline can show "operator X acknowledged the override at
    // 3pm"); a re-resolve must NOT double-emit (the first
    // acknowledger keeps the audit-trail attribution and the
    // timeline keeps a single resolve marker).
    const { bimModelId, divergenceId } = await setupOpenDivergence();

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Baseline event count for this divergence — the seed insert
    // does NOT pass through the recorded-emit path (it goes
    // straight to drizzle), so the timeline starts empty.
    const baseline = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, divergenceId));
    expect(baseline).toHaveLength(0);

    const first = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:operator-1");
    expect(first.status).toBe(200);

    const afterFirst = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, divergenceId));
    const resolvedEventsAfterFirst = afterFirst.filter(
      (e) =>
        e.entityType === "briefing-divergence" &&
        e.eventType === "briefing-divergence.resolved",
    );
    expect(resolvedEventsAfterFirst).toHaveLength(1);
    // Attribution rides through: the timeline event records *who*
    // resolved the row, mirroring the row-side
    // `resolvedByRequestor` columns.
    const evt = resolvedEventsAfterFirst[0];
    expect(evt.actor).toMatchObject({ kind: "user", id: "operator-1" });
    expect(evt.payload).toMatchObject({
      bimModelId,
      resolvedByRequestor: { kind: "user", id: "operator-1" },
    });

    // Re-resolve: the row update is a no-op (idempotent) and so is
    // the emit — exactly one resolved event should still exist.
    const second = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:second-operator");
    expect(second.status).toBe(200);

    const afterSecond = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, divergenceId));
    const resolvedEventsAfterSecond = afterSecond.filter(
      (e) =>
        e.entityType === "briefing-divergence" &&
        e.eventType === "briefing-divergence.resolved",
    );
    expect(resolvedEventsAfterSecond).toHaveLength(1);
    // And the surviving event keeps the original acknowledger.
    expect(resolvedEventsAfterSecond[0].id).toBe(evt.id);
  });

  it("fans the resolve into the parent bim-model timeline (single-emit across re-resolve)", async () => {
    // Closes Task #267: the resolve path needs the same two-event
    // fan-out the record path uses — a per-divergence event so the
    // divergence's own timeline picks it up, AND a per-bim-model
    // fan-in event so the engagement-level timeline picks the
    // acknowledgement up without walking per-divergence chains.
    // Both must be single-emit across an idempotent re-resolve so
    // the engagement view stays aligned with the per-divergence
    // view (a single resolve marker on each timeline).
    const { bimModelId, divergenceId } = await setupOpenDivergence();

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Baseline: the seed insert above goes straight to drizzle, so
    // neither the per-divergence nor the per-bim-model timeline has
    // any resolve-shaped events yet.
    const bimModelBaseline = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bimModelId));
    expect(
      bimModelBaseline.filter(
        (e) => e.eventType === "bim-model.divergence-resolved",
      ),
    ).toHaveLength(0);

    const first = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:operator-1");
    expect(first.status).toBe(200);

    // Both events must land after the first resolve: the per-
    // divergence event on the divergence row's timeline, and the
    // per-bim-model fan-in on the parent bim-model's timeline.
    const divergenceEventsAfterFirst = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, divergenceId));
    const perDivergenceResolved = divergenceEventsAfterFirst.filter(
      (e) =>
        e.entityType === "briefing-divergence" &&
        e.eventType === "briefing-divergence.resolved",
    );
    expect(perDivergenceResolved).toHaveLength(1);

    const bimModelEventsAfterFirst = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bimModelId));
    const perBimModelResolved = bimModelEventsAfterFirst.filter(
      (e) =>
        e.entityType === "bim-model" &&
        e.eventType === "bim-model.divergence-resolved",
    );
    expect(perBimModelResolved).toHaveLength(1);
    // Attribution rides through to the fan-in event too — the two
    // timelines must agree on *who* acknowledged the override.
    const fanInEvt = perBimModelResolved[0];
    expect(fanInEvt.actor).toMatchObject({
      kind: "user",
      id: "operator-1",
    });
    expect(fanInEvt.payload).toMatchObject({
      divergenceId,
      resolvedByRequestor: { kind: "user", id: "operator-1" },
    });

    // Re-resolve by a different operator: the row update is a no-op
    // (idempotent), and so is *both* emits — exactly one fan-in
    // event must still exist on the bim-model timeline, with the
    // original acknowledger preserved.
    const second = await asArchitect(
      request(getApp()).post(
        `/api/bim-models/${bimModelId}/divergences/${divergenceId}/resolve`,
      ),
    ).set("x-requestor", "user:second-operator");
    expect(second.status).toBe(200);

    const bimModelEventsAfterSecond = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bimModelId));
    const perBimModelResolvedAfterSecond = bimModelEventsAfterSecond.filter(
      (e) =>
        e.entityType === "bim-model" &&
        e.eventType === "bim-model.divergence-resolved",
    );
    expect(perBimModelResolvedAfterSecond).toHaveLength(1);
    expect(perBimModelResolvedAfterSecond[0].id).toBe(fanInEvt.id);
  });
});

describe("POST /api/bim-models/:id/divergence (HMAC-authenticated)", () => {
  async function setupBimModelWithElement(): Promise<{
    bimModelId: string;
    elementId: string;
    briefingId: string;
  }> {
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [elem] = await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId,
        elementKind: "buildable-envelope",
        label: "Test envelope",
        geometry: { ring: [] },
      })
      .returning();
    return { bimModelId, elementId: elem.id, briefingId };
  }

  it("rejects (400) requests without the HMAC headers", async () => {
    const { bimModelId, elementId } = await setupBimModelWithElement();
    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_bim_model_signature_headers");
  });

  it("rejects (401) requests with an invalid signature", async () => {
    const { bimModelId, elementId } = await setupBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-000000000001";
    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set("x-bim-model-request-id", requestId)
      .set("x-bim-model-signature", "deadbeef".repeat(8))
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_bim_model_signature");
  });

  it("accepts a correctly-signed body, inserts a divergence row, and emits both events", async () => {
    const { bimModelId, elementId, briefingId } =
      await setupBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-000000000010";
    const signature = signDivergence(requestId, bimModelId);

    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set("x-bim-model-request-id", requestId)
      .set("x-bim-model-signature", signature)
      .send({
        materializableElementId: elementId,
        reason: "geometry-edited",
        note: "moved a vertex",
        detail: { revitElementId: 12345 },
      });
    expect(res.status).toBe(201);
    expect(res.body.divergence.bimModelId).toBe(bimModelId);
    expect(res.body.divergence.materializableElementId).toBe(elementId);
    expect(res.body.divergence.briefingId).toBe(briefingId);
    expect(res.body.divergence.reason).toBe("geometry-edited");
    expect(res.body.divergence.note).toBe("moved a vertex");
    expect(res.body.divergence.detail).toMatchObject({
      revitElementId: 12345,
    });

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const rows = await ctx.schema.db
      .select()
      .from(briefingDivergences)
      .where(eq(briefingDivergences.bimModelId, bimModelId));
    expect(rows).toHaveLength(1);

    const events = await ctx.schema.db.select().from(atomEvents);
    expect(
      events.some(
        (e) =>
          e.entityType === "briefing-divergence" &&
          e.eventType === "briefing-divergence.recorded",
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) =>
          e.entityType === "bim-model" &&
          e.eventType === "bim-model.diverged",
      ),
    ).toBe(true);
  });

  it("404s when the materializable element does not exist", async () => {
    const { bimModelId } = await setupBimModelWithElement();
    const requestId = "00000000-0000-0000-0000-000000000011";
    const signature = signDivergence(requestId, bimModelId);
    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set("x-bim-model-request-id", requestId)
      .set("x-bim-model-signature", signature)
      .send({
        materializableElementId: "00000000-0000-0000-0000-000000000099",
        reason: "geometry-edited",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("materializable_element_not_found");
  });

  it("400s when the element belongs to a non-active briefing", async () => {
    const { bimModelId } = await setupBimModelWithElement();

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Seed a second engagement + briefing + element, then try to
    // divergence-write it against the first bim-model. The route
    // refuses cross-briefing divergences.
    const [otherEng] = await ctx.schema.db
      .insert(engagements)
      .values({
        name: "Other Engagement",
        nameLower: "other-engagement",
        jurisdiction: "Boulder, CO",
        address: "9 Pearl St",
        status: "active",
      })
      .returning();
    const [otherBriefing] = await ctx.schema.db
      .insert(parcelBriefings)
      .values({ engagementId: otherEng.id })
      .returning();
    const [otherElem] = await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId: otherBriefing.id,
        elementKind: "terrain",
      })
      .returning();

    const requestId = "00000000-0000-0000-0000-000000000012";
    const signature = signDivergence(requestId, bimModelId);
    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set("x-bim-model-request-id", requestId)
      .set("x-bim-model-signature", signature)
      .send({
        materializableElementId: otherElem.id,
        reason: "geometry-edited",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(
      "element_does_not_belong_to_active_briefing",
    );
  });
});

describe("BIM_MODEL_SHARED_SECRET handling", () => {
  beforeEach(() => {
    process.env.BIM_MODEL_SHARED_SECRET = TEST_HMAC_SECRET;
  });

  it("returns 500 when the secret is unset (server misconfiguration)", async () => {
    process.env.BIM_MODEL_SHARED_SECRET = "";

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const { engagementId, briefingId } = await seedEngagementAndBriefing();
    const push = await asArchitect(
      request(getApp()).post(`/api/engagements/${engagementId}/bim-model`),
    ).send({});
    const bimModelId = push.body.bimModel.id as string;
    const [elem] = await ctx.schema.db
      .insert(materializableElements)
      .values({
        briefingId,
        elementKind: "terrain",
      })
      .returning();

    const requestId = "00000000-0000-0000-0000-000000000020";
    const res = await request(getApp())
      .post(`/api/bim-models/${bimModelId}/divergence`)
      .set("x-bim-model-request-id", requestId)
      .set("x-bim-model-signature", "deadbeef".repeat(8))
      .send({
        materializableElementId: elem.id,
        reason: "geometry-edited",
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(
      "bim_model_divergence_secret_not_configured",
    );
  });
});
