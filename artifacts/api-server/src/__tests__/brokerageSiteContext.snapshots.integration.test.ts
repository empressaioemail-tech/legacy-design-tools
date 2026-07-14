/**
 * fetchBrokerageSiteContext — permanent snapshots skip live Regrid/FEMA.
 * Requires DATABASE_URL or TEST_DATABASE_URL.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import {
  createTestSchema,
  dropTestSchema,
  truncateAll,
  type TestSchemaContext,
} from "@workspace/db/testing";

const runAdaptersMock = vi.hoisted(() => vi.fn());
const resolveJurisdictionMock = vi.hoisted(() => vi.fn());
const createAdapterResponseCacheMock = vi.hoisted(() => vi.fn());

let testCtx: TestSchemaContext | null = null;

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!testCtx) {
        throw new Error("brokerageSiteContext.snapshots: test schema not ready");
      }
      return testCtx.db;
    },
  };
});

vi.mock("../lib/adapterCache", () => ({
  createAdapterResponseCache: createAdapterResponseCacheMock,
}));

vi.mock("@workspace/adapters", async () => {
  const actual = await vi.importActual<typeof import("@workspace/adapters")>(
    "@workspace/adapters",
  );
  return {
    ...actual,
    runAdapters: runAdaptersMock,
    resolveJurisdiction: resolveJurisdictionMock,
  };
});

const hasDb = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const cotalityParcelOutcome = {
  adapterKey: "cotality:parcels",
  tier: "federal",
  layerKind: "cotality-parcel",
  status: "ok" as const,
  result: {
    adapterKey: "cotality:parcels",
    tier: "federal",
    layerKind: "cotality-parcel",
    sourceKind: "national-aggregator",
    provider: "Cotality",
    snapshotDate: "2026-05-01T00:00:00.000Z",
    payload: {
      kind: "parcel",
      clip: "1234567890",
      parcel: {
        properties: { parcelnumb: "INT-001" },
      },
    },
  },
};

const femaOutcome = {
  adapterKey: "fema:nfhl-flood-zone",
  tier: "federal",
  layerKind: "fema-nfhl-flood-zone",
  status: "ok" as const,
  result: {
    adapterKey: "fema:nfhl-flood-zone",
    tier: "federal",
    layerKind: "fema-nfhl-flood-zone",
    sourceKind: "federal-adapter",
    provider: "FEMA NFHL",
    snapshotDate: "2026-05-01T00:00:00.000Z",
    payload: {
      kind: "flood-zone",
      inSpecialFloodHazardArea: false,
      floodZone: "X",
    },
  },
};

describe.skipIf(!hasDb)("fetchBrokerageSiteContext snapshots (integration)", () => {
  beforeAll(async () => {
    testCtx = await createTestSchema();
  }, 120_000);

  afterAll(async () => {
    if (testCtx) await dropTestSchema(testCtx);
    testCtx = null;
  });

  beforeEach(() => {
    createAdapterResponseCacheMock.mockReturnValue(undefined);
    resolveJurisdictionMock.mockReturnValue({
      stateKey: "texas",
      localKey: "round-rock-tx",
    });
  });

  afterEach(async () => {
    if (!testCtx) return;
    await truncateAll(testCtx.pool, ["place_layer_snapshots"]);
    runAdaptersMock.mockReset();
  });

  it("second fetch at same coords does not call runAdapters when snapshots exist", async () => {
    runAdaptersMock.mockResolvedValue([
      femaOutcome,
      cotalityParcelOutcome,
      {
        adapterKey: "cotality:zoning",
        tier: "federal",
        layerKind: "cotality-zoning",
        status: "no-coverage",
        error: { code: "no-coverage", message: "none" },
      },
      {
        adapterKey: "national:opportunity-zone",
        tier: "federal",
        layerKind: "opportunity-zone",
        status: "ok" as const,
        result: {
          adapterKey: "national:opportunity-zone",
          tier: "federal",
          layerKind: "opportunity-zone",
          sourceKind: "federal-adapter",
          provider: "CDFI Fund / HUD (OZ tracts)",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: { inOpportunityZone: false, ozRound: "oz-1.0" },
        },
      },
      // feat/cad-brief-adapters — the free tier now carries the three
      // cad:* adapters. Deterministic no-coverage here (the mocked run
      // is a Collin County point, outside the five supported counties)
      // so the empty-archive snapshot suppresses a live re-run, same as
      // cotality:zoning above.
      ...["cad:property", "cad:tax", "cad:owner-occupancy"].map(
        (adapterKey) => ({
          adapterKey,
          tier: "local",
          layerKind: adapterKey.replace(":", "-"),
          status: "no-coverage" as const,
          error: { code: "no-coverage" as const, message: "outside counties" },
        }),
      ),
    ]);

    const { fetchBrokerageSiteContext } = await import(
      "../lib/brokerageSiteContext"
    );

    const input = {
      latitude: 33.0198,
      longitude: -96.6989,
      address: "3900 Round Rock Ranch Rd, Round Rock, TX 78665",
      jurisdictionCity: "Round Rock",
      jurisdictionState: "TX",
    };

    const first = await fetchBrokerageSiteContext(input);
    expect(runAdaptersMock).toHaveBeenCalledOnce();
    expect(first.layers.some((l) => l.layerKind === "cotality-parcel")).toBe(
      true,
    );

    runAdaptersMock.mockClear();

    const second = await fetchBrokerageSiteContext(input);
    expect(runAdaptersMock).not.toHaveBeenCalled();
    expect(second.layers.find((l) => l.layerKind === "cotality-parcel")?.fromArchive).toBe(
      true,
    );
  });
});
