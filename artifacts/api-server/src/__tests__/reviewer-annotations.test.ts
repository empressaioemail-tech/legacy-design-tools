/**
 * /api/submissions/:submissionId/reviewer-annotations route tests
 * (Wave 2 Sprint C / Spec 307).
 *
 * Coverage:
 *   - Audience gate: every endpoint 403s when the caller is not
 *     `internal` audience.
 *   - List + create round-trip: a freshly-created annotation appears
 *     in the list response, scoped to the submission and matching
 *     `targetEntityType` + `targetEntityId` filters.
 *   - Threaded reply: top-level emits `reviewer-annotation.created`,
 *     reply emits `reviewer-annotation.replied`. Reply against a
 *     reply 400s (single-level threading).
 *   - PATCH edits body / category, no-op body returns the unchanged
 *     row, promoted annotations 409 on PATCH (immutability).
 *   - Promote: bulk multi-promote returns
 *     `{promoted, alreadyPromoted, unknown}` correctly, emits one
 *     `reviewer-annotation.promoted` event per row, idempotent on
 *     re-promote.
 *   - Per-submission scoping: an annotation under one submission is
 *     never visible from another submission's list / patch / promote.
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
        throw new Error("reviewer-annotations.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions, reviewerAnnotations, atomEvents } =
  await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_AUDIENCE_HEADER = ["x-audience", "internal"] as const;
const REVIEWER_REQUESTOR_HEADER = ["x-requestor", "user:reviewer-1"] as const;

function asReviewer<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(REVIEWER_AUDIENCE_HEADER[0], REVIEWER_AUDIENCE_HEADER[1])
    .set(REVIEWER_REQUESTOR_HEADER[0], REVIEWER_REQUESTOR_HEADER[1]);
}

async function seedSubmission(
  name = "Reviewer Annotation Submission",
): Promise<{ engagementId: string; submissionId: string }> {
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
    })
    .returning();
  return { engagementId: eng.id, submissionId: sub.id };
}

describe("GET /api/submissions/:id/reviewer-annotations", () => {
  it("403s when the caller is not internal audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp()).get(
      `/api/submissions/${submissionId}/reviewer-annotations`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_annotations_require_internal_audience",
    );
  });

  it("returns an empty list for a fresh submission", async () => {
    const { submissionId } = await seedSubmission();
    const res = await asReviewer(
      request(getApp()).get(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ annotations: [] });
  });

  it("404s when the submission does not exist", async () => {
    const res = await asReviewer(
      request(getApp()).get(
        `/api/submissions/00000000-0000-0000-0000-000000000000/reviewer-annotations`,
      ),
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("submission_not_found");
  });

  it("filters by target tuple", async () => {
    const { submissionId } = await seedSubmission();
    await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "On the submission itself.",
    });
    await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "sheet",
      targetEntityId: "sheet-A101",
      body: "On the sheet.",
    });

    const all = await asReviewer(
      request(getApp()).get(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    );
    expect(all.body.annotations).toHaveLength(2);

    const sheetOnly = await asReviewer(
      request(getApp()).get(
        `/api/submissions/${submissionId}/reviewer-annotations?targetEntityType=sheet&targetEntityId=sheet-A101`,
      ),
    );
    expect(sheetOnly.body.annotations).toHaveLength(1);
    expect(sheetOnly.body.annotations[0].targetEntityType).toBe("sheet");
  });
});

describe("POST /api/submissions/:id/reviewer-annotations", () => {
  it("creates a top-level annotation and emits reviewer-annotation.created", async () => {
    const { submissionId } = await seedSubmission();
    const res = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Initial concern.",
      category: "concern",
    });
    expect(res.status).toBe(201);
    expect(res.body.annotation.body).toBe("Initial concern.");
    expect(res.body.annotation.category).toBe("concern");
    expect(res.body.annotation.reviewerId).toBe("reviewer-1");
    expect(res.body.annotation.parentAnnotationId).toBeNull();
    expect(res.body.annotation.promotedAt).toBeNull();

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, res.body.annotation.id));
    expect(events.some((e) => e.eventType === "reviewer-annotation.created")).toBe(
      true,
    );
  });

  it("defaults category to 'note' when omitted", async () => {
    const { submissionId } = await seedSubmission();
    const res = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Casual note.",
    });
    expect(res.status).toBe(201);
    expect(res.body.annotation.category).toBe("note");
  });

  it("403s when the caller is not internal audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp())
      .post(`/api/submissions/${submissionId}/reviewer-annotations`)
      .send({
        targetEntityType: "submission",
        targetEntityId: submissionId,
        body: "Should be rejected.",
      });
    expect(res.status).toBe(403);
  });

  it("creates a reply (parentAnnotationId) and emits reviewer-annotation.replied", async () => {
    const { submissionId } = await seedSubmission();
    const root = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Root.",
    });
    const rootId = root.body.annotation.id as string;

    const reply = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Reply.",
      parentAnnotationId: rootId,
    });
    expect(reply.status).toBe(201);
    expect(reply.body.annotation.parentAnnotationId).toBe(rootId);

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, reply.body.annotation.id));
    expect(events.some((e) => e.eventType === "reviewer-annotation.replied")).toBe(
      true,
    );
  });

  it("400s when replying to another reply (single-level threading)", async () => {
    const { submissionId } = await seedSubmission();
    const root = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Root.",
    });
    const reply = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Reply.",
      parentAnnotationId: root.body.annotation.id,
    });
    const replyOfReply = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Nope.",
      parentAnnotationId: reply.body.annotation.id,
    });
    expect(replyOfReply.status).toBe(400);
    expect(replyOfReply.body.error).toBe(
      "parent_annotation_must_be_top_level",
    );
  });

  it("400s when the parent annotation belongs to a different submission", async () => {
    const a = await seedSubmission("Submission A");
    const b = await seedSubmission("Submission B");
    const rootA = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${a.submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: a.submissionId,
      body: "Root in A.",
    });
    const replyInB = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${b.submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: b.submissionId,
      body: "Cross-submission reply.",
      parentAnnotationId: rootA.body.annotation.id,
    });
    expect(replyInB.status).toBe(400);
    expect(replyInB.body.error).toBe(
      "parent_annotation_submission_mismatch",
    );
  });
});

describe("PATCH /api/submissions/:id/reviewer-annotations/:annotationId", () => {
  it("updates body and category", async () => {
    const { submissionId } = await seedSubmission();
    const create = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Initial.",
      category: "note",
    });
    const id = create.body.annotation.id as string;

    const patch = await asReviewer(
      request(getApp()).patch(
        `/api/submissions/${submissionId}/reviewer-annotations/${id}`,
      ),
    ).send({ body: "Updated.", category: "concern" });
    expect(patch.status).toBe(200);
    expect(patch.body.annotation.body).toBe("Updated.");
    expect(patch.body.annotation.category).toBe("concern");
  });

  it("returns the unchanged row on an empty patch body (no-op)", async () => {
    const { submissionId } = await seedSubmission();
    const create = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Body.",
    });
    const id = create.body.annotation.id as string;
    const patch = await asReviewer(
      request(getApp()).patch(
        `/api/submissions/${submissionId}/reviewer-annotations/${id}`,
      ),
    ).send({});
    expect(patch.status).toBe(200);
    expect(patch.body.annotation.body).toBe("Body.");
  });

  it("404s for an annotation under another submission", async () => {
    const a = await seedSubmission("A");
    const b = await seedSubmission("B");
    const create = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${a.submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: a.submissionId,
      body: "In A.",
    });
    const id = create.body.annotation.id as string;
    const patch = await asReviewer(
      request(getApp()).patch(
        `/api/submissions/${b.submissionId}/reviewer-annotations/${id}`,
      ),
    ).send({ body: "Tampered." });
    expect(patch.status).toBe(404);
  });

  it("409s when the annotation has already been promoted", async () => {
    const { submissionId } = await seedSubmission();
    const create = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "Will be promoted.",
    });
    const id = create.body.annotation.id as string;
    const promote = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations/promote`,
      ),
    ).send({ annotationIds: [id] });
    expect(promote.status).toBe(200);

    const patch = await asReviewer(
      request(getApp()).patch(
        `/api/submissions/${submissionId}/reviewer-annotations/${id}`,
      ),
    ).send({ body: "Tamper after promote." });
    expect(patch.status).toBe(409);
    expect(patch.body.error).toBe("annotation_promoted_immutable");
  });
});

describe("POST /api/submissions/:id/reviewer-annotations/promote", () => {
  it("multi-promotes a mix of unknown / known / already-promoted ids", async () => {
    const { submissionId } = await seedSubmission();
    const a = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "A.",
    });
    const b = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: submissionId,
      body: "B.",
    });
    const aId = a.body.annotation.id as string;
    const bId = b.body.annotation.id as string;

    // Promote A first so the second call lands it in `alreadyPromoted`.
    await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations/promote`,
      ),
    ).send({ annotationIds: [aId] });

    const res = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations/promote`,
      ),
    ).send({
      annotationIds: [
        aId,
        bId,
        "00000000-0000-0000-0000-000000000000",
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.promoted.map((r: { id: string }) => r.id)).toEqual([bId]);
    expect(res.body.alreadyPromoted.map((r: { id: string }) => r.id)).toEqual(
      [aId],
    );
    expect(res.body.unknown).toEqual(["00000000-0000-0000-0000-000000000000"]);

    if (!ctx.schema) throw new Error("ctx.schema not set");
    const promotedEvents = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bId));
    expect(
      promotedEvents.filter((e) => e.eventType === "reviewer-annotation.promoted"),
    ).toHaveLength(1);

    // Re-promoting B is a no-op (idempotent: already-promoted, no
    // second event emitted).
    const repeat = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${submissionId}/reviewer-annotations/promote`,
      ),
    ).send({ annotationIds: [bId] });
    expect(repeat.body.promoted).toEqual([]);
    expect(repeat.body.alreadyPromoted.map((r: { id: string }) => r.id)).toEqual(
      [bId],
    );
    const eventsAfterRepeat = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(eq(atomEvents.entityId, bId));
    expect(
      eventsAfterRepeat.filter(
        (e) => e.eventType === "reviewer-annotation.promoted",
      ),
    ).toHaveLength(1);
  });

  it("403s when the caller is not internal audience", async () => {
    const { submissionId } = await seedSubmission();
    const res = await request(getApp())
      .post(
        `/api/submissions/${submissionId}/reviewer-annotations/promote`,
      )
      .send({ annotationIds: ["00000000-0000-0000-0000-000000000000"] });
    expect(res.status).toBe(403);
  });

  it("404s when the submission does not exist", async () => {
    const res = await asReviewer(
      request(getApp()).post(
        `/api/submissions/00000000-0000-0000-0000-000000000000/reviewer-annotations/promote`,
      ),
    ).send({ annotationIds: ["whatever"] });
    expect(res.status).toBe(404);
  });

  it("scopes promote to the submission (cross-submission ids land in unknown)", async () => {
    const a = await seedSubmission("A");
    const b = await seedSubmission("B");
    const inA = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${a.submissionId}/reviewer-annotations`,
      ),
    ).send({
      targetEntityType: "submission",
      targetEntityId: a.submissionId,
      body: "In A.",
    });
    const res = await asReviewer(
      request(getApp()).post(
        `/api/submissions/${b.submissionId}/reviewer-annotations/promote`,
      ),
    ).send({ annotationIds: [inA.body.annotation.id] });
    expect(res.status).toBe(200);
    expect(res.body.promoted).toEqual([]);
    expect(res.body.alreadyPromoted).toEqual([]);
    expect(res.body.unknown).toEqual([inA.body.annotation.id]);

    if (!ctx.schema) throw new Error("ctx.schema not set");
    // Confirm the annotation in A was NOT promoted as a side effect.
    const rows = await ctx.schema.db
      .select()
      .from(reviewerAnnotations)
      .where(eq(reviewerAnnotations.id, inA.body.annotation.id));
    expect(rows[0].promotedAt).toBeNull();
  });
});
