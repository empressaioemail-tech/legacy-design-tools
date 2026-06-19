/**
 * User-aware entitlement + workspace history across claimed installs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { claimInstallHistoryForUser, briefRunAccessibleToCaller } from "../lib/brokerageInstallClaim";
import { listingKeyFromAddress } from "../lib/brokerageWorkspace";

const completeChatMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
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

  retrieveAtomsForQuestionMock.mockResolvedValue([]);
  completeChatMock.mockResolvedValue(
    JSON.stringify({ answer: "The brief supports an ADU subject to zoning." }),
  );
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
});
