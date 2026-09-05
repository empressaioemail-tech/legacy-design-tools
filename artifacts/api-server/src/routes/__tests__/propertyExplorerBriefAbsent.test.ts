/**
 * P-91 research/brief miss split: absent parcel versus unbaked parcel versus
 * a probe that could not answer. Before this cut every miss was
 * baked_snapshot_not_found, and the MCP painted "Not on file" for parcels
 * it had never checked.
 *
 * Mocked: db handle, entitlement gate, the baked snapshot read (null in every
 * case here), the existence probe, and the modules that reach
 * @workspace/cad-ingest subpaths this isolate cannot resolve.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

const fakes = vi.hoisted(() => ({
  probe: vi.fn<(input: { parcelNodeId: string }) => Promise<{ parcelNodeId: string; label: string } | null>>(),
  snapshot: vi.fn<(id: string) => Promise<unknown>>(),
}));

vi.mock("@workspace/db", () => ({
  db: {},
  peSavedProperties: {},
  peShareGrants: {},
  peWorkbenchState: {},
  peScreens: {},
  peScreenRows: {},
}));

vi.mock("../../lib/peEntitlement", () => ({
  PE_FREE_CHAT_MESSAGE_LIMIT: 3,
  createPePropertyUnlock: vi.fn(),
  getPeFreeChatMessagesUsed: vi.fn(),
  hasPeDevPaidBypass: vi.fn(async () => false),
  isPePropertyEntitled: vi.fn(async () => true),
  requirePeAuthenticated: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  requirePePaidOrPropertyUnlocked:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  resolvePeEntitlement: vi.fn(),
  resolvePeOwnerUserId: () => "user-brief-absent",
}));

vi.mock("../../lib/peScreenSaveDb", () => ({
  createDrizzleScreenSaveStore: vi.fn(),
}));

vi.mock("../../lib/peScreenSaveResolve", () => ({
  // The brief-miss probe rides this seam (same as add_to_screen), so the fake
  // probe is wired here, not on txgioAddressResolve.
  cortexNodeLookup: () => (parcelNodeId: string) => fakes.probe({ parcelNodeId }),
  cortexQueryResolver: vi.fn(),
}));

vi.mock("../brokerageNodeFacets", () => ({
  isValidParcelNodeId: (raw: string) =>
    /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw),
  loadBakedNodeFacetSnapshot: (id: string) => fakes.snapshot(id),
}));

vi.mock("../../lib/txgioAddressResolve", () => ({
  lookupParcelNodeForScreen: (input: { parcelNodeId: string }) =>
    fakes.probe(input),
}));

vi.mock("../../lib/verdictLayerServe", () => ({
  countyFipsFromParcelNodeId: (id: string) => id.split(":")[0] ?? null,
}));

vi.mock("../../lib/floodHazardFactRead", () => ({
  loadFloodHazardFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/boundaryEdgeFactRead", () => ({
  loadBoundaryEdgeFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/pipelineFactRead", () => ({
  loadPipelineFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/wellFactRead", () => ({
  loadWellFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/structuralFactRead", () => ({
  loadStructuralFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/specialDistrictFactRead", () => ({
  loadSpecialDistrictFactAtom: vi.fn(async () => null),
}));
// OPS-16 A-103 item 6 / A-104: assembleNodeBriefBody now also reads building
// footprint (a direct atom read, no serve-cutover wrapper -- same category as
// pipeline/boundary above, so it needs the same explicit mock rather than
// relying on the allowlist short-circuit the cutover-wrapped facts below get).
vi.mock("../../lib/buildingFootprintFactRead", () => ({
  loadBuildingFootprintFactAtom: vi.fn(async () => null),
}));

vi.mock("../../lib/peRecordsEngagement", () => ({
  ensurePeRecordsEngagement: vi.fn(),
  findPeRecordsEngagement: vi.fn(),
}));

vi.mock("../../lib/recordsRequestService", () => ({
  createRecordsRequestJob: vi.fn(),
  listRecordsRequestJobsWire: vi.fn(),
  listRecordsRequestInboxWire: vi.fn(),
}));

const propertyExplorerRouter = (await import("../propertyExplorer")).default;

const ABSENT = "48021:900099";
const UNBAKED = "48021:34169";

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

describe("POST /property-explorer/v1/research/brief miss split", () => {
  beforeEach(() => {
    fakes.probe.mockReset();
    fakes.snapshot.mockReset();
    fakes.snapshot.mockResolvedValue(null);
  });

  it("stub depth, no parcel row: 404 parcel_not_found", async () => {
    fakes.probe.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: ABSENT, depth: "stub" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "parcel_not_found", parcelNodeId: ABSENT });
    expect(typeof res.body.message).toBe("string");
    expect(fakes.probe).toHaveBeenCalledWith({ parcelNodeId: ABSENT });
  });

  it("stub depth, parcel row exists, no snapshot: 404 baked_snapshot_not_found", async () => {
    fakes.probe.mockResolvedValue({ parcelNodeId: UNBAKED, label: UNBAKED });
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: UNBAKED, depth: "stub" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: "baked_snapshot_not_found",
      parcelNodeId: UNBAKED,
    });
    expect(typeof res.body.message).toBe("string");
  });

  it("node depth, no parcel row: 404 parcel_not_found", async () => {
    fakes.probe.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: ABSENT });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "parcel_not_found", parcelNodeId: ABSENT });
  });

  it("node depth, parcel row exists, no snapshot: 404 baked_snapshot_not_found", async () => {
    fakes.probe.mockResolvedValue({ parcelNodeId: UNBAKED, label: UNBAKED });
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: UNBAKED });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: "baked_snapshot_not_found",
      parcelNodeId: UNBAKED,
    });
  });

  it("the probe throwing is 503 lookup_unavailable, never either 404", async () => {
    fakes.probe.mockRejectedValue(new Error("pool exhausted"));
    for (const body of [
      { parcelNodeId: ABSENT, depth: "stub" },
      { parcelNodeId: ABSENT },
    ]) {
      const res = await request(buildApp())
        .post("/api/property-explorer/v1/research/brief")
        .send(body);
      expect(res.status).toBe(503);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).toEqual({ error: "lookup_unavailable", parcelNodeId: ABSENT });
    }
  });

  it("the array path keeps per-id notFound inside a 200 and does not probe", async () => {
    fakes.probe.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: [ABSENT, UNBAKED], depth: "stub" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parcels: [], notFound: [ABSENT, UNBAKED] });
    expect(res.body).not.toHaveProperty("absent");
    expect(fakes.probe).not.toHaveBeenCalled();
  });
});
