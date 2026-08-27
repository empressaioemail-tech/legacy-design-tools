/**
 * P-85 — Property Explorer records-request route tests (mocked bridge + service).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";

const USER_ID = "33333333-3333-4333-8333-333333333333";
const ENGAGEMENT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const PARCEL_NODE = "48453:280238";

const mockEnsure = vi.fn();
const mockFind = vi.fn();
const mockCreateJob = vi.fn();
const mockListJobs = vi.fn();
const mockResolveUser = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {},
  peSavedProperties: {},
  peWorkbenchState: {},
}));

vi.mock("../../lib/peEntitlement", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/peEntitlement")>();
  return {
    ...actual,
    requirePeAuthenticated: (
      _req: Request,
      _res: Response,
      next: NextFunction,
    ) => next(),
    resolvePeOwnerUserId: (...args: unknown[]) => mockResolveUser(...args),
  };
});

vi.mock("../../lib/peRecordsEngagement", () => ({
  ensurePeRecordsEngagement: (...args: unknown[]) => mockEnsure(...args),
  findPeRecordsEngagement: (...args: unknown[]) => mockFind(...args),
}));

vi.mock("../../lib/recordsRequestService", () => ({
  createRecordsRequestJob: (...args: unknown[]) => mockCreateJob(...args),
  listRecordsRequestJobsWire: (...args: unknown[]) => mockListJobs(...args),
}));

const propertyExplorerRouter = (await import("../propertyExplorer")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { tenantId: "default" } as Express.Request["session"];
    next();
  });
  app.use("/api", propertyExplorerRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveUser.mockReturnValue(USER_ID);
  mockEnsure.mockResolvedValue({
    ok: true,
    engagementId: ENGAGEMENT_ID,
    created: true,
    geometrySeeded: true,
  });
  mockFind.mockResolvedValue({ ok: true, engagementId: ENGAGEMENT_ID });
  mockCreateJob.mockResolvedValue({
    ok: true,
    status: 202,
    body: {
      status: "accepted",
      jobId: JOB_ID,
      jobStatus: "queued",
      engagementId: ENGAGEMENT_ID,
      liveInstantGis: { parcelKey: "apn:48453:280238" },
    },
  });
  mockListJobs.mockResolvedValue({
    engagementId: ENGAGEMENT_ID,
    jobs: [{ jobId: JOB_ID, status: "queued" }],
  });
});

describe("POST /property-explorer/v1/records-request", () => {
  it("ensures PE engagement then enqueues a job", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/records-request")
      .send({ parcelNodeId: PARCEL_NODE, countyFips: "48453" });

    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe(JOB_ID);
    expect(res.body.parcelNodeId).toBe(PARCEL_NODE);
    expect(mockEnsure).toHaveBeenCalledWith(
      USER_ID,
      "default",
      PARCEL_NODE,
      "apn:48453:280238",
      "48453",
    );
    expect(mockCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        parcelKey: "apn:48453:280238",
        countyFips: "48453",
      }),
    );
  });

  it("401s without an authenticated user", async () => {
    mockResolveUser.mockReturnValue(null);
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/records-request")
      .send({ parcelNodeId: PARCEL_NODE });

    expect(res.status).toBe(401);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("forwards geometry bridge refusal", async () => {
    mockEnsure.mockResolvedValue({
      ok: false,
      status: 422,
      body: { error: "no_parcel_geometry" },
    });

    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/records-request")
      .send({ parcelNodeId: PARCEL_NODE, countyFips: "48453" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_parcel_geometry");
    expect(mockCreateJob).not.toHaveBeenCalled();
  });
});

describe("GET /property-explorer/v1/records-request", () => {
  it("lists jobs for the parcel-scoped engagement", async () => {
    const app = buildApp();
    const res = await request(app).get(
      `/api/property-explorer/v1/records-request?parcelNodeId=${encodeURIComponent(PARCEL_NODE)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.parcelNodeId).toBe(PARCEL_NODE);
    expect(res.body.jobs).toHaveLength(1);
    expect(mockListJobs).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it("returns empty jobs when no engagement exists yet", async () => {
    mockFind.mockResolvedValue({ ok: false });

    const app = buildApp();
    const res = await request(app).get(
      `/api/property-explorer/v1/records-request?parcelNodeId=${encodeURIComponent(PARCEL_NODE)}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.engagementId).toBeNull();
    expect(mockListJobs).not.toHaveBeenCalled();
  });
});
