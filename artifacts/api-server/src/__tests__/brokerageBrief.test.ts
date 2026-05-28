/**
 * /api/brokerage/v1/* — Property Brief Chrome extension API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-001";

const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const geocodeAddressMock = vi.hoisted(() => vi.fn());
const completeChatMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());
const recordGtmEventMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageBrief.test: ctx.schema not set");
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
  formatSiteContextForLlm: (ctx: { layers: unknown[] }) =>
    ctx.layers.length ? "Site context layers:\n- mock" : "",
}));

vi.mock("../lib/recordGtmEvent", () => ({
  recordGtmEvent: recordGtmEventMock,
  GTM_CONSENT_VERSION: "2026-05-26-v1",
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
const { brokerageBriefRuns } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
  "X-Hauska-Install-Id": "install-brief-test-aaaaaaaa",
};

const layVerdictsJson = JSON.stringify({
  verdicts: [
    {
      id: "adu",
      label: "ADU / guest house",
      status: "maybe",
      oneLine: "Local rules mention ADUs — confirm with the city.",
      detailParagraph: "Code hints at accessory dwelling rules; zoning still controls.",
    },
    {
      id: "flood",
      label: "Flood risk",
      status: "maybe",
      oneLine: "FEMA shows elevated flood exposure.",
      detailParagraph: "Budget for flood insurance and verify with your agent.",
    },
    {
      id: "major_restrictions",
      label: "Major restrictions",
      status: "maybe",
      oneLine: "Setbacks or rental rules may limit plans.",
      detailParagraph: "Review setbacks and STR rules before renovating.",
    },
    {
      id: "corpus_coverage",
      label: "Local code coverage",
      status: "yes",
      oneLine: "Hauska has adopted-code coverage for this city.",
      detailParagraph: "This is research, not a permit approval.",
    },
  ],
});

function mockGrokResponses() {
  completeChatMock.mockImplementation(
    async (opts: { system?: string }) => {
      const system = opts.system ?? "";
      if (system.includes("lay-friendly") || system.includes("verdicts")) {
        return layVerdictsJson;
      }
      if (system.includes("research assistant") || system.includes("property intel")) {
        return JSON.stringify({
          answer: "An ADU may be possible subject to zoning. Confirm with planning.",
        });
      }
      return JSON.stringify({
        headline: "ADU and setbacks may apply for this Bastrop lot.",
        body: "The code addresses accessory dwellings [1]. Agents should verify zoning.",
      });
    },
  );
}

const mockAtom = {
  id: "did:hauska:atom:bastrop-adu-1",
  sourceName: "bastrop_municode",
  jurisdictionKey: "bastrop_tx",
  codeBook: "MUNI_CODE",
  edition: "current",
  sectionNumber: "3.2.1",
  sectionTitle: "Accessory dwelling units",
  body: "ADUs shall comply with setback requirements in Section 5.4.",
  sourceUrl: "https://example.com/adu",
  score: 0.82,
  retrievalMode: "vector",
};

beforeEach(() => {
  process.env.BROKERAGE_DEV_API_KEY = TEST_API_KEY;
  process.env.BROKERAGE_WALLET_BYPASS = "1";
  resetBrokerageApiKeysForTests();
  recordGtmEventMock.mockReset();
  geocodeAddressMock.mockReset();
  geocodeAddressMock.mockResolvedValue({
    latitude: 30.11,
    longitude: -97.32,
    jurisdictionCity: "Bastrop",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
  retrieveAtomsForQuestionMock.mockReset();
  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  fetchBrokerageSiteContextMock.mockReset();
  fetchBrokerageSiteContextMock.mockResolvedValue({
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
  completeChatMock.mockReset();
  mockGrokResponses();
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });
});

afterEach(() => {
  delete process.env.BROKERAGE_DEV_API_KEY;
  delete process.env.BROKERAGE_WALLET_BYPASS;
  resetBrokerageApiKeysForTests();
  setBriefingLlmClient(null);
});

describe("POST /api/brokerage/v1/brief", () => {
  it("returns 401 without API key", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .send({ address: "251 Cool Water Dr, Bastrop, TX 78602" });
    expect(res.status).toBe(401);
  });

  it("runs brief with grok reasoning for Bastrop address", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        source: "zillow",
      });

    expect(res.status).toBe(200);
    expect(res.body.runId).toBeTruthy();
    expect(res.body.jurisdiction).toBe("bastrop_tx");
    expect(res.body.siteContext.layers).toHaveLength(1);
    expect(res.body.siteContext.layers[0].layerKind).toBe(
      "fema-nfhl-flood-zone",
    );
    expect(fetchBrokerageSiteContextMock).toHaveBeenCalled();
    expect(res.body.sections).toHaveLength(5);
    expect(res.body.reasoningSummary.method).toBe("grok");
    expect(res.body.laySummary).toBeTruthy();
    expect(res.body.laySummary.verdicts.length).toBeGreaterThanOrEqual(3);
    expect(res.body.laySummary.verdicts[0].status).toMatch(
      /^(yes|maybe|no|unknown)$/,
    );
    expect(res.body.presentationMode).toBe("consumer");
    expect(retrieveAtomsForQuestionMock).toHaveBeenCalled();
    expect(completeChatMock.mock.calls.length).toBeGreaterThanOrEqual(2);

    if (!ctx.schema) throw new Error("schema missing");
    const [row] = await ctx.schema.db
      .select()
      .from(brokerageBriefRuns)
      .where(eq(brokerageBriefRuns.id, res.body.runId))
      .limit(1);
    expect(row).toBeTruthy();
  });
});

describe("POST /api/brokerage/v1/brief/summarize", () => {
  it("returns grok summary with citations", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief/summarize")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        jurisdiction: "bastrop_tx",
        corpusStatus: "in_corpus",
        atoms: [
          {
            atomDid: mockAtom.id,
            snippet: mockAtom.body,
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.headline).toBeTruthy();
    expect(res.body.html).toContain("<p>");
    expect(res.body.method).toBe("grok");
    expect(res.body.citations.length).toBeGreaterThan(0);
  });
});

describe("POST /api/brokerage/v1/research/chat", () => {
  it("returns 404 for unknown runId", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(authHeaders)
      .send({
        runId: "00000000-0000-4000-8000-000000000001",
        message: "Can the buyer add an ADU?",
        history: [],
      });
    expect(res.status).toBe(404);
  });

  it("answers with citations when run exists", async () => {
    completeChatMock.mockResolvedValueOnce(
      JSON.stringify({
        answer:
          "An ADU may be permitted subject to zoning [1]. Confirm with Bastrop planning.",
      }),
    );

    const briefRes = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({ address: "251 Cool Water Dr, Bastrop, TX 78602" });
    expect(briefRes.status).toBe(200);

    const chatRes = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(authHeaders)
      .send({
        runId: briefRes.body.runId,
        message: "Can the buyer add an ADU?",
        history: [],
      });

    expect(chatRes.status).toBe(200);
    expect(chatRes.body.message).toMatch(/ADU/i);
    expect(chatRes.body.method).toBe("grok");
    expect(chatRes.body.sources).toBeDefined();
    expect(Array.isArray(chatRes.body.sources)).toBe(true);
    expect(chatRes.body.presentationMode).toBe("consumer");
    expect(retrieveAtomsForQuestionMock.mock.calls.length).toBeGreaterThan(5);
  });

  it("logs starter_prompt_selected when starterPromptId is sent", async () => {
    const briefRes = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        starterPromptId: "adu",
        personaBucket: "owner_buyer",
      });
    expect(briefRes.status).toBe(200);

    const chatRes = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(authHeaders)
      .send({
        runId: briefRes.body.runId,
        message: "Could we add an ADU?",
        history: [],
        starterPromptId: "adu",
        personaBucket: "owner_buyer",
      });
    expect(chatRes.status).toBe(200);

    const starterEvents = recordGtmEventMock.mock.calls.filter(
      (c) => c[0]?.eventType === "starter_prompt_selected",
    );
    expect(starterEvents.length).toBeGreaterThanOrEqual(2);
    expect(starterEvents[0]![0].payload).toMatchObject({
      starterPromptId: "adu",
      personaBucket: "owner_buyer",
    });
  });
});
