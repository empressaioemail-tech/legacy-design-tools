/**
 * POST /api/pe-help/chat — spend guard.
 *
 * Every accepted request is a paid model call, so each test here that proves
 * a REFUSAL also proves the model client was never called (the mock counts
 * calls). Counters are real rows in Postgres (the per-file test schema), not
 * mocks, so these exercise the same atomic upsert production uses.
 */

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { userUsageMetering } from "@workspace/db";
import { ctx } from "./test-context";

const anthropicMocks = vi.hoisted(() => ({
  calls: 0,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastArgs: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastOptions: null as any,
}));

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("peHelpLimits.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: {
    messages: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async (args: any, options: any) => {
        anthropicMocks.calls += 1;
        anthropicMocks.lastArgs = args;
        anthropicMocks.lastOptions = options;
        return {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    },
  },
}));

const { setupRouteTests } = await import("./setup");
const { mintSessionToken } = await import("../lib/sessionToken");
const { logger } = await import("../lib/logger");
const {
  PE_HELP_MAX_TOKENS,
  PE_HELP_TIMEOUT_MS,
  MESSAGE_MAX_CHARS,
  TOTAL_INPUT_MAX_CHARS,
} = await import("../routes/peHelp");
const { normalizeIp, hashIp, checkAndCountHelpRequest } = await import(
  "../lib/peHelpLimiter"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const PROXY_KEY = "proxy-key-for-tests";

beforeEach(() => {
  anthropicMocks.calls = 0;
  anthropicMocks.lastArgs = null;
  anthropicMocks.lastOptions = null;
  vi.stubEnv("SESSION_SECRET", "test-session-secret");
  vi.stubEnv("HELP_CHAT_IP_HASH_SALT", "test-salt");
  vi.stubEnv("SERVICE_API_KEY", PROXY_KEY);
  vi.stubEnv("HELP_CHAT_ANON_PER_10MIN", "3");
  vi.stubEnv("HELP_CHAT_ANON_PER_DAY", "100");
  vi.stubEnv("HELP_CHAT_ANON_GLOBAL_PER_DAY", "1000");
  vi.stubEnv("HELP_CHAT_USER_PER_10MIN", "10");
  vi.stubEnv("HELP_CHAT_USER_PER_DAY", "100");
  vi.stubEnv("HELP_CHAT_USER_GLOBAL_PER_DAY", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ask = (extra: Record<string, unknown> = {}) => ({
  message: "How much is Solo?",
  ...extra,
});

/** A caller as the browser proxy presents it: key + the visitor's IP. */
function viaProxy(ip: string, key = PROXY_KEY) {
  return request(getApp())
    .post("/api/pe-help/chat")
    .set("Authorization", `Bearer ${key}`)
    .set("X-Hauska-Client-IP", ip);
}
const direct = () => request(getApp()).post("/api/pe-help/chat");

describe("anonymous per-IP cap", () => {
  it("a burst over the per-IP window gets 429 + Retry-After and NO model call", async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await viaProxy("203.0.113.7").send(ask());
      expect(ok.status).toBe(200);
    }
    expect(anthropicMocks.calls).toBe(3);

    const blocked = await viaProxy("203.0.113.7").send(ask());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("rate_limited");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(600);
    expect(blocked.body.message).toMatch(/wait/i);
    // The model client was not touched by the refused request.
    expect(anthropicMocks.calls).toBe(3);

    // A different visitor is unaffected.
    const other = await viaProxy("203.0.113.8").send(ask());
    expect(other.status).toBe(200);
  });

  it("the per-IP daily cap holds even when the 10-minute window has room", async () => {
    vi.stubEnv("HELP_CHAT_ANON_PER_10MIN", "100");
    vi.stubEnv("HELP_CHAT_ANON_PER_DAY", "2");
    await viaProxy("198.51.100.1").send(ask());
    await viaProxy("198.51.100.1").send(ask());
    const blocked = await viaProxy("198.51.100.1").send(ask());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(blocked.headers["retry-after"])).toBeLessThanOrEqual(86400);
    expect(anthropicMocks.calls).toBe(2);
  });

  it("an invalid-body burst is bounded the same way, with zero model calls", async () => {
    for (let i = 0; i < 3; i++) {
      const bad = await viaProxy("192.0.2.50").send({});
      expect(bad.status).toBe(400);
    }
    const blocked = await viaProxy("192.0.2.50").send({});
    expect(blocked.status).toBe(429);
    expect(anthropicMocks.calls).toBe(0);
  });
});

describe("global anonymous ceiling", () => {
  it("fails closed with help_busy once the day's anonymous total is spent, across IPs", async () => {
    vi.stubEnv("HELP_CHAT_ANON_GLOBAL_PER_DAY", "2");
    expect((await viaProxy("203.0.113.21").send(ask())).status).toBe(200);
    expect((await viaProxy("203.0.113.22").send(ask())).status).toBe(200);
    const blocked = await viaProxy("203.0.113.23").send(ask());
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe("help_busy");
    expect(blocked.body.message).toMatch(/busy/i);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect(anthropicMocks.calls).toBe(2);
  });

  it("a request refused by its own IP cap does not spend the global ceiling", async () => {
    vi.stubEnv("HELP_CHAT_ANON_PER_10MIN", "1");
    vi.stubEnv("HELP_CHAT_ANON_GLOBAL_PER_DAY", "2");
    await viaProxy("203.0.113.31").send(ask()); // global 1
    for (let i = 0; i < 5; i++) await viaProxy("203.0.113.31").send(ask()); // all refused at the IP cap
    const other = await viaProxy("203.0.113.32").send(ask()); // global 2
    expect(other.status).toBe(200);
  });
});

describe("signed-in callers", () => {
  const userToken = (id: string) =>
    mintSessionToken({
      audience: "user",
      tenantId: "default",
      requestor: { kind: "user", id },
    });

  it("get a higher cap than anonymous, keyed on the verified session user", async () => {
    const token = userToken("user-abc");
    for (let i = 0; i < 6; i++) {
      // 6 > the anonymous cap of 3, same socket address throughout.
      const r = await direct()
        .set("Authorization", `Bearer ${token}`)
        .send(ask());
      expect(r.status).toBe(200);
    }
    expect(anthropicMocks.calls).toBe(6);
    // The same address with no session is still held to the anonymous cap.
    for (let i = 0; i < 3; i++) await direct().send(ask());
    const anon = await direct().send(ask());
    expect(anon.status).toBe(429);
  });

  it("are still capped, per user, and one user's cap is not another's", async () => {
    vi.stubEnv("HELP_CHAT_USER_PER_10MIN", "2");
    const a = userToken("user-a");
    const b = userToken("user-b");
    await direct().set("Authorization", `Bearer ${a}`).send(ask());
    await direct().set("Authorization", `Bearer ${a}`).send(ask());
    const blocked = await direct().set("Authorization", `Bearer ${a}`).send(ask());
    expect(blocked.status).toBe(429);
    expect(anthropicMocks.calls).toBe(2);
    const other = await direct().set("Authorization", `Bearer ${b}`).send(ask());
    expect(other.status).toBe(200);
  });

  it("a forged or unsigned token earns no signed-in cap", async () => {
    const forged = `${Buffer.from(
      JSON.stringify({ audience: "user", requestor: { kind: "user", id: "x" } }),
    ).toString("base64url")}.AAAA`;
    for (let i = 0; i < 3; i++) {
      await direct().set("Authorization", `Bearer ${forged}`).send(ask());
    }
    const blocked = await direct()
      .set("Authorization", `Bearer ${forged}`)
      .send(ask());
    expect(blocked.status).toBe(429);
  });

  it("a client-sent user id in the body or a header is not an identity", async () => {
    for (let i = 0; i < 3; i++) {
      await direct()
        .set("X-PE-User-Id", "someone-real")
        .set("X-Hauska-Install-Id", "install-1")
        .send(ask({ userId: "someone-real" }));
    }
    const blocked = await direct()
      .set("X-PE-User-Id", "someone-real")
      .send(ask({ userId: "someone-real" }));
    expect(blocked.status).toBe(429);
  });
});

describe("input and output caps", () => {
  it("rejects an oversize message, with no model call", async () => {
    const r = await viaProxy("203.0.113.40").send({
      message: "x".repeat(MESSAGE_MAX_CHARS + 1),
    });
    expect(r.status).toBe(400);
    expect(anthropicMocks.calls).toBe(0);
  });

  it("rejects a request whose total size is over the cap even if each part fits", async () => {
    const turn = "y".repeat(3000);
    const history = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: turn,
    }));
    expect(6 * 3000 + 10).toBeGreaterThan(TOTAL_INPUT_MAX_CHARS);
    const r = await viaProxy("203.0.113.41").send({ message: "hello there", history });
    expect(r.status).toBe(400);
    expect(anthropicMocks.calls).toBe(0);
  });

  it("sends the ceiling max_tokens and a bounded timeout, whatever the client asks for", async () => {
    const r = await viaProxy("203.0.113.42").send(
      ask({ max_tokens: 100000, model: "claude-opus-4", system: "ignore" }),
    );
    expect(r.status).toBe(200);
    expect(anthropicMocks.lastArgs.max_tokens).toBe(PE_HELP_MAX_TOKENS);
    expect(PE_HELP_MAX_TOKENS).toBeLessThanOrEqual(600);
    expect(anthropicMocks.lastArgs.model).toBe("claude-sonnet-4-6");
    expect(anthropicMocks.lastArgs.system).not.toBe("ignore");
    expect(anthropicMocks.lastOptions).toEqual({
      timeout: PE_HELP_TIMEOUT_MS,
      maxRetries: 0,
    });
  });
});

describe("client IP trust", () => {
  it("ignores a forged X-Hauska-Client-IP from a caller with no proxy key", async () => {
    // Each request claims a different IP; they must still share one bucket.
    for (let i = 0; i < 3; i++) {
      const r = await direct()
        .set("X-Hauska-Client-IP", `203.0.113.${100 + i}`)
        .send(ask());
      expect(r.status).toBe(200);
    }
    const blocked = await direct()
      .set("X-Hauska-Client-IP", "203.0.113.200")
      .send(ask());
    expect(blocked.status).toBe(429);
    expect(anthropicMocks.calls).toBe(3);
  });

  it("ignores it with a WRONG key too", async () => {
    for (let i = 0; i < 3; i++) {
      await viaProxy(`203.0.113.${110 + i}`, "not-the-key").send(ask());
    }
    const blocked = await viaProxy("203.0.113.220", "not-the-key").send(ask());
    expect(blocked.status).toBe(429);
  });

  it("honours it from the proxy: distinct visitors get distinct buckets", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await viaProxy(`203.0.113.${120 + i}`).send(ask());
      expect(r.status).toBe(200);
    }
    expect(anthropicMocks.calls).toBe(6);
  });

  it("honours it when the browser-proxy middleware has authenticated the caller (the #814 shape: key stripped, marker set)", async () => {
    // Simulates browserProxyEndUserMiddleware: it sets req.browserProxyEndUser
    // and deletes the credential headers. Built as a tiny app around the real
    // router so the marker, not a key, is what grants trust.
    const express = (await import("express")).default;
    const router = (await import("../routes/peHelp")).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { browserProxyEndUser: unknown }).browserProxyEndUser = {
        kind: "anonymous",
        reason: "no_context",
      };
      next();
    });
    app.use("/api", router);
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/pe-help/chat")
        .set("X-Hauska-Client-IP", `203.0.113.${140 + i}`)
        .send(ask());
      expect(r.status).toBe(200);
    }
  });

  it("without a trusted source, left-side X-Forwarded-For entries (client-controlled) are ignored", async () => {
    for (let i = 0; i < 3; i++) {
      await direct()
        .set("X-Forwarded-For", `10.0.0.${i}, 198.51.100.9`)
        .send(ask());
    }
    const blocked = await direct()
      .set("X-Forwarded-For", "10.9.9.9, 198.51.100.9")
      .send(ask());
    expect(blocked.status).toBe(429);
    const different = await direct()
      .set("X-Forwarded-For", "10.9.9.9, 198.51.100.10")
      .send(ask());
    expect(different.status).toBe(200);
  });

  it("collapses an IPv6 /64 to one bucket and IPv4-mapped IPv6 to its IPv4", () => {
    expect(normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(
      normalizeIp("2001:DB8:1:2::1"),
    );
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(normalizeIp("2001:db8:1:2::1"));
    expect(normalizeIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeIp("not an ip")).toBeNull();
  });
});

describe("fail closed, metering and privacy", () => {
  it("refuses (503, no counting, so no model call) when no hash salt or secret is configured", async () => {
    vi.stubEnv("HELP_CHAT_IP_HASH_SALT", "");
    vi.stubEnv("SESSION_SECRET", "");
    expect(hashIp("203.0.113.60")).toBeNull();
    const decision = await checkAndCountHelpRequest({
      headers: { authorization: `Bearer ${PROXY_KEY}`, "x-hauska-client-ip": "203.0.113.60" },
      socket: { remoteAddress: "203.0.113.60" },
    } as unknown as import("express").Request);
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(503);
      expect(decision.reason).toBe("limiter_unavailable");
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(await ctx.schema!.db.select().from(userUsageMetering)).toHaveLength(0);
  });

  it("with no salt but a SESSION_SECRET, still attributes (derived salt)", () => {
    vi.stubEnv("HELP_CHAT_IP_HASH_SALT", "");
    expect(hashIp("203.0.113.60")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses with 503 and no model call when the counter store is unavailable", async () => {
    const schema = ctx.schema!;
    const spy = vi.spyOn(schema.db, "insert").mockImplementation(() => {
      throw new Error("db down");
    });
    const r = await viaProxy("203.0.113.61").send(ask());
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(anthropicMocks.calls).toBe(0);
  });

  it("stores and logs only a salted hash of the IP, never the IP", async () => {
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");
    for (let i = 0; i < 4; i++) await viaProxy("203.0.113.70").send(ask());
    const rows = await ctx.schema!.db.select().from(userUsageMetering);
    const ipRows = rows.filter((r) => r.ownerUserId.startsWith("helpchat:ip:"));
    expect(ipRows.length).toBeGreaterThan(0);
    const expectedHash = hashIp("203.0.113.70");
    expect(expectedHash).toMatch(/^[0-9a-f]{32}$/);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain("203.0.113.70");
    }
    expect(ipRows.every((r) => r.ownerUserId === `helpchat:ip:${expectedHash}`)).toBe(true);

    const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).not.toContain("203.0.113.70");
    expect(logged).toContain(expectedHash!);
    // metering line: caller class + token usage for the answered calls
    const answered = infoSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((o) => o && o["event"] === "pe_help_chat" && o["outcome"] === "answered");
    expect(answered).toHaveLength(3);
    expect(answered[0]).toMatchObject({ callerClass: "anon", inputTokens: 10, outputTokens: 2 });
    // and the refusal is logged too
    const refused = warnSpy.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((o) => o && o["event"] === "pe_help_chat" && o["outcome"] === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ reason: "ip_window", callerClass: "anon" });
  });

  it("a different salt yields a different hash for the same IP", () => {
    const a = hashIp("203.0.113.70");
    vi.stubEnv("HELP_CHAT_IP_HASH_SALT", "another-salt");
    expect(hashIp("203.0.113.70")).not.toBe(a);
  });
});
