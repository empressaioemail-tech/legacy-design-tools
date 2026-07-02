/**
 * Plan-review BFF — reviewer tool reads are unscoped by engagement owner.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  engagements,
  submissions,
  findings,
  attachedDocuments,
} from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

// No-network vision: the singleton returns a valid bbox JSON text block.
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }),
          },
        ],
      })),
    },
  },
  createAnthropicClient: vi.fn(),
}));

// Stub the rasterize/page-count/vision-extract pipeline so the runner logic
// (idempotency, asserted confidence, DB insert) is what's under test — no
// poppler binary, no object-storage fetch dependency for coordinates.
vi.mock("../lib/annotationPipeline", () => ({
  getPdfPageCount: vi.fn(async () => 1),
  rasterizePdfPage: vi.fn(async () => ""),
  extractAnnotationCoordinates: vi.fn(async () => ({
    x: 0.1,
    y: 0.1,
    width: 0.2,
    height: 0.2,
  })),
}));

// The runner fetches object bytes before calling getPdfPageCount; stub the
// storage read so the (mocked) page-count path still runs.
vi.mock("../lib/objectStorage", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/objectStorage")>(
      "../lib/objectStorage",
    );
  return {
    ...actual,
    ObjectStorageService: class {
      async getObjectEntityBytes(): Promise<Buffer> {
        return Buffer.from("%PDF-1.4 stub");
      }
    },
  };
});

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("planReviewBff.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("plan-review BFF reviewer reads", () => {
  beforeEach(async () => {
    await db.insert(engagements).values({
      name: "146 S Fredricksburg",
      nameLower: "146 s fredricksburg",
      ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
      jurisdiction: "bastrop-tx",
      address: "146 S Fredricksburg, Bastrop TX",
    });
  });

  it("GET /plan-review/engagements/:id returns engagement without session ownership", async () => {
    const [row] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.nameLower, "146 s fredricksburg"));

    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${row!.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row!.id);
    expect(res.body.name).toBe("146 S Fredricksburg");
    expect(res.body.jurisdiction).toBe("bastrop-tx");
  });

  it("GET /plan-review/engagements/:id returns 404 when id missing", async () => {
    const res = await request(getApp()).get(
      "/api/plan-review/engagements/00000000-0000-0000-0000-000000000000",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("GET /plan-review/engagements/:id/submissions lists submissions without session ownership", async () => {
    const [engagement] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.nameLower, "146 s fredricksburg"));

    await db.insert(submissions).values({
      engagementId: engagement!.id,
      jurisdiction: "bastrop-tx",
      note: "Permit set v1",
      status: "submitted",
    });

    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagement!.id}/submissions`,
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].note).toBe("Permit set v1");
    expect(res.body[0].findingGenerationState).toBe("idle");
  });

  it("GET /plan-review/engagements/:id/submissions returns 404 when engagement missing", async () => {
    const res = await request(getApp()).get(
      "/api/plan-review/engagements/00000000-0000-0000-0000-000000000000/submissions",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });
});

describe("plan-review annotation generation", () => {
  /** Seed an engagement + submission + one blocker finding + a PDF doc. */
  async function seedEngagementWithFailingFinding(): Promise<{
    engagementId: string;
    submissionId: string;
    findingId: string;
  }> {
    const [engagement] = await db
      .insert(engagements)
      .values({
        name: "Annotation Test Engagement",
        nameLower: "annotation test engagement",
        ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
        jurisdiction: "bastrop-tx",
        address: "1 Annotation Way, Bastrop TX",
      })
      .returning();

    const [submission] = await db
      .insert(submissions)
      .values({
        engagementId: engagement!.id,
        jurisdiction: "bastrop-tx",
        note: "Permit set v1",
        status: "pending",
      })
      .returning();

    const [finding] = await db
      .insert(findings)
      .values({
        atomId: `finding:${submission!.id}:seed-1`,
        submissionId: submission!.id,
        severity: "blocker",
        category: "setback",
        status: "ai-produced",
        text: "Front setback of 12 ft is below the 25 ft minimum.",
        confidence: "0.9",
        aiGeneratedAt: new Date(),
      })
      .returning();

    await db.insert(attachedDocuments).values({
      engagementId: engagement!.id,
      title: "Permit Set.pdf",
      documentType: "narrative",
      originalBlobRef: "/objects/permit-set-1",
    });

    return {
      engagementId: engagement!.id,
      submissionId: submission!.id,
      findingId: finding!.id,
    };
  }

  /** Poll the job status endpoint until done/error or the bound is hit. */
  async function pollUntilDone(
    engagementId: string,
    jobId: string,
  ): Promise<{ status: string; progress: number; total: number }> {
    for (let i = 0; i < 20; i += 1) {
      const res = await request(getApp()).get(
        `/api/plan-review/engagements/${engagementId}/annotations/generate/${jobId}`,
      );
      if (res.status === 200 && (res.body.status === "done" || res.body.status === "error")) {
        return res.body;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("annotation job did not finish within poll bound");
  }

  it("generates exactly one ai annotation with asserted confidence", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithFailingFinding();

    const genRes = await request(getApp())
      .post(`/api/plan-review/engagements/${engagementId}/annotations/generate`)
      .send({ submissionId });

    expect(genRes.status).toBe(202);
    expect(typeof genRes.body.jobId).toBe("string");

    const final = await pollUntilDone(engagementId, genRes.body.jobId);
    expect(final.status).toBe("done");

    const listRes = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/annotations`,
    );
    expect(listRes.status).toBe(200);
    const aiAnnotations = (listRes.body.annotations as Array<{
      author: string;
      confidence?: { value: number; kind: string };
    }>).filter((a) => a.author === "ai");
    expect(aiAnnotations).toHaveLength(1);
    expect(aiAnnotations[0]!.confidence!.kind).toBe("asserted");
    expect(aiAnnotations[0]!.confidence!.value).toBe(0.75);
  });

  it("is idempotent — a second generate run creates no duplicate", async () => {
    const { engagementId, submissionId } =
      await seedEngagementWithFailingFinding();

    const first = await request(getApp())
      .post(`/api/plan-review/engagements/${engagementId}/annotations/generate`)
      .send({ submissionId });
    await pollUntilDone(engagementId, first.body.jobId);

    const second = await request(getApp())
      .post(`/api/plan-review/engagements/${engagementId}/annotations/generate`)
      .send({ submissionId });
    await pollUntilDone(engagementId, second.body.jobId);

    const listRes = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/annotations`,
    );
    expect(listRes.status).toBe(200);
    const aiAnnotations = (listRes.body.annotations as Array<{
      author: string;
    }>).filter((a) => a.author === "ai");
    expect(aiAnnotations).toHaveLength(1);
  });

  it("returns 400 when submissionId is missing", async () => {
    const { engagementId } = await seedEngagementWithFailingFinding();
    const res = await request(getApp())
      .post(`/api/plan-review/engagements/${engagementId}/annotations/generate`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_submission_id");
  });

  it("returns 404 for an unknown jobId", async () => {
    const { engagementId } = await seedEngagementWithFailingFinding();
    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagementId}/annotations/generate/00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("job_not_found");
  });
});
