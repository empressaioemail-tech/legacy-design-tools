/**
 * Chrome Web Store extension_public client tier — auth, limits, gating.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
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
const { gtmEvents, brokerageWallets } = await import("@workspace/db");

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

function mockPflugervilleGeocode() {
  geocodeAddressMock.mockResolvedValue({
    latitude: 30.4397,
    longitude: -97.6203,
    jurisdictionCity: "Pflugerville",
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
  process.env.BROKERAGE_API_KEYS = OPERATOR_API_KEY;
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = PUBLIC_API_KEY;
  process.env.BROKERAGE_EXTENSION_PUBLIC_BRIEFS_PER_DAY = "5";
  process.env.BROKERAGE_EXTENSION_PUBLIC_RESEARCH_TURNS_PER_DAY = "20";
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
  delete process.env.BROKERAGE_API_KEYS;
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

  it("POST /brief succeeds for non-pilot jurisdiction (no 403)", async () => {
    mockPlanoGeocode();
    retrieveAtomsForQuestionMock.mockResolvedValue([]);
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "5800 Democracy Dr, Plano, TX 75024" });

    expect(res.status).toBe(200);
    expect(res.body.jurisdiction).toBe("plano_tx");
    expect(res.body.meta.clientTier).toBe("extension_public");
    expect(res.body.siteContext?.layers?.length).toBeGreaterThan(0);
  });

  it("POST /brief resolves Pflugerville and serves websearch local layer", async () => {
    mockPflugervilleGeocode();
    retrieveAtomsForQuestionMock.mockResolvedValue([]);
    supplementGroundingMock.mockResolvedValue({
      sections: [
        {
          atomId: "reasoning:pflugerville_tx:irc-r301-1",
          label: "IRC R301.1 — Application (design criteria)",
          snippet: "Design criteria from web.",
          webProvenance: {
            sourceUrl: "https://codes.iccsafe.org/",
            verified: false,
            confidence: 0.35,
            sourceName: "icc",
          },
        },
      ],
      reasoningRetrievedCount: 0,
      webFilledCount: 1,
    });

    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(publicHeaders)
      .send({ address: "17003 Simsbrook Dr, Pflugerville, TX 78660" });

    expect(res.status).toBe(200);
    expect(res.body.jurisdiction).toBe("pflugerville_tx");
    expect(res.body.localCodeSource).toBe("websearch");
    expect(res.body.coverage?.degraded).toBe(true);
    expect(res.body.coverage?.reason).toContain("web-scraped");
    expect(res.body.provenance?.coverage?.degraded).toBe(true);
  });

  it("POST /brief requires X-Hauska-Install-Id for public key", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set({ Authorization: `Bearer ${PUBLIC_API_KEY}` })
      .send({ address: "1904 Heathwood Cir, Round Rock, TX 78664" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("install_id_required");
  });

  describe("free brief entitlement (wallet balance 0)", () => {
    const FREE_INSTALL = "install-public-free-tier-aaaa";

    beforeEach(async () => {
      process.env.BROKERAGE_WALLET_BYPASS = "0";
      process.env.BROKERAGE_FREE_BRIEFS_CAP = "3";
      process.env.BROKERAGE_WALLET_START_BALANCE_CENTS = "0";
      if (!ctx.schema) return;
      await ctx.schema.db
        .delete(brokerageWallets)
        .where(eq(brokerageWallets.installId, FREE_INSTALL));
    });

    it("allows briefs 1-3 at zero balance and returns entitlement snapshot", async () => {
      const headers = {
        Authorization: `Bearer ${PUBLIC_API_KEY}`,
        "X-Hauska-Install-Id": FREE_INSTALL,
      };

      for (let n = 3; n >= 1; n -= 1) {
        const res = await request(getApp())
          .post("/api/brokerage/v1/brief")
          .set(headers)
          .send({ address: `190${n} Heathwood Cir, Round Rock, TX 78664` });
        expect(res.status).toBe(200);
        expect(res.body.entitlement).toEqual({
          freeBriefsRemaining: n - 1,
          freeBriefsCap: 3,
          proActive: false,
        });
      }
    });

    it("returns upgrade_required on 4th brief (cap exhausted)", async () => {
      const headers = {
        Authorization: `Bearer ${PUBLIC_API_KEY}`,
        "X-Hauska-Install-Id": FREE_INSTALL,
      };

      for (let i = 0; i < 3; i += 1) {
        const ok = await request(getApp())
          .post("/api/brokerage/v1/brief")
          .set(headers)
          .send({ address: `200${i} Heathwood Cir, Round Rock, TX 78664` });
        expect(ok.status).toBe(200);
      }

      const blocked = await request(getApp())
        .post("/api/brokerage/v1/brief")
        .set(headers)
        .send({ address: "2099 Heathwood Cir, Round Rock, TX 78664" });
      expect(blocked.status).toBe(402);
      expect(blocked.body.error).toBe("upgrade_required");
      expect(blocked.body.upgradeCta).toBe("pro_subscription");
      expect(blocked.body.freeBriefsRemaining).toBe(0);
    });

    it("GET /entitlement exposes snapshot for extension panel", async () => {
      const headers = {
        Authorization: `Bearer ${PUBLIC_API_KEY}`,
        "X-Hauska-Install-Id": FREE_INSTALL,
      };

      const ent = await request(getApp())
        .get("/api/brokerage/v1/entitlement")
        .set(headers);
      expect(ent.status).toBe(200);
      expect(ent.body.freeBriefsCap).toBe(3);
      expect(ent.body.freeBriefsRemaining).toBe(3);
      expect(ent.body.proActive).toBe(false);
    });
  });

  it("POST /workspaces/:id/share returns account_upgrade_required for public key", async () => {
    await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(operatorHeaders)
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
      .set(operatorHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(publicHeaders)
      .send({});

    expect(share.status).toBe(403);
    expect(share.body.error).toBe("account_upgrade_required");
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
