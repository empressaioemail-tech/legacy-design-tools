/**
 * Place dossier — second request uses snapshots (0 live Regrid HTTP).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterEach,
} from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-place-snap";
const runAdaptersMock = vi.hoisted(() => vi.fn());
const resolveJurisdictionMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const createAdapterResponseCacheMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("place.snapshots: ctx.schema not set");
      return ctx.schema.db;
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

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
  };
});

const hasDb = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

const regridOutcome = {
  adapterKey: "regrid:parcels",
  tier: "federal",
  layerKind: "regrid-parcel",
  status: "ok" as const,
  result: {
    adapterKey: "regrid:parcels",
    tier: "federal",
    layerKind: "regrid-parcel",
    sourceKind: "national-aggregator",
    provider: "Regrid",
    snapshotDate: "2026-05-01T00:00:00.000Z",
    payload: {
      kind: "parcel",
      parcel: {
        properties: {
          fields: {
            ll_uuid: "dossier-snap-uuid",
            parcelnumb: "DS-001",
          },
        },
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
    payload: { kind: "flood-zone", floodZone: "X" },
  },
};

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { truncateAll } = await import("@workspace/db/testing");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

describe.skipIf(!hasDb)("place dossier snapshots (integration)", () => {
  beforeAll(async () => {
    process.env.BROKERAGE_DEV_API_KEY = TEST_API_KEY;
    resetBrokerageApiKeysForTests();
    if (!ctx.schema) return;
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, "../../../../lib/db/drizzle/0030_place_layer_snapshots.sql"),
      "utf8",
    );
    await ctx.schema.pool.query(sql);
  });

  beforeEach(() => {
    createAdapterResponseCacheMock.mockReturnValue(undefined);
    resolveJurisdictionMock.mockReturnValue({
      stateKey: "texas",
      localKey: "bastrop-tx",
    });
    retrieveAtomsForQuestionMock.mockResolvedValue([]);
    runAdaptersMock.mockResolvedValue([
      femaOutcome,
      {
        adapterKey: "usgs:ned-elevation",
        tier: "federal",
        layerKind: "usgs-ned-elevation",
        status: "ok" as const,
        result: {
          adapterKey: "usgs:ned-elevation",
          tier: "federal",
          layerKind: "usgs-ned-elevation",
          sourceKind: "federal-adapter",
          provider: "USGS",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: { kind: "elevation-point", elevationFeet: 700, units: "Feet" },
        },
      },
      {
        adapterKey: "epa:ejscreen",
        tier: "federal",
        layerKind: "epa-ejscreen-blockgroup",
        status: "ok" as const,
        result: {
          adapterKey: "epa:ejscreen",
          tier: "federal",
          layerKind: "epa-ejscreen-blockgroup",
          sourceKind: "federal-adapter",
          provider: "EPA",
          snapshotDate: "2026-05-01T00:00:00.000Z",
          payload: { kind: "ejscreen-blockgroup", demographicIndexPercentile: 55 },
        },
      },
      regridOutcome,
      {
        adapterKey: "regrid:zoning",
        tier: "federal",
        layerKind: "regrid-zoning",
        status: "no-coverage",
        error: { code: "no-coverage", message: "none" },
      },
    ]);
  });

  afterEach(async () => {
    if (!ctx.schema) return;
    await truncateAll(ctx.schema.pool, ["place_layer_snapshots"]);
    runAdaptersMock.mockReset();
  });

  it("second GET dossier does not call runAdapters", async () => {
    const placeKey = "coord:30.11000:-97.32000";
    const auth = { Authorization: `Bearer ${TEST_API_KEY}` };

    const first = await request(getApp())
      .get(`/api/brokerage/v1/place/${placeKey}/dossier`)
      .set(auth);
    expect(first.status).toBe(200);
    expect(runAdaptersMock).toHaveBeenCalled();

    runAdaptersMock.mockClear();

    const second = await request(getApp())
      .get(`/api/brokerage/v1/place/${placeKey}/dossier`)
      .set(auth);
    expect(second.status).toBe(200);
    expect(runAdaptersMock).not.toHaveBeenCalled();
    expect(
      second.body.layers.some(
        (l: { provenance: string }) => l.provenance === "snapshot",
      ),
    ).toBe(true);
  });
});
