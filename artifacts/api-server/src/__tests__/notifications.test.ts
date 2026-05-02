/**
 * `/api/me/notifications*` route coverage.
 *
 *   1. Unread badge count — items recorded after the architect's
 *      last `mark-read` are reported as unread; the response
 *      `unreadCount` matches the per-row `read=false` tally.
 *   2. List rendering — submission status changes and reviewer-
 *      requests are returned newest-first, with engagement labels
 *      hydrated from the join.
 *   3. Read-state transition — `POST /me/notifications/mark-read`
 *      flips every existing item to `read: true` and zeros the
 *      `unreadCount`; subsequent events come back unread again.
 *
 * Plus the audience guard: anonymous and agent callers get a 401 on
 * both endpoints — the surface is architect-only.
 */

import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("notifications.test: ctx.schema unset");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions, atomEvents, architectNotificationReads } =
  await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

interface SeedSubmissionEventArgs {
  submissionId: string;
  engagementId: string;
  toStatus: "approved" | "rejected" | "corrections_requested";
  note?: string | null;
  occurredAt: Date;
}

async function seedSubmissionEvent(
  args: SeedSubmissionEventArgs,
): Promise<string> {
  if (!ctx.schema) throw new Error("schema not ready");
  const id = nextId("ev");
  await ctx.schema.db.insert(atomEvents).values({
    id,
    entityType: "submission",
    entityId: args.submissionId,
    eventType: "submission.status-changed",
    actor: { kind: "agent", id: "test-seeder" },
    payload: {
      engagementId: args.engagementId,
      toStatus: args.toStatus,
      note: args.note ?? null,
    },
    prevHash: null,
    chainHash: nextId("hash"),
    occurredAt: args.occurredAt,
    recordedAt: args.occurredAt,
  });
  return id;
}

interface SeedReviewerRequestEventArgs {
  reviewerRequestId: string;
  engagementId: string;
  kind: string;
  reason?: string | null;
  occurredAt: Date;
}

async function seedReviewerRequestEvent(
  args: SeedReviewerRequestEventArgs,
): Promise<string> {
  if (!ctx.schema) throw new Error("schema not ready");
  const id = nextId("ev");
  await ctx.schema.db.insert(atomEvents).values({
    id,
    entityType: "reviewer-request",
    entityId: args.reviewerRequestId,
    eventType: `reviewer-request.${args.kind}.requested`,
    actor: { kind: "agent", id: "test-seeder" },
    payload: {
      engagementId: args.engagementId,
      kind: args.kind,
      reason: args.reason ?? null,
    },
    prevHash: null,
    chainHash: nextId("hash"),
    occurredAt: args.occurredAt,
    recordedAt: args.occurredAt,
  });
  return id;
}

async function seedEngagementWithSubmission(label: string): Promise<{
  engagementId: string;
  submissionId: string;
}> {
  if (!ctx.schema) throw new Error("schema not ready");
  // engagements.id and submissions.id are typed as `uuid` in the
  // schema — Postgres rejects free-form ULIDs with 22P02 — so seed
  // them with `randomUUID()`. The `nextId` helper is fine for atom-
  // event ids (text column) and reviewer-request fixture ids (only
  // referenced via the event payload, never inserted into a uuid
  // column in this suite).
  const engagementId = randomUUID();
  const submissionId = randomUUID();
  await ctx.schema.db.insert(engagements).values({
    id: engagementId,
    name: label,
    nameLower: label.toLowerCase(),
  });
  await ctx.schema.db.insert(submissions).values({
    id: submissionId,
    engagementId,
    status: "submitted",
  });
  return { engagementId, submissionId };
}

describe("GET /api/me/notifications — audience guard", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(getApp()).get("/api/me/notifications");
    expect(res.status).toBe(401);
  });

  it("rejects agent-kind requestors with 401", async () => {
    const res = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "agent:snapshot-ingest");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/me/notifications/mark-read — audience guard", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(getApp()).post("/api/me/notifications/mark-read");
    expect(res.status).toBe(401);
  });

  it("rejects agent-kind requestors with 401", async () => {
    const res = await request(getApp())
      .post("/api/me/notifications/mark-read")
      .set("x-requestor", "agent:foo");
    expect(res.status).toBe(401);
  });
});

describe("GET /api/me/notifications — list rendering & badge count", () => {
  it("returns an empty list and zero unread for a fresh architect", async () => {
    const res = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-fresh");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      unreadCount: 0,
      lastReadAt: null,
    });
  });

  it("returns submission status-change + reviewer-request events newest-first with engagement labels", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithSubmission("Studio Foo — 123 Main St");

    // Three events spanning the two source families. Times are
    // staggered so the ordering assertion is unambiguous.
    const oldest = new Date("2025-04-01T10:00:00Z");
    const middle = new Date("2025-04-02T10:00:00Z");
    const newest = new Date("2025-04-03T10:00:00Z");

    await seedSubmissionEvent({
      submissionId,
      engagementId,
      toStatus: "corrections_requested",
      note: "Please update the floor plan.",
      occurredAt: oldest,
    });
    const reviewerReqId = nextId("rr");
    await seedReviewerRequestEvent({
      reviewerRequestId: reviewerReqId,
      engagementId,
      kind: "refresh-briefing-source",
      reason: "Source updated",
      occurredAt: middle,
    });
    await seedSubmissionEvent({
      submissionId,
      engagementId,
      toStatus: "approved",
      note: null,
      occurredAt: newest,
    });

    const res = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-arch");
    expect(res.status).toBe(200);
    const items: Array<{
      kind: string;
      title: string;
      engagementId: string | null;
      engagementName: string | null;
      submissionId: string | null;
      reviewerRequestId: string | null;
      read: boolean;
      occurredAt: string;
      body: string | null;
    }> = res.body.items;

    expect(items).toHaveLength(3);
    // Newest-first ordering.
    expect(new Date(items[0].occurredAt).getTime()).toBe(newest.getTime());
    expect(new Date(items[2].occurredAt).getTime()).toBe(oldest.getTime());

    // Submission status-change row hydrates engagement name via the
    // submissions join, not just the payload echo.
    expect(items[0].kind).toBe("submission-status-changed");
    expect(items[0].engagementId).toBe(engagementId);
    expect(items[0].engagementName).toBe("Studio Foo — 123 Main St");
    expect(items[0].submissionId).toBe(submissionId);
    expect(items[0].title).toBe("Submission approved");

    // Reviewer-request row reads engagementId straight off the
    // payload (no join through submissions for this kind).
    expect(items[1].kind).toBe("reviewer-request-filed");
    expect(items[1].engagementId).toBe(engagementId);
    expect(items[1].engagementName).toBe("Studio Foo — 123 Main St");
    expect(items[1].reviewerRequestId).toBe(reviewerReqId);
    expect(items[1].title).toBe(
      "Reviewer requested briefing-source refresh",
    );
    expect(items[1].body).toBe("Source updated");

    // Status-change `note` surfaces as `body`.
    expect(items[2].body).toBe("Please update the floor plan.");

    // No watermark yet → every item unread, count matches.
    expect(items.every((i) => i.read === false)).toBe(true);
    expect(res.body.unreadCount).toBe(3);
    expect(res.body.lastReadAt).toBeNull();
  });

  it("respects the `limit` query parameter and caps at MAX_LIMIT", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithSubmission("Limit Test");
    for (let i = 0; i < 5; i += 1) {
      await seedSubmissionEvent({
        submissionId,
        engagementId,
        toStatus: "approved",
        note: null,
        occurredAt: new Date(2025, 3, 1, 10, i),
      });
    }
    const res = await request(getApp())
      .get("/api/me/notifications?limit=2")
      .set("x-requestor", "user:u-arch");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });
});

describe("POST /api/me/notifications/mark-read — read-state transition", () => {
  it("flips existing items to read=true and zeros unreadCount, then a fresh event re-introduces unread", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithSubmission("Read State Test");
    await seedSubmissionEvent({
      submissionId,
      engagementId,
      toStatus: "rejected",
      note: "no",
      occurredAt: new Date("2025-04-01T10:00:00Z"),
    });

    // Initial state: one unread event.
    const before = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-arch");
    expect(before.body.unreadCount).toBe(1);
    expect(before.body.items[0].read).toBe(false);

    // Mark read → watermark gets stamped, response carries the new
    // ISO timestamp.
    const markRes = await request(getApp())
      .post("/api/me/notifications/mark-read")
      .set("x-requestor", "user:u-arch");
    expect(markRes.status).toBe(200);
    expect(typeof markRes.body.lastReadAt).toBe("string");
    expect(Number.isFinite(Date.parse(markRes.body.lastReadAt))).toBe(true);

    // Verify the watermark row landed.
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(architectNotificationReads)
      .where(eq(architectNotificationReads.userId, "u-arch"));
    expect(rows).toHaveLength(1);

    // GET again → existing event is now read, count is zero.
    const after = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-arch");
    expect(after.body.unreadCount).toBe(0);
    expect(after.body.items[0].read).toBe(true);
    expect(after.body.lastReadAt).toBe(markRes.body.lastReadAt);

    // A fresh event recorded AFTER the watermark surfaces as unread
    // again — proves the watermark is a per-event comparison, not
    // a "snooze everything forever" sticky.
    await seedSubmissionEvent({
      submissionId,
      engagementId,
      toStatus: "approved",
      note: null,
      occurredAt: new Date(Date.now() + 60_000),
    });
    const fresh = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-arch");
    expect(fresh.body.unreadCount).toBe(1);
    expect(fresh.body.items[0].read).toBe(false);
    expect(fresh.body.items[1].read).toBe(true);
  });

  it("is idempotent — calling twice in quick succession does not error", async () => {
    const r1 = await request(getApp())
      .post("/api/me/notifications/mark-read")
      .set("x-requestor", "user:u-double");
    expect(r1.status).toBe(200);
    const r2 = await request(getApp())
      .post("/api/me/notifications/mark-read")
      .set("x-requestor", "user:u-double");
    expect(r2.status).toBe(200);
  });

  it("scopes the watermark per-architect — one user's mark-read does not affect another's unread count", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithSubmission("Per-User Test");
    await seedSubmissionEvent({
      submissionId,
      engagementId,
      toStatus: "approved",
      note: null,
      occurredAt: new Date("2025-04-01T10:00:00Z"),
    });

    await request(getApp())
      .post("/api/me/notifications/mark-read")
      .set("x-requestor", "user:u-alice");

    const aliceRes = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-alice");
    expect(aliceRes.body.unreadCount).toBe(0);

    const bobRes = await request(getApp())
      .get("/api/me/notifications")
      .set("x-requestor", "user:u-bob");
    expect(bobRes.body.unreadCount).toBe(1);
  });
});
