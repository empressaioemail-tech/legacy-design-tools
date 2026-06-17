/**
 * /api/brokerage/v1/place/* — place resolve, layers, dossier.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-place";
const BASTROP = "251 Cool Water Dr, Bastrop, TX 78602";
const CEDAR_HILL = "430 Evergreen Trl, Cedar Hill, TX 75104";

const geocodeAddressMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("place.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: geocodeAddressMock,
}));

vi.mock("../lib/brokerageSiteContext", () => ({
  fetchBrokerageSiteContext: fetchBrokerageSiteContextMock,
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
  };
});

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
};

const siteLayers = {
  placeKey: "coord:30.11000:-97.32000",
  parcelClip: "1234567890",
  layers: [
    {
      layerKind: "cotality-parcel",
      adapterKey: "cotality:parcels",
      tier: "federal",
      status: "ok",
      provider: "Cotality",
      summary: "CLIP 1234567890 · APN T-1",
      snapshotDate: "2026-05-01T00:00:00.000Z",
      fromArchive: false,
      payload: {
        clip: "1234567890",
        parcel: {
          properties: { parcelnumb: "T-1" },
        },
      },
    },
    {
      layerKind: "fema-nfhl-flood-zone",
      adapterKey: "fema:nfhl-flood-zone",
      tier: "federal",
      status: "ok",
      provider: "FEMA NFHL",
      summary: "Zone X",
      snapshotDate: "2026-05-01T00:00:00.000Z",
      fromArchive: false,
      payload: { floodZone: "X" },
    },
  ],
};

beforeEach(() => {
  process.env.BROKERAGE_DEV_API_KEY = TEST_API_KEY;
  resetBrokerageApiKeysForTests();
  retrieveAtomsForQuestionMock.mockResolvedValue([
    {
      id: "atom-place-1",
      sourceName: "bastrop_municode",
      jurisdictionKey: "bastrop_tx",
      codeBook: "UDC",
      edition: "2024",
      sectionNumber: "4.3.2",
      sectionTitle: "ADU",
      body: "Accessory dwelling units may be permitted.",
      sourceUrl: "https://example.com",
      score: 0.9,
      retrievalMode: "vector",
    },
  ]);
});

describe("place API", () => {
  it("POST /place/resolve returns placeKey + jurisdiction for Bastrop", async () => {
    geocodeAddressMock.mockResolvedValue({
      latitude: 30.11,
      longitude: -97.32,
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
    });
    fetchBrokerageSiteContextMock.mockResolvedValue(siteLayers);

    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .set(authHeaders)
      .send({ address: BASTROP });

    expect(res.status).toBe(200);
    expect(res.body.placeKey).toMatch(/^coord:/);
    expect(res.body.jurisdiction_key).toBe("bastrop_tx");
    expect(res.body.geocode.confidence).toBe("high");
    expect(res.body.workspaceDid).toMatch(/^did:hauska:property-workspace:/);
    expect(res.body.ll_uuid).toBe("1234567890");
  });

  it("POST /place/resolve returns Cedar Hill jurisdiction", async () => {
    geocodeAddressMock.mockResolvedValue({
      latitude: 32.588,
      longitude: -96.956,
      jurisdictionCity: "Cedar Hill",
      jurisdictionState: "TX",
    });
    fetchBrokerageSiteContextMock.mockResolvedValue({
      ...siteLayers,
      placeKey: "coord:32.58800:-96.95600",
    });

    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .set(authHeaders)
      .send({ address: CEDAR_HILL });

    expect(res.status).toBe(200);
    expect(res.body.jurisdiction_key).toBe("cedar_hill_tx");
  });

  it("POST /place/resolve geocode miss includes errorClass", async () => {
    geocodeAddressMock.mockResolvedValue(null);

    const res = await request(getApp())
      .post("/api/brokerage/v1/place/resolve")
      .set(authHeaders)
      .send({ address: "nowhere invalid xyz" });

    expect(res.status).toBe(422);
    expect(res.body.errorClass).toBe("geocode_miss");
  });

  it("GET dossier includes citations with asOf", async () => {
    fetchBrokerageSiteContextMock.mockResolvedValue({
      ...siteLayers,
      layers: siteLayers.layers.map((l) => ({ ...l, fromArchive: true })),
    });

    const res = await request(getApp())
      .get(`/api/brokerage/v1/place/${siteLayers.placeKey}/dossier`)
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.asOf).toBeTruthy();
    expect(res.body.layers[0].citation.asOf).toBeTruthy();
    expect(res.body.inlineRefs.length).toBeLessThanOrEqual(4);
    expect(
      res.body.layers.some((l: { provenance: string }) => l.provenance === "snapshot"),
    ).toBe(true);
  });

  it("GET layers lists layer kinds with provenance", async () => {
    fetchBrokerageSiteContextMock.mockResolvedValue(siteLayers);

    const res = await request(getApp())
      .get(`/api/brokerage/v1/place/${siteLayers.placeKey}/layers`)
      .set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body.layers.map((l: { layerKind: string }) => l.layerKind)).toContain(
      "cotality-parcel",
    );
    expect(res.body.layers[0].citation.source).toBeTruthy();
  });
});
