/**
 * Free brief entitlement tier — gate consumes free cap before wallet debit.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-commercial-01";
const OWNER_INSTALL = "install-commercial-owner-aaaa";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const geocodeAddressMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const completeChatMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());

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
const { gtmConsent, brokerageWallets } = await import("@workspace/db");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
  "X-Hauska-Install-Id": OWNER_INSTALL,
};

const mockAtom = {
  id: "did:hauska:atom:bastrop-adu-1",
  sourceName: "bastrop_municode",
  jurisdictionKey: "bastrop_tx",
  codeBook: "MUNI_CODE",
  edition: "current",
  sectionNumber: "3.2.1",
  sectionTitle: "Accessory dwelling units",
  body: "ADUs shall comply with setback requirements.",
  sourceUrl: "https://example.com/adu",
  score: 0.82,
  retrievalMode: "vector" as const,
};

beforeAll(async () => {
  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql42 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0042_brokerage_entitlements.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql42);
});

beforeEach(async () => {
  process.env.BROKERAGE_API_KEYS = TEST_API_KEY;
  process.env.BROKERAGE_FREE_BRIEFS_CAP = "3";
  process.env.BROKERAGE_WALLET_BYPASS = "0";
  process.env.BROKERAGE_WALLET_START_BALANCE_CENTS = "0";
  process.env.BROKERAGE_COMPUTE_COST_CENTS = "100";
  resetBrokerageApiKeysForTests();

  geocodeAddressMock.mockResolvedValue({
    latitude: 30.11,
    longitude: -97.32,
    jurisdictionCity: "Bastrop",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  fetchBrokerageSiteContextMock.mockResolvedValue({
    layers: [],
    placeKey: "coord:30.11000:-97.32000",
    packageTier: "free",
  });
  completeChatMock.mockResolvedValue(
    JSON.stringify({
      headline: "Test headline",
      body: "Test body [1].",
      answer: "Test answer [1].",
      verdicts: [
        { id: "adu", label: "ADU", status: "maybe", oneLine: "x", detailParagraph: "y" },
      ],
    }),
  );
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });

  if (!ctx.schema) return;
  await ctx.schema.db.insert(gtmConsent).values({
    installId: OWNER_INSTALL,
    consentVersion: "2026-05-26-v1",
    termsAcceptedAt: new Date(),
    graphOptIn: true,
    updatedAt: new Date(),
  });
  await ctx.schema.db
    .update(brokerageWallets)
    .set({ freeBriefsUsed: 0, balanceCents: 0 })
    .where(eq(brokerageWallets.installId, OWNER_INSTALL));
});

describe("commercialization free-brief tier", () => {
  it("allows first brief at zero wallet balance under free cap", async () => {
    const wallet = await request(getApp())
      .get("/api/brokerage/v1/wallet")
      .set(authHeaders);
    expect(wallet.status).toBe(200);
    expect(wallet.body.freeBriefsCap).toBe(3);
    expect(wallet.body.freeBriefsRemaining).toBe(3);
    expect(wallet.body.balanceCents).toBe(0);

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        page_url: "https://matrix.example/listing/free-1",
      });
    expect(brief.status).toBe(200);
    expect(brief.body.entitlement?.freeBriefsRemaining).toBe(2);

    const after = await request(getApp())
      .get("/api/brokerage/v1/wallet")
      .set(authHeaders);
    expect(after.body.freeBriefsUsed).toBe(1);
    expect(after.body.freeBriefsRemaining).toBe(2);
    expect(after.body.balanceCents).toBe(0);
  });

  it("returns upgrade_required after free cap exhausted", async () => {
    process.env.BROKERAGE_FREE_BRIEFS_CAP = "3";
    await request(getApp()).get("/api/brokerage/v1/wallet").set(authHeaders);
    if (!ctx.schema) throw new Error("schema missing");
    await ctx.schema.db
      .update(brokerageWallets)
      .set({ freeBriefsUsed: 3, balanceCents: 0 })
      .where(eq(brokerageWallets.installId, OWNER_INSTALL));

    const blocked = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({ address: "999 Cap Ln, Bastrop, TX 78602" });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe("upgrade_required");
    expect(blocked.body.upgradeCta).toBe("pro_subscription");
  });
});
