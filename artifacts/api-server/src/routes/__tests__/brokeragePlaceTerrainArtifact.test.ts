/**
 * Retired terrain artifact retrieval routes:
 *
 *   GET /api/brokerage/v1/place/:placeKey/site-topography/mesh
 *   GET /api/brokerage/v1/place/:placeKey/site-topography/ifc
 *
 * WDLL item 7 / I-A: cortex mesh/IFC authoring is gone. Routes remain
 * registered but return 410 Gone with a pointer to spine
 * `refresh_parcel_terrain_export`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";

vi.mock("../../lib/mcpPlaceEngagement", () => ({
  ensureMcpPlaceEngagement: vi.fn(),
}));
vi.mock("../../lib/siteTopographyMaterializer", () => ({
  loadActiveSiteTopographyRow: vi.fn(),
  rematerializeFromLatestEvent: vi.fn(),
}));
vi.mock("../../atoms/registry", () => ({
  getHistoryService: () => ({}),
}));
vi.mock("../../lib/gateFrontSeam", () => ({
  resolveRequestJurisdictionTenant: (_req: Request) => "tenant-under-test",
}));
vi.mock("../../lib/siteDrainageIngest", () => ({
  ingestSiteDrainage: vi.fn(),
}));
vi.mock("../../lib/siteDrainageMaterializer", () => ({
  loadActiveSiteDrainageRow: vi.fn(),
  rematerializeSiteDrainageFromLatestEvent: vi.fn(),
}));
vi.mock("../siteDrainage", () => ({
  ingestDrainageResultToHttp: vi.fn(),
}));
vi.mock("../../lib/terrainJobWorker", () => ({
  enqueueTerrainJob: vi.fn(),
  loadActiveTerrainJob: vi.fn(),
  loadLatestTerrainJob: vi.fn(),
}));

const { brokeragePlaceHydrologyRouter } = await import("../brokeragePlaceHydrology");

const TEST_KEY = "valid-test-key";
function testBrokerageGate(req: Request, res: Response, next: NextFunction) {
  if (req.header("x-hauska-key") === TEST_KEY) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use("/api/brokerage/v1/place", testBrokerageGate, brokeragePlaceHydrologyRouter);
  return app;
}

const PLACE_A = "coord:30.10000:-97.30000";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET :placeKey/site-topography/{mesh,ifc} — retired (410 Gone)", () => {
  it("returns 410 Gone for mesh with spine replacement pointer", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/mesh`)
      .set("x-hauska-key", TEST_KEY);

    expect(res.status).toBe(410);
    expect(res.body.status).toBe("gone");
    expect(res.body.replacement).toBe("refresh_parcel_terrain_export");
    expect(res.body.reason).toMatch(/refresh_parcel_terrain_export/);
  });

  it("returns 410 Gone for ifc with spine replacement pointer", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/ifc`)
      .set("x-hauska-key", TEST_KEY);

    expect(res.status).toBe(410);
    expect(res.body.status).toBe("gone");
    expect(res.body.replacement).toBe("refresh_parcel_terrain_export");
  });

  it("401s with no gate key before the retired handler", async () => {
    const app = buildApp();
    const res = await request(app).get(
      `/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/mesh`,
    );
    expect(res.status).toBe(401);
  });
});
