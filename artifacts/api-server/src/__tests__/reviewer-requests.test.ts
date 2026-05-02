/**
 * /api/engagements/:id/reviewer-requests + /api/reviewer-requests/:id/dismiss
 * route tests — Wave 2 Sprint D / V1-2.
 *
 * Coverage:
 *   - Audience gates: GET + dismiss require `user` (architect); POST
 *     create requires `internal` (reviewer). Wrong-audience callers
 *     hit 403.
 *   - Create round-trip: 201 with row + .requested event in
 *     atom_events. 400 on missing fields, oversize reason, and
 *     kind/target-type mismatch. 404 on unknown engagement.
 *   - List: filters by status, returns newest-first.
 *   - Dismiss: 200 happy path emits .dismissed + stamps row;
 *     idempotent on already-dismissed; 409 on already-resolved; 404
 *     on unknown request; 400 on missing dismissalReason.
 *   - Implicit-resolve helper: directly seeded pending request
 *     against a briefing-source UUID flips to `resolved` with
 *     `triggered_action_event_id` populated when the helper is
 *     called. Pure-helper test; the wired-up emit-site integration
 *     is covered by the bim-models / generate-layers / parcel-
 *     briefings route tests already in this directory (which exercise
 *     the helper's call sites without exposing an API for them).
 */

import { describe, it, expect, vi } from "vitest";
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
        throw new Error("reviewer-requests.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, reviewerRequests, atomEvents } = await import(
  "@workspace/db"
);
const { eq } = await import("drizzle-orm");
const { resolveMatchingReviewerRequests } = await import(
  "../lib/reviewerRequestResolution"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_AUDIENCE = ["x-audience", "internal"] as const;
const REVIEWER_REQUESTOR = ["x-requestor", "user:reviewer-1"] as const;
const ARCHITECT_AUDIENCE = ["x-audience", "user"] as const;
const ARCHITECT_REQUESTOR = ["x-requestor", "user:architect-1"] as const;

function asReviewer<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(REVIEWER_AUDIENCE[0], REVIEWER_AUDIENCE[1])
    .set(REVIEWER_REQUESTOR[0], REVIEWER_REQUESTOR[1]);
}

function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(ARCHITECT_AUDIENCE[0], ARCHITECT_AUDIENCE[1])
    .set(ARCHITECT_REQUESTOR[0], ARCHITECT_REQUESTOR[1]);
}

async function seedEngagement(
  name = "Reviewer Requests Engagement",
): Promise<{ id: string }> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Moab, UT",
      address: "1 Reviewer Way",
      status: "active",
    })
    .returning({ id: engagements.id });
  return { id: eng.id };
}

async function listEvents(reviewerRequestId: string) {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const rows = await ctx.schema.db
    .select()
    .from(atomEvents)
    .where(eq(atomEvents.entityId, reviewerRequestId));
  return rows.map((r) => r.eventType);
}

const SOURCE_UUID = "44444444-4444-4444-4444-444444444444";

describe("GET /api/engagements/:id/reviewer-requests", () => {
  it("allows reviewer-audience callers (Task #429: reviewers read pending requests to disable affordances)", async () => {
    const { id } = await seedEngagement();
    const res = await asReviewer(
      request(getApp()).get(`/api/engagements/${id}/reviewer-requests`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });

  it("403s when the caller is neither architect nor reviewer audience", async () => {
    const { id } = await seedEngagement();
    const res = await request(getApp())
      .get(`/api/engagements/${id}/reviewer-requests`)
      .set("x-audience", "ai")
      .set("x-requestor", "agent:bot-1");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_requests_require_architect_or_reviewer_audience",
    );
  });

  it("returns an empty list for a fresh engagement", async () => {
    const { id } = await seedEngagement();
    const res = await asArchitect(
      request(getApp()).get(`/api/engagements/${id}/reviewer-requests`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });

  it("404s when the engagement does not exist", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        "/api/engagements/00000000-0000-0000-0000-000000000000/reviewer-requests",
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("filters by status", async () => {
    const { id } = await seedEngagement();
    // Seed two rows manually so the test doesn't depend on the
    // create endpoint's audience flip.
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await ctx.schema.db.insert(reviewerRequests).values([
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "pending one",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "dismissed one",
        status: "dismissed",
        dismissedBy: { kind: "user", id: "architect-1" },
        dismissedAt: new Date(),
        dismissalReason: "no longer relevant",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
    ]);
    const pendingRes = await asArchitect(
      request(getApp())
        .get(`/api/engagements/${id}/reviewer-requests`)
        .query({ status: "pending" }),
    );
    expect(pendingRes.status).toBe(200);
    expect(pendingRes.body.requests).toHaveLength(1);
    expect(pendingRes.body.requests[0].status).toBe("pending");
    const allRes = await asArchitect(
      request(getApp()).get(`/api/engagements/${id}/reviewer-requests`),
    );
    expect(allRes.body.requests).toHaveLength(2);
  });
});

describe("POST /api/engagements/:id/reviewer-requests", () => {
  it("403s when the caller is not reviewer-audience", async () => {
    const { id } = await seedEngagement();
    const res = await asArchitect(
      request(getApp())
        .post(`/api/engagements/${id}/reviewer-requests`)
        .send({
          requestKind: "refresh-briefing-source",
          targetEntityType: "briefing-source",
          targetEntityId: SOURCE_UUID,
          reason: "Source PDF appears outdated.",
        }),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_requests_require_internal_audience",
    );
  });

  it("creates the row + emits .requested event on happy path", async () => {
    const { id } = await seedEngagement();
    const res = await asReviewer(
      request(getApp())
        .post(`/api/engagements/${id}/reviewer-requests`)
        .send({
          requestKind: "refresh-briefing-source",
          targetEntityType: "briefing-source",
          targetEntityId: SOURCE_UUID,
          reason: "Source PDF appears outdated.",
        }),
    );
    expect(res.status).toBe(201);
    expect(res.body.request.engagementId).toBe(id);
    expect(res.body.request.requestKind).toBe("refresh-briefing-source");
    expect(res.body.request.targetEntityType).toBe("briefing-source");
    expect(res.body.request.targetEntityId).toBe(SOURCE_UUID);
    expect(res.body.request.status).toBe("pending");
    expect(res.body.request.requestedBy.kind).toBe("user");
    expect(res.body.request.requestedBy.id).toBe("reviewer-1");
    expect(res.body.request.dismissedAt).toBeNull();
    expect(res.body.request.resolvedAt).toBeNull();
    const eventTypes = await listEvents(res.body.request.id);
    expect(eventTypes).toEqual([
      "reviewer-request.refresh-briefing-source.requested",
    ]);
  });

  it("400s on kind/target-type mismatch", async () => {
    const { id } = await seedEngagement();
    const res = await asReviewer(
      request(getApp())
        .post(`/api/engagements/${id}/reviewer-requests`)
        .send({
          requestKind: "refresh-briefing-source",
          // bim-model paired with refresh-briefing-source kind — the
          // route enforces the closed kind→target-type contract.
          targetEntityType: "bim-model",
          targetEntityId: SOURCE_UUID,
          reason: "should reject",
        }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("request_kind_target_type_mismatch");
  });

  it("400s on empty reason", async () => {
    const { id } = await seedEngagement();
    const res = await asReviewer(
      request(getApp())
        .post(`/api/engagements/${id}/reviewer-requests`)
        .send({
          requestKind: "refresh-briefing-source",
          targetEntityType: "briefing-source",
          targetEntityId: SOURCE_UUID,
          reason: "",
        }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request_body");
  });

  it("404s when the engagement does not exist", async () => {
    const res = await asReviewer(
      request(getApp())
        .post(
          "/api/engagements/00000000-0000-0000-0000-000000000000/reviewer-requests",
        )
        .send({
          requestKind: "refresh-briefing-source",
          targetEntityType: "briefing-source",
          targetEntityId: SOURCE_UUID,
          reason: "x",
        }),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });
});

describe("POST /api/reviewer-requests/:id/dismiss", () => {
  async function seedPending(): Promise<{
    engagementId: string;
    requestId: string;
  }> {
    const { id } = await seedEngagement();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [row] = await ctx.schema.db
      .insert(reviewerRequests)
      .values({
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "pending",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      })
      .returning({ id: reviewerRequests.id });
    return { engagementId: id, requestId: row.id };
  }

  it("403s when the caller is not architect-audience", async () => {
    const { requestId } = await seedPending();
    const res = await asReviewer(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "no" }),
    );
    expect(res.status).toBe(403);
  });

  it("dismisses + emits .dismissed event on happy path", async () => {
    const { requestId } = await seedPending();
    const res = await asArchitect(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "Source is current." }),
    );
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("dismissed");
    expect(res.body.request.dismissalReason).toBe("Source is current.");
    expect(res.body.request.dismissedBy.id).toBe("architect-1");
    expect(res.body.request.dismissedAt).not.toBeNull();
    const eventTypes = await listEvents(requestId);
    expect(eventTypes).toEqual([
      "reviewer-request.refresh-briefing-source.dismissed",
    ]);
  });

  it("is idempotent on already-dismissed (returns existing without re-emit)", async () => {
    const { requestId } = await seedPending();
    const first = await asArchitect(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "first" }),
    );
    expect(first.status).toBe(200);
    const second = await asArchitect(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "second" }),
    );
    expect(second.status).toBe(200);
    // Reason from the FIRST dismissal — second call is a no-op idempotent.
    expect(second.body.request.dismissalReason).toBe("first");
    const eventTypes = await listEvents(requestId);
    // Only the first call emitted an event.
    expect(eventTypes).toEqual([
      "reviewer-request.refresh-briefing-source.dismissed",
    ]);
  });

  it("409s on already-resolved", async () => {
    const { requestId } = await seedPending();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await ctx.schema.db
      .update(reviewerRequests)
      .set({
        status: "resolved",
        resolvedAt: new Date(),
        triggeredActionEventId: "55555555-5555-5555-5555-555555555555",
      })
      .where(eq(reviewerRequests.id, requestId));
    const res = await asArchitect(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "no" }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reviewer_request_already_resolved");
  });

  it("404s on unknown request id", async () => {
    const res = await asArchitect(
      request(getApp())
        .post(
          "/api/reviewer-requests/00000000-0000-0000-0000-000000000000/dismiss",
        )
        .send({ dismissalReason: "x" }),
    );
    expect(res.status).toBe(404);
  });

  it("400s on empty dismissalReason", async () => {
    const { requestId } = await seedPending();
    const res = await asArchitect(
      request(getApp())
        .post(`/api/reviewer-requests/${requestId}/dismiss`)
        .send({ dismissalReason: "" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request_body");
  });
});

describe("resolveMatchingReviewerRequests (implicit-resolve helper)", () => {
  it("flips a pending request to resolved + stamps the action event id", async () => {
    const { id: engagementId } = await seedEngagement();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [pending] = await ctx.schema.db
      .insert(reviewerRequests)
      .values({
        engagementId,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "Source PDF appears outdated.",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      })
      .returning();

    const fakeLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as Parameters<typeof resolveMatchingReviewerRequests>[0]["log"];
    const ACTION_EVENT_ID = "66666666-6666-6666-6666-666666666666";
    const resolved = await resolveMatchingReviewerRequests({
      targetEntityType: "briefing-source",
      targetEntityId: SOURCE_UUID,
      triggeredActionEventId: ACTION_EVENT_ID,
      log: fakeLog,
    });
    expect(resolved).toBe(1);

    const after = await ctx.schema.db
      .select()
      .from(reviewerRequests)
      .where(eq(reviewerRequests.id, pending.id));
    expect(after[0].status).toBe("resolved");
    expect(after[0].resolvedAt).not.toBeNull();
    expect(after[0].triggeredActionEventId).toBe(ACTION_EVENT_ID);
  });

  it("does not touch already-dismissed rows on the same target tuple", async () => {
    const { id: engagementId } = await seedEngagement();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const [dismissed] = await ctx.schema.db
      .insert(reviewerRequests)
      .values({
        engagementId,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "stale ask",
        status: "dismissed",
        dismissedBy: { kind: "user", id: "architect-1" },
        dismissedAt: new Date(),
        dismissalReason: "no longer relevant",
        requestedBy: { kind: "user", id: "reviewer-1" },
      })
      .returning();

    const fakeLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as Parameters<typeof resolveMatchingReviewerRequests>[0]["log"];
    const resolved = await resolveMatchingReviewerRequests({
      targetEntityType: "briefing-source",
      targetEntityId: SOURCE_UUID,
      triggeredActionEventId: "77777777-7777-7777-7777-777777777777",
      log: fakeLog,
    });
    expect(resolved).toBe(0);

    const after = await ctx.schema.db
      .select()
      .from(reviewerRequests)
      .where(eq(reviewerRequests.id, dismissed.id));
    expect(after[0].status).toBe("dismissed");
    expect(after[0].triggeredActionEventId).toBeNull();
  });

  it("returns 0 + does not throw when no pending row matches the target", async () => {
    const fakeLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as unknown as Parameters<typeof resolveMatchingReviewerRequests>[0]["log"];
    const resolved = await resolveMatchingReviewerRequests({
      targetEntityType: "briefing-source",
      targetEntityId: "no-such-target",
      triggeredActionEventId: "00000000-0000-0000-0000-000000000000",
      log: fakeLog,
    });
    expect(resolved).toBe(0);
  });
});

// Cross-engagement reviewer list. Reviewer-only audience gate,
// ownership scoped by `requested_by ->> 'id'`, default status filter
// `pending`, `?status=all` returns every lifecycle state, joined
// with engagement metadata.
describe("GET /api/reviewer-requests (cross-engagement)", () => {
  it("403s when the caller is not reviewer-audience", async () => {
    const res = await asArchitect(
      request(getApp()).get("/api/reviewer-requests"),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_requests_require_internal_audience",
    );
  });

  it("returns only the calling reviewer's own requests, joined with engagement metadata", async () => {
    const { id: engA } = await seedEngagement("Engagement A");
    const { id: engB } = await seedEngagement("Engagement B");
    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Three rows: two by `reviewer-1` (the caller), one by
    // `reviewer-2` (a peer). The peer's row must not appear in the
    // caller's response — ownership scope is the load-bearing
    // assertion of this test.
    await ctx.schema.db.insert(reviewerRequests).values([
      {
        engagementId: engA,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "mine on A",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
      {
        engagementId: engB,
        requestKind: "refresh-bim-model",
        targetEntityType: "bim-model",
        targetEntityId: SOURCE_UUID,
        reason: "mine on B",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
      {
        engagementId: engA,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "peer's row",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-2" },
      },
    ]);
    const res = await asReviewer(
      request(getApp()).get("/api/reviewer-requests"),
    );
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    const reasons = res.body.requests.map(
      (r: { reason: string }) => r.reason,
    );
    expect(reasons).toContain("mine on A");
    expect(reasons).toContain("mine on B");
    expect(reasons).not.toContain("peer's row");
    // Engagement metadata joined onto every row, with the right
    // engagement on each side.
    const byReason = new Map<string, { engagement: { id: string; name: string; jurisdiction: string | null } }>(
      res.body.requests.map((r: { reason: string; engagement: { id: string; name: string; jurisdiction: string | null } }) => [r.reason, r]),
    );
    expect(byReason.get("mine on A")?.engagement).toEqual({
      id: engA,
      name: "Engagement A",
      jurisdiction: "Moab, UT",
    });
    expect(byReason.get("mine on B")?.engagement).toEqual({
      id: engB,
      name: "Engagement B",
      jurisdiction: "Moab, UT",
    });
  });

  it("defaults to `pending` and returns every lifecycle state on `?status=all`", async () => {
    const { id } = await seedEngagement();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    await ctx.schema.db.insert(reviewerRequests).values([
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "still pending",
        status: "pending",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "closed out",
        status: "dismissed",
        dismissedBy: { kind: "user", id: "architect-1" },
        dismissedAt: new Date(),
        dismissalReason: "no longer relevant",
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
    ]);
    // No status param → default to `pending` (the closed row must
    // not appear).
    const defaultRes = await asReviewer(
      request(getApp()).get("/api/reviewer-requests"),
    );
    expect(defaultRes.status).toBe(200);
    expect(defaultRes.body.requests).toHaveLength(1);
    expect(defaultRes.body.requests[0].reason).toBe("still pending");
    // `?status=all` → both rows, regardless of lifecycle state.
    const allRes = await asReviewer(
      request(getApp())
        .get("/api/reviewer-requests")
        .query({ status: "all" }),
    );
    expect(allRes.status).toBe(200);
    expect(allRes.body.requests).toHaveLength(2);
    const reasons = allRes.body.requests.map(
      (r: { reason: string }) => r.reason,
    );
    expect(reasons).toContain("still pending");
    expect(reasons).toContain("closed out");
    // Explicit `?status=dismissed` still works for narrowing.
    const dismissedRes = await asReviewer(
      request(getApp())
        .get("/api/reviewer-requests")
        .query({ status: "dismissed" }),
    );
    expect(dismissedRes.status).toBe(200);
    expect(dismissedRes.body.requests).toHaveLength(1);
    expect(dismissedRes.body.requests[0].reason).toBe("closed out");
  });

  it("orders results newest-first by requestedAt", async () => {
    const { id } = await seedEngagement();
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-04-01T00:00:00.000Z");
    await ctx.schema.db.insert(reviewerRequests).values([
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "older",
        status: "pending",
        requestedAt: older,
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
      {
        engagementId: id,
        requestKind: "refresh-briefing-source",
        targetEntityType: "briefing-source",
        targetEntityId: SOURCE_UUID,
        reason: "newer",
        status: "pending",
        requestedAt: newer,
        requestedBy: { kind: "user", id: "reviewer-1" },
      },
    ]);
    const res = await asReviewer(
      request(getApp()).get("/api/reviewer-requests"),
    );
    expect(res.status).toBe(200);
    expect(res.body.requests).toHaveLength(2);
    expect(res.body.requests[0].reason).toBe("newer");
    expect(res.body.requests[1].reason).toBe("older");
  });

  it("400s when the internal session has no requestor (defensive)", async () => {
    // Reviewer audience without an `x-requestor` override — the
    // session has no requestor to scope ownership against, so the
    // route must fail loudly rather than silently leak every
    // reviewer's rows.
    const res = await request(getApp())
      .get("/api/reviewer-requests")
      .set("x-audience", "internal");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_requestor");
  });

  it("returns an empty list when the reviewer has no requests at all", async () => {
    const res = await asReviewer(
      request(getApp()).get("/api/reviewer-requests"),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });
});
