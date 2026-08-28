/**
 * P-85 WDLL item 7 — internal vision-read route (service token).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { __resetServiceApiKeyCacheForTests } from "../../lib/serviceToken";

const SERVICE_TOKEN = "test-service-token-p85-vision";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

const mockProcessVisionReads = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {},
  peSavedProperties: {},
  peWorkbenchState: {},
  peShareGrants: {},
  peScreens: {},
  peScreenRows: {},
}));

vi.mock("../../lib/peEntitlement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/peEntitlement")>();
  return {
    ...actual,
    requirePeAuthenticated: (_req: Request, _res: Response, next: NextFunction) =>
      next(),
    resolvePeOwnerUserId: () => "user-id",
  };
});

vi.mock("../../lib/peRecordsEngagement", () => ({
  ensurePeRecordsEngagement: vi.fn(),
  findPeRecordsEngagement: vi.fn(),
}));

vi.mock("../../lib/peScreenSave", () => ({
  addToScreen: vi.fn(),
  createScreen: vi.fn(),
  listScreens: vi.fn(),
  saveProperty: vi.fn(),
  setPropertyStatus: vi.fn(),
}));

vi.mock("../../lib/peScreenSaveDb", () => ({
  createDrizzleScreenSaveStore: vi.fn(),
}));

vi.mock("../../lib/peScreenSaveResolve", () => ({
  cortexQueryResolver: vi.fn(),
}));

vi.mock("../../lib/recordsRequestService", () => ({
  createRecordsRequestJob: vi.fn(),
  listRecordsRequestJobsWire: vi.fn(),
}));

vi.mock("../../lib/recordsRequestPurchaseDecision", () => ({
  approveRecordsRequestPurchase: vi.fn(),
  declineRecordsRequestPurchase: vi.fn(),
}));

vi.mock("../../lib/recordsRequestCompletionEmail", () => ({
  notifyRecordsRequestCompletion: vi.fn(),
}));

vi.mock("../../lib/recordsRequestVisionRead", () => ({
  processRecordsRequestJobVisionReads: (...args: unknown[]) =>
    mockProcessVisionReads(...args),
}));

const propertyExplorerRouter = (await import("../propertyExplorer")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", propertyExplorerRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

describe("POST /property-explorer/v1/internal/records-request/vision-read", () => {
  it("runs batch vision read for jobId with service token", async () => {
    mockProcessVisionReads.mockResolvedValue({
      vision: [
        {
          artifactId: "art-1",
          status: "complete",
          visionApplied: true,
          extractedText: "[source: vision-read]\nDEED",
        },
      ],
      classification: [],
    });

    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/internal/records-request/vision-read")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({ jobId: JOB_ID });

    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe(JOB_ID);
    expect(res.body.results).toHaveLength(1);
    expect(mockProcessVisionReads).toHaveBeenCalledWith(JOB_ID);
  });

  it("401s without service token", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/internal/records-request/vision-read")
      .send({ jobId: JOB_ID });

    expect(res.status).toBe(401);
    expect(mockProcessVisionReads).not.toHaveBeenCalled();
  });

  it("400s when jobId missing", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/internal/records-request/vision-read")
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_job_id");
  });
});
