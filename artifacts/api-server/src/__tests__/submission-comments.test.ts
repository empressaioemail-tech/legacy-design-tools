/**
 * /api/submissions/:submissionId/comments route tests (Task #431).
 *
 * Coverage:
 *   - Audience gate: both endpoints 403 when the caller is not
 *     `internal` audience (route error code:
 *     `submission_comments_require_internal_audience`).
 *   - Architect post + view: an architect-tagged POST appears in
 *     the GET listing with the author role/id preserved.
 *   - Reviewer post + view: a reviewer-tagged POST coexists with
 *     architect rows in the same thread, returned chronologically.
 *   - Cross-submission scoping: a comment under submission A is
 *     never visible from submission B's listing.
 *   - Missing session requestor: a POST without a requestor 400s
 *     rather than stamping an anonymous author id.
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
        throw new Error("submission-comments.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const INTERNAL_AUDIENCE_HEADER = ["x-audience", "internal"] as const;

function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(INTERNAL_AUDIENCE_HEADER[0], INTERNAL_AUDIENCE_HEADER[1])
    .set("x-requestor", "user:architect-1");
}

function asReviewer<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(INTERNAL_AUDIENCE_HEADER[0], INTERNAL_AUDIENCE_HEADER[1])
    .set("x-requestor", "user:reviewer-1");
}

async function seedSubmission(
  name = "Submission Comments Engagement",
): Promise<{ engagementId: string; submissionId: string }> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const db = ctx.schema.db;
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: "Moab, UT",
      address: "1 Comment Way",
      status: "active",
    })
    .returning();
  const [sub] = await db
    .insert(submissions)
    .values({
      engagementId: eng.id,
      jurisdiction: "Moab, UT",
      jurisdictionCity: "Moab",
      jurisdictionState: "UT",
      jurisdictionFips: "4950150",
      note: "Permit set v1.",
      reviewerComment: "Please clarify egress on level 2.",
    })
    .returning();
  return { engagementId: eng.id, submissionId: sub.id };
}

describe("GET /api/submissions/:id/comments", () => {
  it("403s when the caller is not internal audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp()).get(
      `/api/submissions/${submissionId}/comments`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "submission_comments_require_internal_audience",
    );
  });

  it("returns an empty list for a fresh submission", async () => {
    const { submissionId } = await seedSubmission();
    const res = await asArchitect(
      request(getApp()).get(`/api/submissions/${submissionId}/comments`),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ comments: [] });
  });

  it("404s when the submission does not exist", async () => {
    const res = await asArchitect(
      request(getApp()).get(
        `/api/submissions/00000000-0000-0000-0000-000000000000/comments`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("submission_not_found");
  });
});

describe("POST /api/submissions/:id/comments", () => {
  it("403s when the caller is not internal audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submissionId}/comments`)
      .send({ authorRole: "architect", body: "Reply." });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "submission_comments_require_internal_audience",
    );
  });

  it("400s when the request body is invalid", async () => {
    const { submissionId } = await seedSubmission();
    const res = await asArchitect(
      request(getApp()).post(`/api/submissions/${submissionId}/comments`),
    ).send({ authorRole: "architect", body: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request_body");
  });

  it("400s when the session has no requestor", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submissionId}/comments`)
      .set("x-audience", "internal")
      .send({ authorRole: "architect", body: "Hello." });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_session_requestor");
  });

  it("creates an architect-tagged row that the GET surfaces", async () => {
    const { submissionId } = await seedSubmission();
    const post = await asArchitect(
      request(getApp()).post(`/api/submissions/${submissionId}/comments`),
    ).send({
      authorRole: "architect",
      body: "Egress sized for 50 occupants — see sheet A2.01.",
    });
    expect(post.status).toBe(201);
    expect(post.body.comment.authorRole).toBe("architect");
    expect(post.body.comment.authorId).toBe("architect-1");
    expect(post.body.comment.submissionId).toBe(submissionId);

    const list = await asArchitect(
      request(getApp()).get(`/api/submissions/${submissionId}/comments`),
    );
    expect(list.status).toBe(200);
    expect(list.body.comments).toHaveLength(1);
    expect(list.body.comments[0].id).toBe(post.body.comment.id);
    expect(list.body.comments[0].body).toContain("Egress sized for 50");
  });
});

describe("submission comment thread (round-trip)", () => {
  it("returns reviewer + architect rows in chronological order", async () => {
    const { submissionId } = await seedSubmission();
    const first = await asArchitect(
      request(getApp()).post(`/api/submissions/${submissionId}/comments`),
    ).send({ authorRole: "architect", body: "First — architect reply." });
    expect(first.status).toBe(201);
    // Tiny sleep so the two rows have distinct created_at timestamps
    // even on fast CI hardware where timer resolution might collide.
    await new Promise((r) => setTimeout(r, 5));
    const second = await asReviewer(
      request(getApp()).post(`/api/submissions/${submissionId}/comments`),
    ).send({ authorRole: "reviewer", body: "Second — reviewer follow-up." });
    expect(second.status).toBe(201);

    const list = await asArchitect(
      request(getApp()).get(`/api/submissions/${submissionId}/comments`),
    );
    expect(list.status).toBe(200);
    expect(list.body.comments).toHaveLength(2);
    // Oldest-first chronological — architect row first, reviewer
    // follow-up second. Roles preserved verbatim from the request.
    expect(list.body.comments[0].authorRole).toBe("architect");
    expect(list.body.comments[0].body).toContain("architect reply");
    expect(list.body.comments[1].authorRole).toBe("reviewer");
    expect(list.body.comments[1].body).toContain("reviewer follow-up");
  });

  it("scopes comments per submission", async () => {
    const a = await seedSubmission("Scoping A");
    const b = await seedSubmission("Scoping B");
    await asArchitect(
      request(getApp()).post(`/api/submissions/${a.submissionId}/comments`),
    ).send({ authorRole: "architect", body: "Comment on A." });

    const listB = await asArchitect(
      request(getApp()).get(`/api/submissions/${b.submissionId}/comments`),
    );
    expect(listB.status).toBe(200);
    expect(listB.body.comments).toEqual([]);

    const listA = await asArchitect(
      request(getApp()).get(`/api/submissions/${a.submissionId}/comments`),
    );
    expect(listA.body.comments).toHaveLength(1);
    expect(listA.body.comments[0].body).toBe("Comment on A.");
  });
});
