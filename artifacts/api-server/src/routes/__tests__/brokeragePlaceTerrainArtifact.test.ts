/**
 * Gated, engagement-scoped terrain artifact retrieval:
 *
 *   GET /api/brokerage/v1/place/:placeKey/site-topography/mesh
 *   GET /api/brokerage/v1/place/:placeKey/site-topography/ifc
 *
 * These pin the SECURITY-load-bearing behavior of the route added in
 * `feat/gated-terrain-retrieval`:
 *
 *   (a) an authorized caller gets the mesh / ifc bytes for the engagement their
 *       placeKey resolves to, with the correct artifact content-type;
 *   (b) a caller with no / a bad key is 401'd before the handler runs (the
 *       brokerage gate on the parent router);
 *   (c) a caller CANNOT retrieve an object outside their engagement, and cannot
 *       address an arbitrary object by UUID — the object path is derived from
 *       the resolved engagement's read model, never from caller input (the
 *       authorization test);
 *   (d) an honest 404 when the place has no materialized mesh / ifc yet.
 *
 * Fully mocked — no DB, no object store — so it runs outside the CI DB gate.
 * The DB-backed integration variant (real schema via `setupRouteTests`) is a
 * follow-up; the authorization logic under test here is pure once the data +
 * storage layers are stubbed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express, type Request, type Response, type NextFunction } from "express";

// --- Mock the engagement resolver. Keyed by placeKey; a caller can only ever
//     resolve the engagement their placeKey maps to. Two distinct places map to
//     two distinct engagements, each with its OWN object path. ---
const ensureMcpPlaceEngagementMock =
  vi.fn<
    (input: {
      placeKey?: string;
      jurisdictionTenant?: string | null;
    }) => Promise<Record<string, unknown>>
  >();
vi.mock("../../lib/mcpPlaceEngagement", () => ({
  ensureMcpPlaceEngagement: (input: {
    placeKey?: string;
    jurisdictionTenant?: string | null;
  }) => ensureMcpPlaceEngagementMock(input),
}));

// --- Mock the read model. Maps engagementId -> propertySet (with meshRef /
//     ifcRef). This is the ONLY source of the object path. ---
const loadActiveSiteTopographyRowMock =
  vi.fn<
    (engagementId: string) => Promise<{
      id: string;
      propertySet: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    } | null>
  >();
vi.mock("../../lib/siteTopographyMaterializer", () => ({
  loadActiveSiteTopographyRow: (engagementId: string) =>
    loadActiveSiteTopographyRowMock(engagementId),
  rematerializeFromLatestEvent: vi.fn(async () => ({
    status: "no-event" as const,
    reason: "no events",
  })),
}));

vi.mock("../../atoms/registry", () => ({
  getHistoryService: () => ({}),
}));

vi.mock("../../lib/gateFrontSeam", () => ({
  resolveRequestJurisdictionTenant: (_req: Request) => "tenant-under-test",
}));

// --- Mock object storage. `getObjectEntityFile` records the path it was asked
//     to serve so the authorization test can assert WHICH object was streamed;
//     `downloadObject` returns a fixed body. ---
const servedPaths: string[] = [];
class ObjectNotFoundErrorClass extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}
const MESH_BODY = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"
vi.mock("../../lib/objectStorage", () => ({
  ObjectStorageService: vi.fn().mockImplementation(() => ({
    getObjectEntityFile: async (path: string) => {
      servedPaths.push(path);
      return { __path: path };
    },
    downloadObject: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(MESH_BODY);
            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(MESH_BODY.byteLength),
            "Cache-Control": "private, max-age=3600",
          },
        },
      ),
  })),
  ObjectNotFoundError: ObjectNotFoundErrorClass,
}));

// Mock the drainage siblings the module imports so the import graph resolves
// without pulling their (heavier) deps.
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

const { brokeragePlaceHydrologyRouter, resolveTerrainArtifactPath } =
  await import("../brokeragePlaceHydrology");

/**
 * Stand-in for the real `requireBrokerageAuthOrServiceToken` gate: accepts the
 * fixed test key on `x-hauska-key`, else 401. Mirrors the real gate's
 * "missing/bad key -> 401, valid key -> next()" contract, which is what these
 * routes inherit from the parent `brokerageV1` router in production.
 */
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
  // Same mount shape as production: gate first, then the /place router.
  app.use("/api/brokerage/v1/place", testBrokerageGate, brokeragePlaceHydrologyRouter);
  return app;
}

const PLACE_A = "coord:30.10000:-97.30000";
const PLACE_B = "coord:31.20000:-98.40000";
const ENGAGEMENT_A = "eng-A";
const ENGAGEMENT_B = "eng-B";
const MESH_A = "/objects/uploads/mesh-A-uuid";
const IFC_A = "/objects/uploads/ifc-A-uuid";
const MESH_B = "/objects/uploads/mesh-B-uuid";

beforeEach(() => {
  ensureMcpPlaceEngagementMock.mockReset();
  loadActiveSiteTopographyRowMock.mockReset();
  servedPaths.length = 0;

  // placeKey -> engagement (deterministic, tenant-scoped in production).
  ensureMcpPlaceEngagementMock.mockImplementation(async ({ placeKey }) => {
    if (placeKey === PLACE_A) {
      return { ok: true, engagementId: ENGAGEMENT_A, placeKey: PLACE_A, address: null, created: false };
    }
    if (placeKey === PLACE_B) {
      return { ok: true, engagementId: ENGAGEMENT_B, placeKey: PLACE_B, address: null, created: false };
    }
    return { ok: false, status: 404, body: { error: "unknown_place" } };
  });

  // engagement -> its OWN read model (its own object paths).
  loadActiveSiteTopographyRowMock.mockImplementation(async (engagementId) => {
    if (engagementId === ENGAGEMENT_A) {
      return {
        id: "row-A",
        propertySet: { meshRef: MESH_A, ifcRef: IFC_A },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    if (engagementId === ENGAGEMENT_B) {
      return {
        id: "row-B",
        propertySet: { meshRef: MESH_B, ifcRef: null },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }
    return null;
  });
});

describe("resolveTerrainArtifactPath (pure derivation)", () => {
  it("returns the meshRef / ifcRef from the read model", () => {
    expect(resolveTerrainArtifactPath({ meshRef: MESH_A, ifcRef: IFC_A }, "mesh")).toBe(MESH_A);
    expect(resolveTerrainArtifactPath({ meshRef: MESH_A, ifcRef: IFC_A }, "ifc")).toBe(IFC_A);
  });

  it("returns null when the artifact is not present (pre-mesh/ifc payload)", () => {
    expect(resolveTerrainArtifactPath({ meshRef: null }, "mesh")).toBeNull();
    expect(resolveTerrainArtifactPath({}, "ifc")).toBeNull();
    expect(resolveTerrainArtifactPath(null, "mesh")).toBeNull();
  });

  it("refuses any ref that is not an /objects/ entity path (no smuggled URL/UUID)", () => {
    expect(resolveTerrainArtifactPath({ meshRef: "https://evil.example/x" }, "mesh")).toBeNull();
    expect(resolveTerrainArtifactPath({ meshRef: "uploads/x" }, "mesh")).toBeNull();
    expect(resolveTerrainArtifactPath({ meshRef: "../../etc/passwd" }, "mesh")).toBeNull();
  });
});

describe("GET :placeKey/site-topography/{mesh,ifc} — gated artifact retrieval", () => {
  it("(a) serves the mesh GLB for an authorized engagement with the right content-type", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/mesh`)
      .set("x-hauska-key", TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("model/gltf-binary");
    expect(res.headers["content-disposition"]).toContain("site-topography.glb");
    // The object streamed is exactly engagement A's meshRef — derived, not passed.
    expect(servedPaths).toEqual([MESH_A]);
  });

  it("(a') serves the IFC for an authorized engagement", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/ifc`)
      .set("x-hauska-key", TEST_KEY);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("site-topography.ifc");
    expect(servedPaths).toEqual([IFC_A]);
  });

  it("(b) 401s with no gate key", async () => {
    const app = buildApp();
    const res = await request(app).get(
      `/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/mesh`,
    );
    expect(res.status).toBe(401);
    // The handler never ran — no object was touched.
    expect(servedPaths).toEqual([]);
  });

  it("(b') 401s with a bad gate key", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_A)}/site-topography/mesh`)
      .set("x-hauska-key", "wrong-key");
    expect(res.status).toBe(401);
    expect(servedPaths).toEqual([]);
  });

  it("(c) AUTHORIZATION: caller cannot address an arbitrary object — only their engagement's object is served", async () => {
    const app = buildApp();

    // Caller resolves place B. Even though engagement A's object (MESH_A)
    // exists, the route derives the path from place B's engagement, so it can
    // only ever serve MESH_B. There is no request parameter that could make it
    // serve MESH_A / IFC_A / any arbitrary UUID.
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_B)}/site-topography/mesh`)
      .set("x-hauska-key", TEST_KEY);

    expect(res.status).toBe(200);
    expect(servedPaths).toEqual([MESH_B]);
    // Crucially: engagement A's objects were NEVER served to the place-B caller.
    expect(servedPaths).not.toContain(MESH_A);
    expect(servedPaths).not.toContain(IFC_A);
  });

  it("(c') a place with no rows serves nothing (unknown place -> resolver rejects)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent("coord:0:0")}/site-topography/mesh`)
      .set("x-hauska-key", TEST_KEY);
    // ensureMcpPlaceEngagement rejects unknown place -> propagated status.
    expect(res.status).toBe(404);
    expect(servedPaths).toEqual([]);
  });

  it("(d) 404 when the place has no IFC materialized yet (place B has mesh but no ifc)", async () => {
    const app = buildApp();
    const res = await request(app)
      .get(`/api/brokerage/v1/place/${encodeURIComponent(PLACE_B)}/site-topography/ifc`)
      .set("x-hauska-key", TEST_KEY);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("not-found");
    expect(servedPaths).toEqual([]);
  });
});
