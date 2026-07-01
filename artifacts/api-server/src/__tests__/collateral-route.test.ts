/**
 * Placid collateral routes — templates, export job lifecycle, signed fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("collateral-route.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/collateral/config", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/collateral/config")>();
  return {
    ...actual,
    isPlacidConfigured: () => false,
  };
});

vi.mock("../lib/collateral/placidClient", () => ({
  createPlacidPdf: vi.fn(),
  getPlacidPdf: vi.fn(),
}));

const { setupRouteTests } = await import("./setup");
let getApp: () => Express;
const signingSecret = "test-collateral-signing-secret-32b!!";

/** Background export jobs outlive the HTTP response — drain before teardown. */
const pendingExportJobIds: string[] = [];

async function waitForExportJobTerminal(
  jobId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const poll = await request(getApp()).get(
      `/api/collateral/export-jobs/${jobId}`,
    );
    if (poll.status === 200) {
      const step = poll.body.step as string;
      if (step === "ready" || step === "failed") return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`export job ${jobId} did not reach a terminal state`);
}

setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  process.env.COLLATERAL_SIGNING_SECRET = signingSecret;
  delete process.env.PLACID_API_TOKEN;
  delete process.env.PLACID_TEST_MODE;
});

afterEach(async () => {
  delete process.env.PLACID_API_TOKEN;
  const jobs = pendingExportJobIds.splice(0);
  for (const jobId of jobs) {
    await waitForExportJobTerminal(jobId);
  }
});

async function seedEngagement() {
  const id = randomUUID();
  await ctx.schema!.db.execute(sql`
    INSERT INTO engagements (id, name, name_lower, jurisdiction, address)
    VALUES (${id}, ${"Collateral Test Engagement"}, ${"collateral test engagement"}, ${"Demo"}, ${"9 Export Ave"})
  `);
  return id;
}

describe("GET /api/collateral/templates", () => {
  it("returns client presentation pack", async () => {
    const res = await request(getApp()).get("/api/collateral/templates");
    expect(res.status).toBe(200);
    expect(res.body.some((t: { id: string }) => t.id === "client-presentation")).toBe(
      true,
    );
  });
});

describe("collateral export job", () => {
  let engagementId: string;

  beforeEach(async () => {
    engagementId = await seedEngagement();
  });

  it("runs export to ready without Placid token (dev stub)", async () => {
    const exportRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/collateral/export`)
      .send({
        engagementId,
        templatePackId: "client-presentation",
        assetIds: [],
        slotMapping: {},
        textFields: {
          project_name: "Test Tower",
          headline: "A bold vision",
          address: "9 Export Ave",
          talking_points: "Sustainable design",
        },
        sheetAssetIds: [],
      });
    expect(exportRes.status).toBe(202);
    const jobId = exportRes.body.jobId;
    pendingExportJobIds.push(jobId);
    expect(jobId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(exportRes.body.creditsEstimated).toBeGreaterThan(0);

    let job = exportRes.body;
    for (let i = 0; i < 25; i++) {
      const poll = await request(getApp()).get(
        `/api/collateral/export-jobs/${jobId}`,
      );
      expect(poll.status).toBe(200);
      job = poll.body;
      if (job.step === "ready" || job.step === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(job.step).toBe("ready");
    expect(job.downloadUrl).toBeTruthy();

    const history = await request(getApp()).get(
      `/api/engagements/${engagementId}/collateral/exports`,
    );
    expect(history.status).toBe(200);
    expect(history.body.length).toBeGreaterThan(0);
  });

  it("rejects signed fetch for asset not in job", async () => {
    const { createCollateralAssetToken } = await import(
      "../lib/collateral/exportSignedUrl"
    );
    const exportRes = await request(getApp())
      .post(`/api/engagements/${engagementId}/collateral/export`)
      .send({
        engagementId,
        templatePackId: "client-presentation",
        assetIds: [],
        slotMapping: {},
        textFields: { project_name: "X" },
      });
    const jobId = exportRes.body.jobId;
    pendingExportJobIds.push(jobId);
    const token = createCollateralAssetToken({
      jobId,
      assetKey: "render:not-in-job",
    });
    const fetchRes = await request(getApp()).get(
      `/api/collateral/fetch/${token}/${encodeURIComponent("render:not-in-job")}`,
    );
    expect(fetchRes.status).toBe(403);
  });
});

describe("POST export without signing secret", () => {
  it("returns 503", async () => {
    delete process.env.COLLATERAL_SIGNING_SECRET;
    const engagementId = await seedEngagement();
    const res = await request(getApp())
      .post(`/api/engagements/${engagementId}/collateral/export`)
      .send({
        engagementId,
        templatePackId: "client-presentation",
        assetIds: [],
        slotMapping: {},
        textFields: {},
      });
    expect(res.status).toBe(503);
    process.env.COLLATERAL_SIGNING_SECRET = signingSecret;
  });
});
