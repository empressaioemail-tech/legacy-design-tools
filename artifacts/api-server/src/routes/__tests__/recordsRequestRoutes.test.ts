/**
 * P-85 WDLL item 4 — Records Request route tests (mocked DB + deps).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";

const ENGAGEMENT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const mockEnqueue = vi.fn();
const mockList = vi.fn();
const mockLoadById = vi.fn();
const mockTenantScope = vi.fn();
const mockResolveUser = vi.fn();
const mockCountyGate = vi.fn();
const mockResolveParcel = vi.fn();
const mockLiveGis = vi.fn();

vi.mock("../../middlewares/gateEngineServiceAuth", () => ({
  requireGateEngineServiceAuth: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../../middlewares/gateContextVerification", () => ({
  verifyGateContext: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock("../../lib/gateFrontSeamEngagement", () => ({
  assertEngagementServiceTenantScope: (...args: unknown[]) =>
    mockTenantScope(...args),
}));

vi.mock("../../lib/peEntitlement", () => ({
  resolvePeOwnerUserId: (...args: unknown[]) => mockResolveUser(...args),
}));

vi.mock("../../lib/clerkPortalSearchGate", () => ({
  assertCountyPortalsAllowAutomatedSearch: (...args: unknown[]) =>
    mockCountyGate(...args),
}));

vi.mock("../../lib/siteTopographyIngest", () => ({
  resolveParcelInput: (...args: unknown[]) => mockResolveParcel(...args),
}));

vi.mock("../../lib/liveEasementGisQuery", () => ({
  queryLiveEasementGisForParcel: (...args: unknown[]) => mockLiveGis(...args),
}));

vi.mock("../../lib/recordsRequestJobWorker", () => ({
  enqueueRecordsRequestJob: (...args: unknown[]) => mockEnqueue(...args),
  listRecordsRequestJobsForEngagement: (...args: unknown[]) => mockList(...args),
  loadRecordsRequestJobById: (...args: unknown[]) => mockLoadById(...args),
  recordsRequestJobToWire: (job: Record<string, unknown>) => job,
}));

const recordsRequestRouter = (await import("../recordsRequest")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api", recordsRequestRouter);
  return app;
}

const PARCEL_POLYGON = {
  type: "Polygon",
  coordinates: [
    [
      [-97.74, 30.26],
      [-97.739, 30.26],
      [-97.739, 30.261],
      [-97.74, 30.261],
      [-97.74, 30.26],
    ],
  ],
};

const LIVE_GIS_AUDIT = {
  queriedAt: "2026-08-26T12:00:00.000Z",
  parcelKey: "apn:48453:TEST",
  countyFips: "48453",
  layers: [],
  hits: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTenantScope.mockResolvedValue({
    ok: true,
    jurisdictionTenant: "travis_tx",
  });
  mockResolveUser.mockReturnValue(USER_ID);
  mockCountyGate.mockResolvedValue({ ok: true });
  mockResolveParcel.mockResolvedValue({
    origin: "county-gis-parcel",
    briefingSourceId: "bs-1",
    layerKind: "parcel-boundary",
    geometry: PARCEL_POLYGON,
    parcelBbox: [-97.74, 30.26, -97.739, 30.261],
  });
  mockLiveGis.mockResolvedValue(LIVE_GIS_AUDIT);
  mockEnqueue.mockResolvedValue({
    kind: "queued",
    jobId: JOB_ID,
    alreadyInFlight: false,
  });
  mockList.mockResolvedValue([]);
  mockLoadById.mockResolvedValue(null);
});

describe("POST /engagements/:id/records-request", () => {
  it("creates a queued job with live GIS audit attached", async () => {
    const app = buildApp();
    const res = await request(app)
      .post(`/api/engagements/${ENGAGEMENT_ID}/records-request`)
      .send({
        parcelKey: "apn:48453:TEST",
        countyFips: "48453",
      });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("accepted");
    expect(res.body.jobId).toBe(JOB_ID);
    expect(res.body.liveInstantGis).toEqual(LIVE_GIS_AUDIT);
    expect(mockCountyGate).toHaveBeenCalledWith("48453");
    expect(mockLiveGis).toHaveBeenCalledWith(
      expect.objectContaining({
        parcelKey: "apn:48453:TEST",
        countyFips: "48453",
        parcelGeometryGeojson: PARCEL_POLYGON,
      }),
    );
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        liveInstantGis: LIVE_GIS_AUDIT,
      }),
    );
  });

  it("refuses when a county portal is not permitted", async () => {
    mockCountyGate.mockResolvedValue({
      ok: false,
      code: "PORTAL_TERMS_UNKNOWN",
      portalId: "travis-tccsearch",
      message: "Portal travis-tccsearch has automated_search=unknown",
    });

    const app = buildApp();
    const res = await request(app)
      .post(`/api/engagements/${ENGAGEMENT_ID}/records-request`)
      .send({
        parcelKey: "apn:48453:TEST",
        countyFips: "48453",
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("portal_automated_search_refused");
    expect(res.body.code).toBe("PORTAL_TERMS_UNKNOWN");
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockLiveGis).not.toHaveBeenCalled();
  });

  it("401s without an authenticated user", async () => {
    mockResolveUser.mockReturnValue(null);

    const app = buildApp();
    const res = await request(app)
      .post(`/api/engagements/${ENGAGEMENT_ID}/records-request`)
      .send({
        parcelKey: "apn:48453:TEST",
        countyFips: "48453",
      });

    expect(res.status).toBe(401);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("422s when parcel geometry is unavailable", async () => {
    mockResolveParcel.mockResolvedValue(null);

    const app = buildApp();
    const res = await request(app)
      .post(`/api/engagements/${ENGAGEMENT_ID}/records-request`)
      .send({
        parcelKey: "apn:48453:TEST",
        countyFips: "48453",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("no_parcel_geometry");
    expect(mockLiveGis).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe("GET /engagements/:id/records-request", () => {
  it("lists jobs for the engagement and user", async () => {
    mockList.mockResolvedValue([
      {
        id: JOB_ID,
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        status: "queued",
      },
    ]);

    const app = buildApp();
    const res = await request(app).get(
      `/api/engagements/${ENGAGEMENT_ID}/records-request`,
    );

    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(mockList).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });
});

describe("GET /engagements/:id/records-request/:jobId", () => {
  it("returns job status when scoped to engagement and user", async () => {
    mockLoadById.mockResolvedValue({
      id: JOB_ID,
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
      status: "queued",
      liveInstantGis: LIVE_GIS_AUDIT,
    });

    const app = buildApp();
    const res = await request(app).get(
      `/api/engagements/${ENGAGEMENT_ID}/records-request/${JOB_ID}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe(JOB_ID);
    expect(res.body.job.liveInstantGis).toEqual(LIVE_GIS_AUDIT);
  });

  it("404s when job belongs to another user", async () => {
    mockLoadById.mockResolvedValue({
      id: JOB_ID,
      engagementId: ENGAGEMENT_ID,
      userId: "other-user",
      status: "queued",
    });

    const app = buildApp();
    const res = await request(app).get(
      `/api/engagements/${ENGAGEMENT_ID}/records-request/${JOB_ID}`,
    );

    expect(res.status).toBe(404);
  });
});
