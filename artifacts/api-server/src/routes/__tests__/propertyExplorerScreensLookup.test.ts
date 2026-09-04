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

/**
 * INVERTED 2026-09-02 (P-101), not deleted.
 *
 * `resolvePeEntitlement` was `vi.fn()` returning undefined, which pinned the
 * fact that NOTHING on the screens path read a tier: any in-handler tier read
 * would have thrown on `undefined`. The operator ruling of 2026-08-31 makes a
 * tier read mandatory on the two POST routes, so the stub is replaced by a
 * real snapshot the tests move, and the file now asserts what the tier read
 * DOES rather than that there is none.
 *
 * The mock spreads the REAL module. `peStudioGate` imports
 * `subscriptionTierGrantsStudio` from here, and hand-writing that export in
 * this factory would let one editor satisfy both sides of the predicate — the
 * internal-consistency shape the 2026-08-31 amendment named when it found
 * three copies of that function with no divergence test between them.
 */
const entitlementState = vi.hoisted(() => ({
  snapshot: {
    tier: "paid" as "free" | "paid",
    subscriptionTier: "studio" as "solo" | "studio" | "team" | null,
    tenantId: "default",
    userId: "user-screens-lookup" as string | null,
    authenticated: true,
    devRole: false,
    entitlementSource: "stripe_sub" as string | null,
    seatsPurchased: null as number | null,
    billingInterval: null as string | null,
  },
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
    requirePePaidOrPropertyUnlocked:
      () => (_req: Request, _res: Response, next: NextFunction) => next(),
    resolvePeEntitlement: vi.fn(async () => entitlementState.snapshot),
    resolvePeOwnerUserId: () => "user-screens-lookup",
  };
});

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

/**
 * B2 (2026-08-30 v2 card, triage Cv/Cove row). Listing-derived pastes carry
 * two spellings of one parcel. The screen is a set of parcel references, so
 * the second spelling is the same row: it is not written, it is declared,
 * and nothing is refused.
 */
describe("POST /property-explorer/v1/screens with two spellings of one parcel (B2)", () => {
  const CV = "111 Rainmaker Cv, Bastrop TX";
  const COVE = "111 Rainmaker Cove, Bastrop TX 78602";
  const NODE = "48021:c1";

  beforeEach(() => {
    store.screens = [];
    store.rows = [];
    store.saves = [];
    fakes.lookup.mockReset();
    fakes.resolver.mockReset();
    fakes.resolver.mockImplementation(async (q) =>
      /rainmaker/i.test(q)
        ? [{ parcelNodeId: NODE, label: "111 RAINMAKER CV, BASTROP, TX 78602" }]
        : [],
    );
  });

  it("Cv and Cove resolve to one node: 200, one row, one declared duplicate, nothing refused", async () => {
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "listing paste", queries: [CV, COVE], source: "pasted" });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("error");
    expect(res.body.screen.rows).toHaveLength(1);
    expect(res.body.screen.rows[0]).toMatchObject({
      ordinal: 0,
      query: CV,
      parcelNodeId: NODE,
      resolution: "resolved",
    });
    expect(res.body.screen.degraded).toEqual({
      duplicates: [{ query: COVE, parcelNodeId: NODE, keptQuery: CV }],
    });
    expect(JSON.stringify(res.body)).not.toContain("duplicate_resolved_node");
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]!.query).toBe(CV);
    expect(fakes.resolver).toHaveBeenCalledWith(CV);
    expect(fakes.resolver).toHaveBeenCalledWith(COVE);
  });
});

/**
 * P-101 — the tier read this file used to prove was absent.
 *
 * The old `resolvePeEntitlement: vi.fn()` stub existed so that any handler
 * reading a tier would throw. It was a correct pin on a real fact and it is
 * now a pin on the opposite fact: the row-add path reads the rung and refuses
 * a non-Studio caller before the parcel lookup is consulted. Delete
 * `requirePeStudioScreens` from the rows route and this block fails.
 */
describe("P-101: adding a row is Studio, and the refusal precedes the lookup", () => {
  beforeEach(() => {
    store.screens = [];
    store.rows = [];
    store.saves = [];
    fakes.lookup.mockReset();
    fakes.resolver.mockReset();
    fakes.lookup.mockImplementation(async (id) =>
      id === HIT ? { parcelNodeId: HIT, label: "910 PINE" } : null,
    );
    fakes.resolver.mockImplementation(async () => []);
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "paid",
      subscriptionTier: "studio",
    };
  });

  it("a free caller is refused 402 and the parcel lookup is never called", async () => {
    const app = buildApp();
    const screenId = await createEmptyScreen(app);
    fakes.lookup.mockClear();

    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "free",
      subscriptionTier: null,
      entitlementSource: null,
    };

    const res = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: HIT, source: "walk" });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: "upgrade_required",
      reason: "studio_screens",
      tier: "free",
      subscriptionTier: null,
    });
    // Refused at the gate, so no upstream work happened and nothing was stored.
    expect(fakes.lookup).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it("a solo caller is refused; a studio caller is served on the same request", async () => {
    const app = buildApp();
    const screenId = await createEmptyScreen(app);

    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "paid",
      subscriptionTier: "solo",
    };
    const refused = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: HIT, source: "walk" });
    expect(refused.status).toBe(402);
    expect(refused.body.subscriptionTier).toBe("solo");
    expect(store.rows).toHaveLength(0);

    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      subscriptionTier: "studio",
    };
    const served = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: HIT, source: "walk" });
    expect(served.status).toBe(200);
    expect(served.body.row).toMatchObject({
      parcelNodeId: HIT,
      resolution: "resolved",
    });
    expect(store.rows).toHaveLength(1);
  });
});
