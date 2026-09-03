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

/**
 * INVERTED 2026-09-02 (P-101), not deleted.
 *
 * This mock previously declared that "the paid gate must never be consulted on
 * the screens routes; a call here is a defect", and made a call fail loudly.
 * The operator ruling of 2026-08-31 reverses that premise for the WRITE side:
 * building a screen is the Studio job, and the two POST routes now carry
 * `requirePeStudioScreens`. The old assertion is rewritten to assert the new
 * behaviour rather than removed, so the file still says what the routes are
 * required to do.
 *
 * The `requirePePaidOrPropertyUnlocked` trap stays exactly as it was. That gate
 * is still wrong on these routes: screens are a Studio question, not a
 * per-property unlock question, and a call to it here is still a defect.
 *
 * The mock spreads the REAL module rather than hand-writing its exports.
 * `peStudioGate` imports `subscriptionTierGrantsStudio` from here, and a
 * hand-written copy in this factory would be a test that satisfies both sides
 * of its own predicate — the internal-consistency shape the 2026-08-31
 * amendment named when it found three copies of that function. Only the three
 * request-scoped seams are overridden.
 */
const entitlementState = vi.hoisted(() => ({
  snapshot: {
    tier: "paid" as "free" | "paid",
    subscriptionTier: "studio" as "solo" | "studio" | "team" | null,
    tenantId: "default",
    userId: "user-screens-stubs" as string | null,
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
    // Still a defect on these routes: a per-property unlock cannot answer a
    // Studio question. Unchanged by P-101.
    requirePePaidOrPropertyUnlocked: () =>
      (_req: Request, res: Response, _next: NextFunction) => {
        res.status(402).json({ error: "paid_gate_reached_on_screens_route" });
      },
    resolvePeEntitlement: vi.fn(async () => entitlementState.snapshot),
    resolvePeOwnerUserId: () => "user-screens-stubs",
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

/**
 * P-101 — the assertion this file used to make in reverse.
 *
 * Before 2026-08-31 this file declared that a paid gate on the screens routes
 * was a defect. The operator ruling split the two halves: BUILDING a screen is
 * the Studio job, READING one is not. These cases are what makes that gate
 * falsifiable — remove `requirePeStudioScreens` from either POST and this
 * block fails. The suite that surrounds it exercises the same routes with a
 * Studio caller, so both directions are covered in one file.
 */
describe("P-101: building a screen is Studio, reading one is not", () => {
  beforeEach(() => {
    resetFakes();
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "paid",
      subscriptionTier: "studio",
    };
  });

  function goFree(): void {
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "free",
      subscriptionTier: null,
      entitlementSource: null,
    };
  }

  it("a free caller is refused on POST /screens with a named reason, and nothing is stored", async () => {
    goFree();
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: "upgrade_required",
      reason: "studio_screens",
      tier: "free",
      subscriptionTier: null,
    });
    // The reason is a sentence that names the capability, not a bare code.
    expect(res.body.message).toMatch(/screen/i);
    // Refused BEFORE the handler: no resolver call, no row, no screen.
    expect(fakes.resolver).not.toHaveBeenCalled();
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("a solo caller is refused too — Solo is a paid rung and still not Studio", async () => {
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "paid",
      subscriptionTier: "solo",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: "upgrade_required",
      reason: "studio_screens",
      tier: "paid",
      subscriptionTier: "solo",
    });
    expect(store.screens).toHaveLength(0);
  });

  it("a free caller is refused on POST /screens/:id/rows", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });
    expect(created.status).toBe(200);
    const screenId = created.body.screen.id as string;
    const rowsBefore = store.rows.length;

    goFree();
    const res = await request(app)
      .post(`/api/property-explorer/v1/screens/${screenId}/rows`)
      .send({ parcelNodeId: OK2, source: "map" });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: "upgrade_required",
      reason: "studio_screens",
    });
    expect(store.rows).toHaveLength(rowsBefore);
  });

  it("a free caller is SERVED on both GET routes: empty list, and the screen it cannot add to", async () => {
    const app = buildApp();
    const created = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });
    expect(created.status).toBe(200);
    const screenId = created.body.screen.id as string;

    goFree();
    const bare = await request(app).get("/api/property-explorer/v1/screens");
    expect(bare.status).toBe(200);
    expect(Array.isArray(bare.body.screens)).toBe(true);

    const one = await request(app).get(
      `/api/property-explorer/v1/screens/${screenId}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.screen.id).toBe(screenId);
  });

  it("a team caller builds screens like a studio caller", async () => {
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      tier: "paid",
      subscriptionTier: "team",
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });
    expect(res.status).toBe(200);
    expect(res.body.screen.rows).toHaveLength(1);
  });

  it("the gate fails closed on an unauthenticated caller: 401, never a 402 naming a rung it has no account to hold", async () => {
    goFree();
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      authenticated: false,
      userId: null,
    };
    const app = buildApp();
    const res = await request(app)
      .post("/api/property-explorer/v1/screens")
      .send({ name: "walk", queries: [OK], source: "pasted" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "authentication_required" });
    entitlementState.snapshot = {
      ...entitlementState.snapshot,
      authenticated: true,
      userId: "user-screens-stubs",
    };
  });
});
