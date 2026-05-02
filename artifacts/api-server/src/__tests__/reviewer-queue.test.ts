/**
 * /api/reviewer/queue route tests.
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
        throw new Error("reviewer-queue.test: ctx.schema not set");
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

const REVIEWER_AUDIENCE_HEADER = ["x-audience", "internal"] as const;
const REVIEWER_REQUESTOR_HEADER = ["x-requestor", "user:reviewer-1"] as const;
const ARCHITECT_AUDIENCE_HEADER = ["x-audience", "user"] as const;
const ARCHITECT_REQUESTOR_HEADER = ["x-requestor", "user:architect-1"] as const;

function asReviewer<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(REVIEWER_AUDIENCE_HEADER[0], REVIEWER_AUDIENCE_HEADER[1])
    .set(REVIEWER_REQUESTOR_HEADER[0], REVIEWER_REQUESTOR_HEADER[1]);
}

function asArchitect<T extends { set: (h: string, v: string) => T }>(
  req: T,
): T {
  return req
    .set(ARCHITECT_AUDIENCE_HEADER[0], ARCHITECT_AUDIENCE_HEADER[1])
    .set(ARCHITECT_REQUESTOR_HEADER[0], ARCHITECT_REQUESTOR_HEADER[1]);
}

interface SeedSubmission {
  status?: "pending" | "approved" | "corrections_requested" | "rejected";
  submittedAt?: Date;
  note?: string | null;
  reviewerComment?: string | null;
}

async function seedEngagement(opts: {
  name?: string;
  jurisdiction?: string;
  address?: string;
  applicantFirm?: string | null;
  submissions?: SeedSubmission[];
}): Promise<{
  engagementId: string;
  submissionIds: string[];
}> {
  if (!ctx.schema) throw new Error("ctx.schema not set");
  const db = ctx.schema.db;
  const name = opts.name ?? "Reviewer Queue Engagement";
  const [eng] = await db
    .insert(engagements)
    .values({
      name,
      nameLower: name.trim().toLowerCase(),
      jurisdiction: opts.jurisdiction ?? "Bastrop, TX",
      address: opts.address ?? "1 Reviewer Way",
      applicantFirm: opts.applicantFirm ?? null,
      status: "active",
    })
    .returning({ id: engagements.id });

  const submissionIds: string[] = [];
  for (const s of opts.submissions ?? []) {
    const [sub] = await db
      .insert(submissions)
      .values({
        engagementId: eng.id,
        jurisdiction: opts.jurisdiction ?? "Bastrop, TX",
        jurisdictionCity: "Bastrop",
        jurisdictionState: "TX",
        jurisdictionFips: "4806632",
        note: s.note ?? "Permit set v1.",
        reviewerComment: s.reviewerComment ?? null,
        status: s.status ?? "pending",
        ...(s.submittedAt ? { submittedAt: s.submittedAt } : {}),
      })
      .returning({ id: submissions.id });
    submissionIds.push(sub.id);
  }

  return { engagementId: eng.id, submissionIds };
}

describe("GET /api/reviewer/queue", () => {
  it("403s when the caller is not internal audience", async () => {
    const res = await asArchitect(
      request(getApp()).get("/api/reviewer/queue"),
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_queue_requires_internal_audience",
    );
  });

  it("403s when no audience header is set", async () => {
    const res = await request(getApp()).get("/api/reviewer/queue");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(
      "reviewer_queue_requires_internal_audience",
    );
  });

  it("returns an empty queue + zeroed counts on a fresh schema", async () => {
    const res = await asReviewer(request(getApp()).get("/api/reviewer/queue"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      counts: { inReview: 0, awaitingAi: 0, rejected: 0, backlog: 0 },
    });
  });

  it("returns only pending + corrections_requested by default, joined to engagement metadata", async () => {
    const a = await seedEngagement({
      name: "Riverside Clinic",
      jurisdiction: "Bastrop, TX",
      address: "100 River Rd",
      applicantFirm: "Civic Design LLC",
      submissions: [
        { status: "pending", note: "AI run pending" },
        { status: "approved", note: "Done" },
      ],
    });
    const b = await seedEngagement({
      name: "Lost Pines Townhomes",
      jurisdiction: "Smithville, TX",
      address: "200 Pine Ave",
      submissions: [
        {
          status: "corrections_requested",
          reviewerComment: "Resubmit with revised egress",
        },
        { status: "rejected", reviewerComment: "Out of scope" },
      ],
    });

    const res = await asReviewer(request(getApp()).get("/api/reviewer/queue"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);

    const statuses = res.body.items
      .map((it: { status: string }) => it.status)
      .sort();
    expect(statuses).toEqual(["corrections_requested", "pending"]);

    const byEngagement: Record<
      string,
      {
        engagementName: string;
        jurisdiction: string | null;
        address: string | null;
        applicantFirm: string | null;
      }
    > = {};
    for (const it of res.body.items) {
      byEngagement[it.engagementId] = {
        engagementName: it.engagementName,
        jurisdiction: it.jurisdiction,
        address: it.address,
        applicantFirm: it.applicantFirm,
      };
    }
    expect(byEngagement[a.engagementId]).toEqual({
      engagementName: "Riverside Clinic",
      jurisdiction: "Bastrop, TX",
      address: "100 River Rd",
      applicantFirm: "Civic Design LLC",
    });
    expect(byEngagement[b.engagementId]).toEqual({
      engagementName: "Lost Pines Townhomes",
      jurisdiction: "Smithville, TX",
      address: "200 Pine Ave",
      applicantFirm: null,
    });

    // Counts span the whole submissions table, not the filtered slice.
    expect(res.body.counts).toEqual({
      awaitingAi: 1,
      inReview: 1,
      rejected: 1,
      backlog: 2,
    });
  });

  it("orders items newest-first across engagements", async () => {
    const oldest = new Date("2026-01-01T00:00:00Z");
    const middle = new Date("2026-02-15T00:00:00Z");
    const newest = new Date("2026-04-30T12:00:00Z");

    const a = await seedEngagement({
      name: "Old Iron Bridge Plaza",
      submissions: [{ status: "pending", submittedAt: oldest }],
    });
    const b = await seedEngagement({
      name: "Highland Estates",
      submissions: [
        { status: "corrections_requested", submittedAt: newest },
      ],
    });
    const c = await seedEngagement({
      name: "Cedar Park Lofts",
      submissions: [{ status: "pending", submittedAt: middle }],
    });

    const res = await asReviewer(request(getApp()).get("/api/reviewer/queue"));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    expect(
      res.body.items.map((it: { engagementId: string }) => it.engagementId),
    ).toEqual([b.engagementId, c.engagementId, a.engagementId]);

    expect(res.body.items[0].submittedAt).toBe(newest.toISOString());
    expect(res.body.items[2].submittedAt).toBe(oldest.toISOString());
  });

  it("narrows items via ?status= CSV but keeps counts denominator-whole", async () => {
    await seedEngagement({
      name: "Mixed Status Engagement",
      submissions: [
        { status: "pending" },
        { status: "pending" },
        { status: "corrections_requested" },
        { status: "approved" },
        { status: "rejected" },
      ],
    });

    {
      const res = await asReviewer(
        request(getApp()).get("/api/reviewer/queue?status=pending"),
      );
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(
        res.body.items.every(
          (it: { status: string }) => it.status === "pending",
        ),
      ).toBe(true);
      expect(res.body.counts).toEqual({
        awaitingAi: 2,
        inReview: 1,
        rejected: 1,
        backlog: 3,
      });
    }

    {
      const res = await asReviewer(
        request(getApp()).get(
          "/api/reviewer/queue?status=approved,rejected",
        ),
      );
      expect(res.status).toBe(200);
      const statuses = res.body.items
        .map((it: { status: string }) => it.status)
        .sort();
      expect(statuses).toEqual(["approved", "rejected"]);
    }
  });

  it("treats ?status= (empty string) as the default filter", async () => {
    await seedEngagement({
      name: "Empty Status Engagement",
      submissions: [{ status: "pending" }, { status: "approved" }],
    });

    const res = await asReviewer(
      request(getApp()).get("/api/reviewer/queue?status="),
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].status).toBe("pending");
  });

  it("400s on an unknown status value", async () => {
    const res = await asReviewer(
      request(getApp()).get(
        "/api/reviewer/queue?status=pending,bogus",
      ),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid status filter");
    expect(res.body.detail).toContain("pending");
  });

  it("dedupes repeated status values in the CSV", async () => {
    await seedEngagement({
      name: "Dedupe Engagement",
      submissions: [{ status: "pending" }, { status: "pending" }],
    });

    const res = await asReviewer(
      request(getApp()).get(
        "/api/reviewer/queue?status=pending,pending",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });
});
