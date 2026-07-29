/**
 * R1 paywall (LOCK 2026-07-29) — property-scoped entitlement + signed-in
 * free chat counter.
 *
 * Covers:
 *   - GET /entitlement read shapes (anon / free / free+property / unlocked /
 *     paid) — the pinned contract the PE BFF builds against
 *   - the paid-OR-property-unlocked gate on the R1 report routes
 *   - the dev-unlock stub writer (hasPeDevPaidBypass-guarded interface)
 *   - the server-enforced free chat counter on /research/chat (PE-session
 *     branch): under-limit allow+count, at-limit 402, summary rules,
 *     entitled-unlimited-uncounted, no-parcel honest 402
 *   - counter atomicity under concurrent consumption
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  db,
  peChatMessageCounts,
  pePropertyUnlocks,
  peUserEntitlements,
  peUserIdentities,
  users,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

const completeChatMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-property-entitlement: ctx.schema not set");
      }
      return ctx.schema.db;
    },
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
const {
  consumePeFreeChatMessage,
  PE_FREE_CHAT_MESSAGE_LIMIT,
} = await import("../lib/peEntitlement");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const USER_FREE = "user-pp-free";
const USER_PAID = "user-pp-paid";
const USER_UNLOCKED = "user-pp-unlocked";
const PARCEL = "48055:10068";
const OTHER_PARCEL = "48055:20099";
const EXT_KEY = "pe-property-entitlement-ext-key";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

/** Session-bearer headers — the real PE web-app auth shape (tier "user"). */
function peSessionHeaders(userId: string): Record<string, string> {
  const token = mintSessionToken({
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: userId },
  });
  return { Authorization: `Bearer ${token}` };
}

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    message: "What are the setbacks here?",
    history: [],
    areaContext: {
      scope: "area",
      subject: { parcelNodeId: PARCEL },
    },
    ...overrides,
  };
}

async function chatCountFor(userId: string, parcelNodeId: string) {
  const [row] = await db
    .select({ count: peChatMessageCounts.count })
    .from(peChatMessageCounts)
    .where(
      and(
        eq(peChatMessageCounts.ownerUserId, userId),
        eq(peChatMessageCounts.parcelNodeId, parcelNodeId),
      ),
    )
    .limit(1);
  return row?.count ?? 0;
}

beforeEach(async () => {
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = EXT_KEY;
  resetBrokerageApiKeysForTests();
  retrieveAtomsForQuestionMock.mockResolvedValue([]);
  completeChatMock.mockResolvedValue(
    JSON.stringify({ answer: "Setbacks come from the zoning district." }),
  );

  await db.insert(users).values([
    { id: USER_FREE, displayName: "Free User" },
    { id: USER_PAID, displayName: "Paid User" },
    { id: USER_UNLOCKED, displayName: "Unlocked User" },
  ]);
  await db.insert(peUserEntitlements).values([
    { ownerUserId: USER_FREE, tenantId: DEFAULT_TENANT_ID, accessTier: "free" },
    { ownerUserId: USER_PAID, tenantId: DEFAULT_TENANT_ID, accessTier: "paid" },
    {
      ownerUserId: USER_UNLOCKED,
      tenantId: DEFAULT_TENANT_ID,
      accessTier: "free",
    },
  ]);
  await db.insert(pePropertyUnlocks).values({
    ownerUserId: USER_UNLOCKED,
    tenantId: DEFAULT_TENANT_ID,
    parcelNodeId: PARCEL,
    source: "stub",
  });
});

describe("GET /entitlement property block (pinned contract)", () => {
  it("anonymous with parcelNodeId keeps today's shape (no property block)", async () => {
    const res = await request(getApp()).get(
      `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(PARCEL)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.tier).toBe("free");
    expect(res.body.property).toBeUndefined();
  });

  it("authenticated without parcelNodeId has no property block", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER_FREE,
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.property).toBeUndefined();
  });

  it("free user + parcelNodeId returns locked property with zero used", async () => {
    const res = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(PARCEL)}`,
      ),
      USER_FREE,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authenticated: true,
      tier: "free",
      property: {
        parcelNodeId: PARCEL,
        unlocked: false,
        freeMessagesUsed: 0,
        freeMessagesLimit: 3,
      },
    });
  });

  it("free user's property block reflects the persisted message count", async () => {
    await db.insert(peChatMessageCounts).values({
      ownerUserId: USER_FREE,
      parcelNodeId: PARCEL,
      count: 2,
    });
    const res = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(PARCEL)}`,
      ),
      USER_FREE,
    );
    expect(res.body.property.freeMessagesUsed).toBe(2);
  });

  it("property-unlocked user shows unlocked=true on that parcel only", async () => {
    const unlockedRes = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(PARCEL)}`,
      ),
      USER_UNLOCKED,
    );
    expect(unlockedRes.body.tier).toBe("free");
    expect(unlockedRes.body.property.unlocked).toBe(true);

    const otherRes = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(OTHER_PARCEL)}`,
      ),
      USER_UNLOCKED,
    );
    expect(otherRes.body.property.unlocked).toBe(false);
  });

  it("paid user shows unlocked=true on any parcel", async () => {
    const res = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/entitlement?parcelNodeId=${encodeURIComponent(OTHER_PARCEL)}`,
      ),
      USER_PAID,
    );
    expect(res.body.tier).toBe("paid");
    expect(res.body.property.unlocked).toBe(true);
  });
});

describe("paid-OR-property-unlocked gate on report routes", () => {
  it("free user still 402s on research/brief", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: PARCEL }),
      USER_FREE,
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
    expect(res.body.property).toEqual({ parcelNodeId: PARCEL, unlocked: false });
  });

  it("property-unlocked user clears the brief gate (honest 404, no snapshot seeded)", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: PARCEL }),
      USER_UNLOCKED,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("baked_snapshot_not_found");
  });

  it("property-unlocked user is still walled off OTHER parcels", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: OTHER_PARCEL }),
      USER_UNLOCKED,
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
  });

  it("paid user clears the gate unchanged", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: PARCEL }),
      USER_PAID,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("baked_snapshot_not_found");
  });

  it("layer-manifest resolves the parcel from the runId for the unlock check", async () => {
    const runId = `pe-r1-${Buffer.from(PARCEL).toString("base64url")}.${Buffer.from(
      "undated",
    ).toString("base64url")}`;
    const unlockedRes = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/research/layer-manifest/${encodeURIComponent(runId)}`,
      ),
      USER_UNLOCKED,
    );
    expect(unlockedRes.status).toBe(404);
    expect(unlockedRes.body.error).toBe("baked_snapshot_not_found");

    const freeRes = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/research/layer-manifest/${encodeURIComponent(runId)}`,
      ),
      USER_FREE,
    );
    expect(freeRes.status).toBe(402);
    expect(freeRes.body.error).toBe("upgrade_required");
  });
});

describe("dev-unlock stub writer", () => {
  it("rejects anonymous callers", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/internal/dev-unlock")
      .send({ parcelNodeId: PARCEL });
    expect(res.status).toBe(401);
  });

  it("rejects authenticated users without the dev bypass", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/internal/dev-unlock")
        .send({ parcelNodeId: PARCEL }),
      USER_FREE,
    );
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("dev_bypass_required");
  });

  it("bypass-listed operator writes an unlock through the shared writer", async () => {
    await db.insert(peUserIdentities).values({
      id: "pei_google_pp-operator",
      userId: USER_FREE,
      provider: "google",
      subject: "pp-operator",
      email: "operator@example.com",
    });
    const prior = process.env.PE_DEV_PAID_EMAILS;
    process.env.PE_DEV_PAID_EMAILS = "operator@example.com";
    try {
      const res = await asUser(
        request(getApp())
          .post("/api/property-explorer/v1/internal/dev-unlock")
          .send({ parcelNodeId: OTHER_PARCEL, ownerUserId: USER_UNLOCKED }),
        USER_FREE,
      );
      expect(res.status).toBe(201);
      expect(res.body.unlock).toEqual({
        ownerUserId: USER_UNLOCKED,
        parcelNodeId: OTHER_PARCEL,
        source: "dev",
      });
      const [row] = await db
        .select()
        .from(pePropertyUnlocks)
        .where(
          and(
            eq(pePropertyUnlocks.ownerUserId, USER_UNLOCKED),
            eq(pePropertyUnlocks.parcelNodeId, OTHER_PARCEL),
          ),
        );
      expect(row?.source).toBe("dev");
    } finally {
      if (prior === undefined) delete process.env.PE_DEV_PAID_EMAILS;
      else process.env.PE_DEV_PAID_EMAILS = prior;
    }
  });
});

describe("research/chat PE-session free counter", () => {
  it("free user gets exactly 3 counted messages then a 402 wall", async () => {
    for (let i = 1; i <= PE_FREE_CHAT_MESSAGE_LIMIT; i++) {
      const res = await request(getApp())
        .post("/api/brokerage/v1/research/chat")
        .set(peSessionHeaders(USER_FREE))
        .send(chatBody());
      expect(res.status, `message ${i} should be allowed`).toBe(200);
      expect(await chatCountFor(USER_FREE, PARCEL)).toBe(i);
    }
    const walled = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_FREE))
      .send(chatBody());
    expect(walled.status).toBe(402);
    expect(walled.body).toMatchObject({
      error: "free_messages_exhausted",
      freeMessagesUsed: 3,
      freeMessagesLimit: 3,
    });
    expect(await chatCountFor(USER_FREE, PARCEL)).toBe(3);
  });

  it("free allowance is per property (fresh parcel gets its own taste)", async () => {
    await db.insert(peChatMessageCounts).values({
      ownerUserId: USER_FREE,
      parcelNodeId: PARCEL,
      count: 3,
    });
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_FREE))
      .send(
        chatBody({
          areaContext: { scope: "area", subject: { parcelNodeId: OTHER_PARCEL } },
        }),
      );
    expect(res.status).toBe(200);
    expect(await chatCountFor(USER_FREE, OTHER_PARCEL)).toBe(1);
  });

  it("property-unlocked user chats unlimited and is never counted", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_UNLOCKED))
      .send(chatBody());
    expect(res.status).toBe(200);
    expect(await chatCountFor(USER_UNLOCKED, PARCEL)).toBe(0);
  });

  it("paid user chats unlimited and is never counted", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_PAID))
      .send(chatBody());
    expect(res.status).toBe(200);
    expect(await chatCountFor(USER_PAID, PARCEL)).toBe(0);
  });

  it("summary call on a free tier 402s upgrade_required and never counts", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_FREE))
      .send(chatBody({ purpose: "summary" }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
    expect(await chatCountFor(USER_FREE, PARCEL)).toBe(0);
  });

  it("summary call on an unlocked property succeeds and never counts", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_UNLOCKED))
      .send(chatBody({ purpose: "summary" }));
    expect(res.status).toBe(200);
    expect(await chatCountFor(USER_UNLOCKED, PARCEL)).toBe(0);
  });

  it("free-tier chat with no resolvable parcelNodeId gets an honest 402, never uncounted usage", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set(peSessionHeaders(USER_FREE))
      .send(chatBody({ areaContext: { scope: "area" } }));
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
  });

  it("does not touch the extension_public branch (install-id required as before)", async () => {
    const res = await request(getApp())
      .post("/api/brokerage/v1/research/chat")
      .set({ Authorization: `Bearer ${EXT_KEY}` })
      .send(chatBody());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("install_id_required");
  });
});

describe("free counter atomicity", () => {
  it("concurrent consumption never exceeds the limit", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        consumePeFreeChatMessage(USER_FREE, PARCEL),
      ),
    );
    const allowed = attempts.filter((a) => a.allowed);
    expect(allowed).toHaveLength(PE_FREE_CHAT_MESSAGE_LIMIT);
    expect(await chatCountFor(USER_FREE, PARCEL)).toBe(
      PE_FREE_CHAT_MESSAGE_LIMIT,
    );
  });
});
