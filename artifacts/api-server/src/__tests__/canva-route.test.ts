/**
 * Canva Connect routes — connection, assets, push job lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { randomUUID } from "node:crypto";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("canva-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, canvaConnections } = await import("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function seedEngagement() {
  const id = randomUUID();
  await ctx.schema!.db.insert(engagements).values({
    id,
    name: "Canva Test Engagement",
    nameLower: "canva test engagement",
    address: "1 Main St",
    jurisdiction: "Demo",
  });
  return id;
}

describe("GET /api/canva/connection", () => {
  it("returns disconnected when no row exists", async () => {
    const res = await request(getApp()).get("/api/canva/connection");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "disconnected" });
  });
});

describe("POST /api/canva/oauth/dev-connect", () => {
  it("marks the session connected in non-production", async () => {
    const res = await request(getApp()).post("/api/canva/oauth/dev-connect");
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("connected");
    expect(res.body.displayName).toContain("dev");
  });
});

describe("engagement canva assets + push", () => {
  let engagementId: string;

  beforeEach(async () => {
    engagementId = await seedEngagement();
    await request(getApp()).post("/api/canva/oauth/dev-connect");
  });

  it("lists assets for a valid engagement", async () => {
    const res = await request(getApp()).get(
      `/api/engagements/${engagementId}/canva/assets`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns brand templates", async () => {
    const res = await request(getApp()).get("/api/canva/brand-templates");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      slots: expect.any(Array),
    });
  });

  it("runs a push job to ready without Canva credentials", async () => {
    const pushRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/canva/push`)
      .send({
        engagementId,
        templateId: "tpl-proposal",
        assetIds: [],
        slotMapping: {},
        textFields: { project_name: "Test" },
        uploadAssetsOnly: true,
      });
    expect(pushRes.status).toBe(202);
    const jobId = pushRes.body.jobId;
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    let job = pushRes.body;
    for (let i = 0; i < 20; i++) {
      const poll = await request(getApp()).get(`/api/canva/push-jobs/${jobId}`);
      expect(poll.status).toBe(200);
      job = poll.body;
      if (job.step === "ready" || job.step === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(job.step).toBe("ready");
    expect(job.designUrl).toBeTruthy();

    const history = await request(getApp()).get(
      `/api/engagements/${engagementId}/canva/designs`,
    );
    expect(history.status).toBe(200);
    expect(history.body.length).toBeGreaterThan(0);
  });

  it("DELETE /api/canva/connection clears the row", async () => {
    const del = await request(getApp()).delete("/api/canva/connection");
    expect(del.status).toBe(204);
    const rows = await ctx.schema!.db.select().from(canvaConnections);
    expect(rows).toHaveLength(0);
  });
});
