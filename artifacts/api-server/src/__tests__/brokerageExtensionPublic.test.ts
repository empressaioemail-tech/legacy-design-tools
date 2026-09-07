/**
 * Chrome Web Store extension_public client tier — RETIRED (operator ruling
 * 2026-09-07: "cut the chrome extension we don't need it"). This file used
 * to grade the tier's live behavior (auth, per-install limits, wallet
 * entitlement, GTM rate limiting); all of that is now unreachable, since
 * BROKERAGE_EXTENSION_PUBLIC_KEY is no longer a recognized key at all (see
 * brokerageAuth.ts). What remains here: the old public key is proven
 * unauthorized across every route this tier used to reach, and the two
 * tests that never depended on the tier actually authenticating (the
 * operator-tier share path, and the pure gtmPayloadWithClientTier tagging
 * function) are kept unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";
import type { Request } from "express";

const OPERATOR_API_KEY = "brokerage-test-key-operator-001";
const PUBLIC_API_KEY = "brokerage-test-key-public-store-zzzzzzzz";
const PUBLIC_INSTALL = "install-public-aaaaaaaa";
const DEV_INSTALL = "install-dev-operator-bbbb";

const geocodeAddressMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const supplementGroundingMock = vi.hoisted(() => vi.fn());
const completeChatMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageExtensionPublic.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: geocodeAddressMock,
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
    countAtomsForJurisdiction: vi.fn(async () => 0),
    supplementCodeSectionsWithReasoningGrounding: supplementGroundingMock,
  };
});

vi.mock("../lib/brokerageSiteContext", () => ({
  fetchBrokerageSiteContext: fetchBrokerageSiteContextMock,
  formatSiteContextForLlm: () => "",
  formatBrokerageContextForLlm: () => "",
  stripSiteContextForClient: (ctx: {
    placeKey: string;
    layers: Array<{ payload?: unknown; [key: string]: unknown }>;
  }) => ({
    placeKey: ctx.placeKey,
    layers: ctx.layers.map(({ payload: _payload, ...layer }) => layer),
  }),
  stripBriefPayloadForClient: (brief: Record<string, unknown>) => brief,
}));

vi.mock("../lib/briefingLlmClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/briefingLlmClient")>(
    "../lib/briefingLlmClient",
  );
  return {
    ...actual,
    getBriefingLlmClient: vi.fn(async () => ({
      kind: "grok" as const,
      client: { completeChat: completeChatMock },
    })),
  };
});

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { setBriefingLlmClient } = await import("../lib/briefingLlmClient");
const {
  gtmPayloadWithClientTier,
  EXTENSION_PUBLIC_CLIENT_TIER,
} = await import("../lib/brokerageExtensionPublic");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(async () => {
  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql42 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0042_brokerage_entitlements.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql42);
});

const mockAtom = {
  id: "did:hauska:atom:rr-adu-1",
  sourceName: "round_rock",
  jurisdictionKey: "round_rock_tx",
  codeBook: "MUNI_CODE",
  edition: "current",
  sectionNumber: "1",
  sectionTitle: "ADU",
  body: "ADU rules apply.",
  sourceUrl: "https://example.com",
  score: 0.8,
  retrievalMode: "vector" as const,
};

const publicHeaders = {
  Authorization: `Bearer ${PUBLIC_API_KEY}`,
  "X-Hauska-Install-Id": PUBLIC_INSTALL,
};

const operatorHeaders = {
  Authorization: `Bearer ${OPERATOR_API_KEY}`,
  "X-Hauska-Install-Id": DEV_INSTALL,
};

function mockRoundRockGeocode() {
  geocodeAddressMock.mockResolvedValue({
    latitude: 30.5083,
    longitude: -97.6789,
    jurisdictionCity: "Round Rock",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  process.env.BROKERAGE_API_KEYS = OPERATOR_API_KEY;
  process.env.BROKERAGE_WALLET_BYPASS = "1";
  resetBrokerageApiKeysForTests();
  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  supplementGroundingMock.mockResolvedValue({
    sections: [],
    reasoningRetrievedCount: 0,
    webFilledCount: 0,
  });
  fetchBrokerageSiteContextMock.mockResolvedValue({
    placeKey: "coord:30.50000:-97.60000",
    layers: [
      {
        layerKind: "fema-nfhl-flood-zone",
        adapterKey: "fema:nfhl-flood-zone",
        tier: "federal",
        status: "ok",
        summary: "Flood Zone AE (high-risk)",
      },
    ],
  });
  completeChatMock.mockImplementation(async () =>
    JSON.stringify({
      headline: "Round Rock brief",
      body: "Summary [1].",
      answer: "Answer [1].",
    }),
  );
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });
  mockRoundRockGeocode();
});

afterEach(() => {
  delete process.env.BROKERAGE_API_KEYS;
  delete process.env.BROKERAGE_WALLET_BYPASS;
  resetBrokerageApiKeysForTests();
  setBriefingLlmClient(null);
});

describe("extension_public client tier — retired (operator ruling 2026-09-07)", () => {
  it("POST /brief with the old public key is unauthorized, install id present or not", async () => {
    const withInstall = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });
    expect(withInstall.status).toBe(401);
    expect(withInstall.body.error).toBe("unauthorized");

    const withoutInstall = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set({ Authorization: `Bearer ${PUBLIC_API_KEY}` })
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });
    expect(withoutInstall.status).toBe(401);
    expect(withoutInstall.body.error).toBe("unauthorized");
  });

  it("GET /entitlement with the old public key is unauthorized", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/entitlement")
      .set(publicHeaders);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("POST /workspaces/:id/share with the old public key is unauthorized (never reaches account_upgrade_required)", async () => {
    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(operatorHeaders)
      .send({ address: "100 Share Ln, Bastrop, TX 78602" });
    expect(brief.status).toBe(200);

    geocodeAddressMock.mockResolvedValue({
      latitude: 30.11,
      longitude: -97.32,
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: null,
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(operatorHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(publicHeaders)
      .send({});

    expect(share.status).toBe(401);
    expect(share.body.error).toBe("unauthorized");
  });

  it("operator API key still allows share", async () => {
    geocodeAddressMock.mockResolvedValue({
      latitude: 30.11,
      longitude: -97.32,
      jurisdictionCity: "Bastrop",
      jurisdictionState: "TX",
      jurisdictionFips: null,
      source: "nominatim",
      geocodedAt: new Date().toISOString(),
    });

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(operatorHeaders)
      .send({ address: "200 Dev Share Ln, Bastrop, TX 78602" });
    expect(brief.status).toBe(200);

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(operatorHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(operatorHeaders)
      .send({});
    expect(share.status).toBe(201);
  });

  it("gtmPayloadWithClientTier tags extension_public for public auth", () => {
    const req = {
      brokerageAuth: { tier: "extension_public" as const },
    } as Request;
    expect(
      gtmPayloadWithClientTier(req, { corpusStatus: "in_corpus" }),
    ).toMatchObject({
      corpusStatus: "in_corpus",
      clientTier: EXTENSION_PUBLIC_CLIENT_TIER,
    });
  });
});
