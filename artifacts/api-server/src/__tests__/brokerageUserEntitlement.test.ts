/**
 * User-aware entitlement + workspace history across claimed installs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { claimInstallHistoryForUser, briefRunAccessibleToCaller, workspaceAccessibleToCaller } from "../lib/brokerageInstallClaim";
import { listingKeyFromAddress } from "../lib/brokerageWorkspace";

const completeChatMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const geocodeAddressMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());
const recordGtmEventMock = vi.hoisted(() => vi.fn());

vi.mock("../lib/recordGtmEvent", () => ({
  recordGtmEvent: recordGtmEventMock,
  GTM_CONSENT_VERSION: "2026-05-26-v1",
}));

vi.mock("../lib/brokerageParcelKey", () => ({
  captureParcelKey: vi.fn(async () => null),
  parcelKeyKind: vi.fn(() => "apn"),
}));

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: geocodeAddressMock,
}));

vi.mock("../lib/brokerageSiteContext", () => ({
  fetchBrokerageSiteContext: fetchBrokerageSiteContextMock,
  formatSiteContextForLlm: (ctx: { layers: unknown[] }) =>
    ctx.layers.length ? "Site context layers:\n- mock" : "",
  formatBrokerageContextForLlm: (input: {
    siteContext?: { layers: unknown[] };
    privateRestrictionsBlock?: string;
  }) => {
    const parts = [
      input.siteContext?.layers.length ? "Site context layers:\n- mock" : "",
      input.privateRestrictionsBlock ?? "",
    ].filter(Boolean);
    return parts.join("\n\n");
  },
  stripSiteContextForClient: (ctx: {
    placeKey: string;
    layers: Array<{ payload?: unknown; [key: string]: unknown }>;
  }) => ({
    placeKey: ctx.placeKey,
    layers: ctx.layers.map(({ payload: _payload, ...layer }) => layer),
  }),
  stripBriefPayloadForClient: (brief: Record<string, unknown>) => {
    const raw = brief.siteContext as
      | {
          placeKey: string;
          layers: Array<{ payload?: unknown; [key: string]: unknown }>;
        }
      | undefined;
    if (!raw) return brief;
    return {
      ...brief,
      siteContext: {
        placeKey: raw.placeKey,
        layers: raw.layers.map(({ payload: _payload, ...layer }) => layer),
      },
    };
  },
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

const EXT_KEY = "brokerage-user-entitlement-ext-key";
const INSTALL_MAX = "install-user-entitlement-max";
const INSTALL_NEW = "install-user-entitlement-new";
const USER_ID = "user-entitlement-cross-install";

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

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { setBriefingLlmClient } = await import("../lib/briefingLlmClient");
const {
  brokerageBriefRuns,
  brokerageWallets,
  brokerageWorkspaces,
} = await import("@workspace/db");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

function sessionHeaders(installId?: string) {
  const token = mintSessionToken({
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: USER_ID },
  });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (installId) headers["X-Hauska-Install-Id"] = installId;
  return headers;
}

const mockAtom = {
  id: "did:hauska:atom:austin-adu-1",
  sourceName: "austin_municode",
  jurisdictionKey: "austin_tx",
  codeBook: "MUNI_CODE",
  edition: "current",
  sectionNumber: "3.2.1",
  sectionTitle: "Accessory dwelling units",
  body: "ADUs shall comply with setback requirements.",
  sourceUrl: "https://example.com/adu",
  score: 0.82,
  retrievalMode: "vector",
};

function mockGrokResponses() {
  completeChatMock.mockImplementation(async (opts: { system?: string }) => {
    const system = opts.system ?? "";
    if (system.includes("lay-friendly") || system.includes("verdicts")) {
      return JSON.stringify({
        verdicts: [
          {
            id: "adu",
            label: "ADU",
            status: "maybe",
            oneLine: "Confirm with city.",
            detailParagraph: "Zoning controls.",
          },
        ],
      });
    }
    return JSON.stringify({
      headline: "ADU may apply.",
      body: "Code addresses accessory dwellings [1].",
    });
  });
}

beforeEach(async () => {
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = EXT_KEY;
  resetBrokerageApiKeysForTests();

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql42 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0042_brokerage_entitlements.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql42);

  for (const installId of [INSTALL_MAX, INSTALL_NEW]) {
    await ctx.schema.db
      .insert(brokerageWallets)
      .values({ installId, balanceCents: 0, updatedAt: new Date() })
      .onConflictDoNothing();
  }

  await ctx.schema.db
    .update(brokerageWallets)
    .set({
      subscriptionTier: "max",
      subscriptionStatus: "active",
      subscriptionPeriodEnd: new Date(Date.now() + 86400000),
      freeBriefsUsed: 0,
    })
    .where(eq(brokerageWallets.installId, INSTALL_MAX));

  await ctx.schema.db
    .update(brokerageWallets)
    .set({
      subscriptionTier: null,
      subscriptionStatus: null,
      subscriptionPeriodEnd: null,
      freeBriefsUsed: 0,
    })
    .where(eq(brokerageWallets.installId, INSTALL_NEW));

  await claimInstallHistoryForUser(INSTALL_MAX, USER_ID);
  await claimInstallHistoryForUser(INSTALL_NEW, USER_ID);

  await ctx.schema.db.insert(brokerageWorkspaces).values({
    installId: INSTALL_MAX,
    ownerUserId: USER_ID,
    listingKey: "lk-max-only",
    address: "100 Max Install Ln, Austin, TX",
  });

  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  completeChatMock.mockResolvedValue(
    JSON.stringify({ answer: "The brief supports an ADU subject to zoning." }),
  );
  mockGrokResponses();
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });
  geocodeAddressMock.mockResolvedValue({
    latitude: 30.2672,
    longitude: -97.7431,
    jurisdictionCity: "Austin",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
  fetchBrokerageSiteContextMock.mockImplementation(
    async (input: { packageTier?: string }) => ({
      placeKey: "coord:30.26720:-97.74310",
      packageTier: input.packageTier ?? "free",
      layers: [
        {
          layerKind: "fema-nfhl-flood-zone",
          adapterKey: "fema:nfhl-flood-zone",
          tier: "federal",
          status: "ok",
          summary: "Flood Zone AE (high-risk)",
        },
      ],
    }),
  );
  recordGtmEventMock.mockReset();
});

afterEach(() => {
  setBriefingLlmClient(null);
});

describe("briefRunAccessibleToCaller", () => {
  it("accepts cross-install runs for the signed-in owner", () => {
    expect(
      briefRunAccessibleToCaller({
        run: { installId: INSTALL_MAX, ownerUserId: USER_ID },
        requestInstallId: INSTALL_NEW,
        serviceCaller: false,
        ownerUserId: USER_ID,
        claimedInstallIds: new Set([INSTALL_MAX, INSTALL_NEW]),
      }),
    ).toBe(true);
  });

  it("rejects cross-install runs for extension_public callers", () => {
    expect(
      briefRunAccessibleToCaller({
        run: { installId: INSTALL_MAX, ownerUserId: USER_ID },
        requestInstallId: INSTALL_NEW,
        serviceCaller: false,
        ownerUserId: null,
        claimedInstallIds: new Set(),
      }),
    ).toBe(false);
  });
});

describe("workspaceAccessibleToCaller", () => {
  it("accepts cross-install workspaces for the signed-in owner", () => {
    expect(
      workspaceAccessibleToCaller({
        workspace: { installId: INSTALL_MAX, ownerUserId: USER_ID },
        requestInstallId: INSTALL_NEW,
        serviceCaller: false,
        ownerUserId: USER_ID,
        claimedInstallIds: new Set([INSTALL_MAX, INSTALL_NEW]),
      }),
    ).toBe(true);
  });
});

describe("user-aware brokerage entitlement + workspaces", () => {
  it("GET /entitlement returns Max from a different install when tier user", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/entitlement")
      .set(sessionHeaders(INSTALL_NEW));

    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(true);
    expect(res.body.subscriptionTier).toBe("max");
  });

  it("GET /entitlement stays install-scoped for extension_public", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/entitlement")
      .set({
        Authorization: `Bearer ${EXT_KEY}`,
        "X-Hauska-Install-Id": INSTALL_NEW,
      });

    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(false);
    expect(res.body.subscriptionTier).toBeNull();
  });

  it("GET /workspaces/recent returns workspaces across claimed installs for tier user", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(sessionHeaders(INSTALL_NEW));

    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(1);
    expect(res.body.workspaces[0].address).toContain("Max Install Ln");
  });

  it("GET /entitlement works without install id for signed-in user (web portal path)", async () => {
    const res = await request(getApp())
      .get("/api/brokerage/v1/entitlement")
      .set(sessionHeaders());

    expect(res.status).toBe(200);
    expect(res.body.maxActive).toBe(true);
  });

  it("POST /research/chat resolves a brief run from another claimed install", async () => {
    const address = "400 Cross Install Rd, Austin, TX 78701";
    const listingKey = listingKeyFromAddress(address);

    await ctx.schema!.db.insert(brokerageBriefRuns).values({
      installId: INSTALL_MAX,
      ownerUserId: USER_ID,
      listingKey,
      address,
      payloadJson: {
        jurisdiction: "austin_tx",
        property: { address },
        citations: [],
        sections: [],
      },
    });

    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(sessionHeaders(INSTALL_NEW))
      .send({
        address,
        message: "Can we add an ADU?",
        history: [],
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/ADU/i);
  });

  it("POST /brief returns Max packageTier from another claimed install", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(sessionHeaders(INSTALL_NEW))
      .send({ address: "500 Brief Tier Rd, Austin, TX 78701" });

    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
  });

  it("GET /workspaces/:id opens a workspace from another claimed install", async () => {
    const [ws] = await ctx.schema!.db
      .select({ id: brokerageWorkspaces.id })
      .from(brokerageWorkspaces)
      .where(eq(brokerageWorkspaces.listingKey, "lk-max-only"))
      .limit(1);

    expect(ws?.id).toBeTruthy();

    const res = await request(getApp())
      .get(`/api/brokerage/v1/workspaces/${ws!.id}`)
      .set(sessionHeaders(INSTALL_NEW));

    expect(res.status).toBe(200);
    expect(res.body.address).toContain("Max Install Ln");
  });
});
