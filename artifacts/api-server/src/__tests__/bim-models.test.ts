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
