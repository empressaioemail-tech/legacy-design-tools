/**
 * P-91 add_to_screen and create_screen through the real router with a fake
 * parcel lookup. Replaces the text-presence check that asserted the route
 * source "contains cortexNodeLookup()": here the lookup handed to the route
 * decides resolved, unresolved, and refused, so a route that stopped passing
 * it would fail on behaviour rather than on a substring.
 *
 * Mocked: db handle, entitlement gate, the drizzle store (memory store in
 * its place), the resolver factory, and the modules that reach
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
  lookup: vi.fn<(id: string) => Promise<{ parcelNodeId: string; label: string } | null>>(),
  resolver: vi.fn<(q: string) => Promise<Array<{ parcelNodeId: string; label: string }>>>(),
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
  resolvePeOwnerUserId: () => "user-screens-lookup",
}));

vi.mock("../../lib/peScreenSaveDb", async () => {
  const { MemoryScreenSaveStore } = await import("../../lib/peScreenSaveMemory");
  const store = new MemoryScreenSaveStore();
  return { createDrizzleScreenSaveStore: () => store, __memoryStore: store };
});

vi.mock("../../lib/peScreenSaveResolve", () => ({
  cortexNodeLookup: () => (id: string) => fakes.lookup(id),
  cortexQueryResolver: () => (q: string) => fakes.resolver(q),
}));

vi.mock("../brokerageNodeFacets", () => ({
  isValidParcelNodeId: (raw: string) =>
    /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw),
  loadBakedNodeFacetSnapshot: vi.fn(async () => null),
}));

vi.mock("../../lib/txgioAddressResolve", () => ({
  lookupParcelNodeForScreen: vi.fn(async () => null),
}));

vi.mock("../../lib/verdictLayerServe", () => ({
  countyFipsFromParcelNodeId: (id: string) => id.split(":")[0] ?? null,
}));

// The six fact reads are only reached on the brief path; mocked so this
// isolate does not resolve @workspace/instrument-registry through
// structuralFactResolve.
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
const { __memoryStore: store } = (await import("../../lib/peScreenSaveDb")) as unknown as {
  __memoryStore: import("../../lib/peScreenSaveMemory").MemoryScreenSaveStore;
};

const HIT = "48021:34169";
const MISS = "48021:900099";
const DOWN = "48021:900098";

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

async function createEmptyScreen(app: Express): Promise<string> {
  const res = await request(app)
    .post("/api/property-explorer/v1/screens")
    .send({ name: "walk", queries: [], source: "pasted" });
  expect(res.status).toBe(200);
  return res.body.screen.id as string;
}

describe("POST /property-explorer/v1/screens/:screenId/rows with the parcel lookup", () => {
  beforeEach(() => {
    store.screens = [];
    store.rows = [];
    store.saves = [];
    fakes.lookup.mockReset();
    fakes.resolver.mockReset();
    fakes.lookup.mockImplementation(async (id) => {
      if (id === HIT) return { parcelNodeId: HIT, label: "910 PINE , BASTROP, TX 78602" };
      if (id === DOWN) throw new Error("pool exhausted");
      return null;
    });
    fakes.resolver.mockImplementation(async () => []);
  });

  it("a lookup hit writes a resolved row and a lookup miss writes an unresolved row", async () => {
    const app = buildApp();
    const screenId = await createEmptyScreen(app);

    const hit = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: HIT, source: "walk" });
    expect(hit.status).toBe(200);
    expect(hit.body.row).toMatchObject({
      parcelNodeId: HIT,
      query: HIT,
      resolution: "resolved",
      source: "walk",
    });

    const miss = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: MISS, source: "walk" });
    expect(miss.status).toBe(200);
    expect(miss.body.row).toMatchObject({
      parcelNodeId: null,
      query: MISS,
      resolution: "unresolved",
      source: "walk",
    });

    expect(fakes.lookup).toHaveBeenCalledWith(HIT);
    expect(fakes.lookup).toHaveBeenCalledWith(MISS);
    expect(store.rows.map((r) => [r.query, r.resolution])).toEqual([
      [HIT, "resolved"],
      [MISS, "unresolved"],
    ]);
  });

  it("a lookup throw answers 503 lookup_unavailable JSON and writes no row", async () => {
    const app = buildApp();
    const screenId = await createEmptyScreen(app);

    const res = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: DOWN, source: "walk" });
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "lookup_unavailable", node: DOWN });
    expect(store.rows).toHaveLength(0);
  });
});

describe("POST /property-explorer/v1/screens with a node-id query", () => {
  beforeEach(() => {
    store.screens = [];
    store.rows = [];
    store.saves = [];
    fakes.lookup.mockReset();
    fakes.resolver.mockReset();
  });

  it("a resolver throw on a node-id query answers 503 lookup_unavailable and writes no screen", async () => {
    fakes.resolver.mockImplementation(async (q) => {
      if (q === DOWN) throw new Error("statement timeout");
      return [{ parcelNodeId: "48021:r1", label: q }];
    });
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: ["908 Pine, Bastrop TX", DOWN], source: "pasted" });
    expect(res.status).toBe(503);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "lookup_unavailable", query: DOWN });
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("a measured miss on a node-id query is written unresolved inside a 200", async () => {
    fakes.resolver.mockImplementation(async () => []);
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [MISS], source: "pasted" });
    expect(res.status).toBe(200);
    expect(res.body.screen.rows).toHaveLength(1);
    expect(res.body.screen.rows[0]).toMatchObject({
      query: MISS,
      resolution: "unresolved",
      parcelNodeId: null,
    });
    expect(res.body.screen).not.toHaveProperty("degraded");
  });
});
