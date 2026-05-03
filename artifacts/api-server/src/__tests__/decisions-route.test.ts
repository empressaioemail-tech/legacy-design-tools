/**
 * /api/submissions/{submissionId}/decisions — PLR-6 / Task #460.
 *
 * Covers:
 *   - 403 on non-internal audience (POST + GET)
 *   - 400 on invalid verdict / 404 on missing submission
 *   - POST happy path: 201 wire shape, submission row updated to the
 *     mapped status, decision-event row appended, companion
 *     submission.status-changed event emitted on a real transition
 *   - approve_with_conditions maps to `approved` status
 *   - GET returns recorded decisions newest-first
 */

import { describe, expect, it, vi } from "vitest";
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
        throw new Error("decisions-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { submissions, atomEvents } = await import("@workspace/db");
const { eq, and, desc } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_HEADERS = {
  "x-audience": "internal",
  "x-requestor": "user:reviewer-test",
};

// Seeds via raw SQL rather than `db.insert(engagements).values(...)`
// because Drizzle's typed insert statically references every column
// declared in the schema — including columns the checked-in test
// fixture template lags behind on (`applicant_firm` etc.). The
// route under test only reads/writes the canonical submission
// columns, so a minimal raw INSERT is sufficient and keeps this
// suite independent of the broader fixture-drift problem.
async function seedSubmission() {
  if (!ctx.schema) throw new Error("schema not ready");
  const engRes = await ctx.schema.pool.query<{ id: string }>(
    `INSERT INTO engagements (name, name_lower, jurisdiction, address, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      "Decisions Test Engagement",
      "decisions test engagement",
      "Bastrop, TX",
      "1 Pine St",
      "active",
    ],
  );
  const engagementId = engRes.rows[0].id;
  const subRes = await ctx.schema.pool.query<{ id: string }>(
    `INSERT INTO submissions (engagement_id, jurisdiction)
     VALUES ($1, $2)
     RETURNING id`,
    [engagementId, "Bastrop, TX"],
  );
  return {
    engagement: { id: engagementId },
    submission: { id: subRes.rows[0].id, engagementId },
  };
}

describe("decisions route — audience guard", () => {
  it("rejects POST without internal audience with 403", async () => {
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .send({ verdict: "approve" });
    expect(res.status).toBe(403);
  });

  it("rejects GET without internal audience with 403", async () => {
    const { submission } = await seedSubmission();
    const res = await request(getApp()).get(
      `/api/submissions/${submission.id}/decisions`,
    );
    expect(res.status).toBe(403);
  });
});

describe("POST /submissions/:submissionId/decisions", () => {
  it("returns 404 when the submission does not exist", async () => {
    const res = await request(getApp())
      .post("/api/submissions/00000000-0000-0000-0000-000000000000/decisions")
      .set(REVIEWER_HEADERS)
      .send({ verdict: "approve" });
    expect(res.status).toBe(404);
  });

  it("returns 400 on an unknown verdict", async () => {
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({ verdict: "denied" });
    expect(res.status).toBe(400);
  });

  it("approve maps the submission row to status=approved and emits both events", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({ verdict: "approve", comment: "Looks good." });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      submissionId: submission.id,
      verdict: "approve",
      comment: "Looks good.",
      recordedBy: { kind: "user", id: "reviewer-test" },
    });
    expect(typeof res.body.id).toBe("string");
    expect(typeof res.body.recordedAt).toBe("string");

    const [updated] = await ctx.schema.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submission.id));
    expect(updated.status).toBe("approved");
    expect(updated.reviewerComment).toBe("Looks good.");

    const decisionEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "decision-event"),
          eq(atomEvents.entityId, res.body.id),
        ),
      );
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0].eventType).toBe("decision-event.recorded");
    expect(decisionEvents[0].payload).toMatchObject({
      submissionId: submission.id,
      verdict: "approve",
      comment: "Looks good.",
    });

    const statusEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "submission"),
          eq(atomEvents.entityId, submission.id),
          eq(atomEvents.eventType, "submission.status-changed"),
        ),
      );
    expect(statusEvents).toHaveLength(1);
  });

  it("approve_with_conditions maps to status=approved (carrying the verdict on the event)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({
        verdict: "approve_with_conditions",
        comment: "Subject to fire-rated wall conditions.",
      });
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe("approve_with_conditions");

    const [updated] = await ctx.schema.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submission.id));
    expect(updated.status).toBe("approved");
  });

  it("return_for_revision maps the row to status=corrections_requested", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({ verdict: "return_for_revision" });
    expect(res.status).toBe(201);
    const [updated] = await ctx.schema.db
      .select()
      .from(submissions)
      .where(eq(submissions.id, submission.id));
    expect(updated.status).toBe("corrections_requested");
    expect(updated.reviewerComment).toBeNull();
  });
});

describe("GET /submissions/:submissionId/decisions", () => {
  it("returns recorded decisions newest-first", async () => {
    const { submission } = await seedSubmission();
    await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({ verdict: "return_for_revision", comment: "first" });
    await new Promise((r) => setTimeout(r, 10));
    await request(getApp())
      .post(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS)
      .send({ verdict: "approve", comment: "second" });

    const res = await request(getApp())
      .get(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].verdict).toBe("approve");
    expect(res.body.items[1].verdict).toBe("return_for_revision");
  });

  it("returns 404 for a missing submission", async () => {
    const res = await request(getApp())
      .get("/api/submissions/00000000-0000-0000-0000-000000000000/decisions")
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(404);
  });

  it("returns an empty list when no decisions have been recorded", async () => {
    const { submission } = await seedSubmission();
    const res = await request(getApp())
      .get(`/api/submissions/${submission.id}/decisions`)
      .set(REVIEWER_HEADERS);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });
});

// Reference unused imports so editors don't flag them.
void desc;
