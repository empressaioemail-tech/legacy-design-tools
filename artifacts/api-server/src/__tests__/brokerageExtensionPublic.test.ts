/**
 * Chrome Web Store extension_public client tier — auth, limits, gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import type { Request } from "express";

const DEV_API_KEY = "brokerage-test-key-dev-001";
const PUBLIC_API_KEY = "brokerage-test-key-public-store-zzzzzzzz";
const PUBLIC_INSTALL = "install-public-aaaaaaaa";
const DEV_INSTALL = "install-dev-operator-bbbb";

const geocodeAddressMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
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
    countAtomsForJurisdiction: vi.fn(async () => 10),
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

const layVerdictsJson = JSON.stringify({
  verdicts: [
    {
      id: "adu",
      label: "ADU",
      status: "maybe",
      oneLine: "Maybe.",
      detailParagraph: "Detail.",
    },
    {
      id: "flood",
      label: "Flood",
      status: "maybe",
      oneLine: "Maybe.",
      detailParagraph: "Detail.",
    },
    {
      id: "major_restrictions",
      label: "Restrictions",
      status: "maybe",
      oneLine: "Maybe.",
      detailParagraph: "Detail.",
    },
    {
      id: "corpus_coverage",
      label: "Coverage",
      status: "yes",
      oneLine: "Yes.",
      detailParagraph: "Detail.",
    },
  ],
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

const devHeaders = {
  Authorization: `Bearer ${DEV_API_KEY}`,
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

function mockPlanoGeocode() {
  geocodeAddressMock.mockResolvedValue({
    latitude: 33.0198,
    longitude: -96.6989,
    jurisdictionCity: "Plano",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  process.env.BROKERAGE_DEV_API_KEY = DEV_API_KEY;
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = PUBLIC_API_KEY;
  process.env.BROKERAGE_EXTENSION_PUBLIC_BRIEFS_PER_DAY = "5";
  process.env.BROKERAGE_EXTENSION_PUBLIC_RESEARCH_TURNS_PER_DAY = "20";
  process.env.BROKERAGE_WALLET_BYPASS = "1";
  resetBrokerageApiKeysForTests();
  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  fetchBrokerageSiteContextMock.mockResolvedValue({ placeKey: "coord:30.50000:-97.60000", layers: [] });
  completeChatMock.mockImplementation(async (opts: { system?: string }) => {
    if ((opts.system ?? "").includes("verdicts")) return layVerdictsJson;
    return JSON.stringify({
      headline: "Round Rock brief",
      body: "Summary [1].",
      answer: "Answer [1].",
    });
  });
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });
  mockRoundRockGeocode();
});

afterEach(() => {
  delete process.env.BROKERAGE_DEV_API_KEY;
  delete process.env.BROKERAGE_EXTENSION_PUBLIC_KEY;
  delete process.env.BROKERAGE_EXTENSION_PUBLIC_BRIEFS_PER_DAY;
  delete process.env.BROKERAGE_EXTENSION_PUBLIC_RESEARCH_TURNS_PER_DAY;
  delete process.env.BROKERAGE_WALLET_BYPASS;
  resetBrokerageApiKeysForTests();
  setBriefingLlmClient(null);
});

describe("extension_public client tier", () => {
  it("POST /brief with public key + install id succeeds for Round Rock", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });

    expect(res.status).toBe(200);
    expect(res.body.jurisdiction).toBe("round_rock_tx");
    expect(res.body.meta.clientTier).toBe("extension_public");
    expect(res.body.workspaceId).toBeUndefined();
  });

  it("POST /brief rejects non-pilot jurisdiction with 403", async () => {
    mockPlanoGeocode();
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "5800 Democracy Dr, Plano, TX 75024" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("jurisdiction_not_available");
    expect(res.body.clientTier).toBe("extension_public");
    expect(res.body.jurisdiction).toBe("plano_tx");
  });

  it("POST /brief requires X-Hauska-Install-Id for public key", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set({ Authorization: `Bearer ${PUBLIC_API_KEY}` })
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("install_id_required");
  });

  it("POST /workspaces/:id/share returns account_upgrade_required for public key", async () => {
    await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(devHeaders)
      .send({ address: "100 Share Ln, Bastrop, TX 78602" });

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
      .set(devHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(publicHeaders)
      .send({});

    expect(share.status).toBe(403);
    expect(share.body.error).toBe("account_upgrade_required");
  });

  it("dev operator key still allows share", async () => {
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
      .set(devHeaders)
      .send({ address: "200 Dev Share Ln, Bastrop, TX 78602" });
    expect(brief.status).toBe(200);

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(devHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(devHeaders)
      .send({});
    expect(share.status).toBe(201);
  });

  it("returns 429 when per-install brief limit exceeded", async () => {
    if (!ctx.schema) throw new Error("schema missing");
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);

    for (let i = 0; i < 5; i++) {
      await ctx.schema.db.insert(gtmEvents).values({
        installId: PUBLIC_INSTALL,
        eventType: "brief_completed",
        payloadJson: { clientTier: "extension_public" },
        createdAt: today,
      });
    }

    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("rate_limit_exceeded");
    expect(res.body.clientTier).toBe("extension_public");
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
