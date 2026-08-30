/**
 * P-91 4.3 rails at first paint through the real router. create_screen
 * (POST /screens) and list_screens(screenId) (GET /screens/:id) attach a
 * five-state stub plus stubRead to every resolved row, read from the same
 * assembler the brief's stub depth uses. The fake sits at the store-read
 * seam (baked snapshot, flood atom) so the real assembler and composer run.
 *
 * Mocked: db handle, entitlement gate, the drizzle store (memory store in
 * its place), the resolver factory, the two stub reads, and the modules that
 * reach @workspace/cad-ingest subpaths this isolate cannot resolve.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

type FakeSnapshot = {
  parcelNodeId: string;
  facets: unknown;
  snapshotAt: string | null;
  tier2: null;
  envelopeBriefRefusal: null;
  queryPoint: null;
};

const fakes = vi.hoisted(() => ({
  lookup: vi.fn<(id: string) => Promise<{ parcelNodeId: string; label: string } | null>>(),
  resolver: vi.fn<(q: string) => Promise<Array<{ parcelNodeId: string; label: string }>>>(),
  snapshot: vi.fn<(id: string) => Promise<unknown>>(),
  flood: vi.fn<(id: string) => Promise<unknown>>(),
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
  // The paid gate must never be consulted on the screens routes; a call here
  // is a defect (the board is the intake surface).
  requirePePaidOrPropertyUnlocked: () =>
    (_req: Request, res: Response, _next: NextFunction) => {
      res.status(402).json({ error: "paid_gate_reached_on_screens_route" });
    },
  resolvePeEntitlement: vi.fn(),
  resolvePeOwnerUserId: () => "user-screens-stubs",
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
  loadBakedNodeFacetSnapshot: (id: string) => fakes.snapshot(id),
}));

vi.mock("../../lib/txgioAddressResolve", () => ({
  lookupParcelNodeForScreen: vi.fn(async () => null),
}));

vi.mock("../../lib/verdictLayerServe", () => ({
  countyFipsFromParcelNodeId: (id: string) => id.split(":")[0] ?? null,
}));

vi.mock("../../lib/floodHazardFactRead", () => ({
  loadFloodHazardFactAtom: (id: string) => fakes.flood(id),
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

const OK = "48021:34137";
const OK2 = "48021:34169";
const MISS = "48021:900099";
const DOWN = "48021:900098";
const UNRESOLVED = "no-such-situs-zzz-99999";
const AMBIGUOUS = "111 Rainmaker Cv, Bastrop TX";

const RAILS = ["situs", "zoning", "landUse", "flood", "drainage", "envelope"] as const;
const VOCAB = ["present", "absent-verified", "unknown", "refused", "unread"];

function allRails(state: string): Record<(typeof RAILS)[number], string> {
  return {
    situs: state,
    zoning: state,
    landUse: state,
    flood: state,
    drainage: state,
    envelope: state,
  };
}

function bakedSnapshot(parcelNodeId: string): FakeSnapshot {
  return {
    parcelNodeId,
    facets: {
      bakedAt: "2026-08-20T00:00:00.000Z",
      zoning: { district: "R-1" },
      baseFacts: {
        situsAddress: "910 PINE",
        situsCity: "BASTROP",
        situsState: "TX",
        situsZip: "78602",
        landUse: "A1",
      },
      envelope: null,
    },
    snapshotAt: "2026-08-20T00:00:00.000Z",
    tier2: null,
    envelopeBriefRefusal: null,
    queryPoint: null,
  };
}

/** The flood atom is not baked for this parcel: an atom-miss, which is unknown. */
function floodAtomMiss(parcelNodeId: string) {
  return {
    state: "refused",
    code: "atom-miss",
    source: "flood-hazard-fact",
    tried: [parcelNodeId],
    reason: "no flood-hazard-fact atom for this parcel",
  };
}

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

function resetFakes(): void {
  store.screens = [];
  store.rows = [];
  store.saves = [];
  fakes.lookup.mockReset();
  fakes.resolver.mockReset();
  fakes.snapshot.mockReset();
  fakes.flood.mockReset();
  fakes.resolver.mockImplementation(async (q) => {
    if (q === UNRESOLVED) return [];
    if (q === AMBIGUOUS) {
      return [
        { parcelNodeId: "48021:c1", label: "111 Rainmaker Cv" },
        { parcelNodeId: "48021:c2", label: "111 Rainmaker Cove" },
      ];
    }
    return [{ parcelNodeId: q, label: q }];
  });
  fakes.snapshot.mockImplementation(async (id) => {
    if (id === OK || id === OK2) return bakedSnapshot(id);
    if (id === DOWN) throw new Error("pool exhausted");
    return null;
  });
  fakes.flood.mockImplementation(async (id) => floodAtomMiss(id));
}

type WireRow = {
  query: string;
  resolution: string;
  stub?: Record<string, string>;
  stubRead?: string;
};

function assertMixedRows(rows: WireRow[]): void {
  const byQuery = new Map(rows.map((r) => [r.query, r]));

  const ok = byQuery.get(OK)!;
  expect(ok.resolution).toBe("resolved");
  expect(ok.stubRead).toBe("ok");
  expect(ok.stub).toMatchObject({
    zoning: "present",
    landUse: "present",
    flood: "unknown",
    drainage: "unread",
    envelope: "unknown",
  });
  expect(Object.keys(ok.stub!).sort()).toEqual([...RAILS].sort());
  for (const rail of RAILS) expect(VOCAB).toContain(ok.stub![rail]);

  const miss = byQuery.get(MISS)!;
  expect(miss.resolution).toBe("resolved");
  expect(miss.stubRead).toBe("ok");
  expect(miss.stub).toEqual(allRails("unknown"));

  const down = byQuery.get(DOWN)!;
  expect(down.resolution).toBe("resolved");
  expect(down.stubRead).toBe("error");
  expect(down.stub).toEqual(allRails("unread"));

  const unresolved = byQuery.get(UNRESOLVED)!;
  expect(unresolved.resolution).toBe("unresolved");
  expect(unresolved).not.toHaveProperty("stub");
  expect(unresolved).not.toHaveProperty("stubRead");

  const ambiguous = byQuery.get(AMBIGUOUS)!;
  expect(ambiguous.resolution).toBe("ambiguous");
  expect(ambiguous).not.toHaveProperty("stub");
  expect(ambiguous).not.toHaveProperty("stubRead");
}

function assertNothingPersisted(): void {
  for (const row of store.rows) {
    expect(row).not.toHaveProperty("stub");
    expect(row).not.toHaveProperty("stubRead");
  }
  for (const screen of store.screens) {
    expect(screen).not.toHaveProperty("stubsDegraded");
  }
}

describe("POST /property-explorer/v1/screens attaches rails to resolved rows", () => {
  beforeEach(resetFakes);

  it("ok body, measured miss, throw, unresolved, ambiguous: five rows, three stub states, stubsDegraded declared, nothing stored", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({
        name: "walk",
        queries: [OK, MISS, DOWN, UNRESOLVED, AMBIGUOUS],
        source: "pasted",
      });
    expect(res.status).toBe(200);
    expect(res.body.screen.rows).toHaveLength(5);
    assertMixedRows(res.body.screen.rows);
    expect(res.body.screen.stubsDegraded).toBe(true);
    expect(res.body.screen).not.toHaveProperty("degraded");

    // One assembler read per resolved row, none for unresolved or ambiguous.
    expect(fakes.snapshot.mock.calls.map((c) => c[0]).sort()).toEqual(
      [OK, MISS, DOWN].sort(),
    );
    assertNothingPersisted();
    expect(store.screens[0]!.updatedAt.toISOString()).toBe(res.body.screen.updatedAt);
  });

  it("all resolved rows ok omits stubsDegraded", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK, OK2, MISS], source: "pasted" });
    expect(res.status).toBe(200);
    expect(res.body.screen.rows.map((r: WireRow) => r.stubRead)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
    expect(res.body.screen).not.toHaveProperty("stubsDegraded");
    assertNothingPersisted();
  });
});

describe("GET /property-explorer/v1/screens/:screenId attaches rails the same way", () => {
  beforeEach(resetFakes);

  it("reads rails at list time and does not move updatedAt", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({
        name: "walk",
        queries: [OK, MISS, DOWN, UNRESOLVED, AMBIGUOUS],
        source: "pasted",
      });
    expect(created.status).toBe(200);
    const screenId = created.body.screen.id as string;
    const storedUpdatedAt = store.screens[0]!.updatedAt.getTime();
    fakes.snapshot.mockClear();

    const res = await request(app).get(
      `/api/property-explorer/v1/screens/${screenId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.screen.id).toBe(screenId);
    assertMixedRows(res.body.screen.rows);
    expect(res.body.screen.stubsDegraded).toBe(true);
    expect(fakes.snapshot.mock.calls.map((c) => c[0]).sort()).toEqual(
      [OK, MISS, DOWN].sort(),
    );

    expect(store.screens[0]!.updatedAt.getTime()).toBe(storedUpdatedAt);
    expect(res.body.screen.updatedAt).toBe(created.body.screen.updatedAt);
    expect(res.body.screen.updatedAt).toBe(
      new Date(storedUpdatedAt).toISOString(),
    );
    assertNothingPersisted();
  });

  it("a screen whose rows all read ok omits stubsDegraded on the read too", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK, MISS], source: "pasted" });
    const res = await request(app).get(
      `/api/property-explorer/v1/screens/${created.body.screen.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.screen).not.toHaveProperty("stubsDegraded");
    expect(res.body.screen.rows.map((r: WireRow) => r.stubRead)).toEqual(["ok", "ok"]);
  });
});

describe("GET /property-explorer/v1/screens (bare list) is unchanged", () => {
  beforeEach(resetFakes);

  it("summaries carry no rows, no stub, and the assembler is not called", async () => {
    const app = buildApp();
    await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK, DOWN], source: "pasted" });
    fakes.snapshot.mockClear();
    const res = await request(app).get("/api/property-explorer/v1/screens");
    expect(res.status).toBe(200);
    expect(res.body.screens).toHaveLength(1);
    expect(res.body.screens[0]).toEqual({
      id: expect.any(String),
      name: "walk",
      rowCount: 2,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(fakes.snapshot).not.toHaveBeenCalled();
  });
});
