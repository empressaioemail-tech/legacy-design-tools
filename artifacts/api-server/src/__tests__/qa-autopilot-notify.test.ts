/**
 * Task #484 — Autopilot red-sweep notification webhook.
 *
 * Two surfaces under test:
 *   1. The SSRF guard on PATCH /api/qa/autopilot/settings — public
 *      https URLs are accepted, http/private/loopback/credentialed
 *      URLs are rejected.
 *   2. GET /api/qa/autopilot must NEVER return the persisted webhook
 *      URL itself — only `enabled` + a masked `hint`. The full URL is
 *      a bearer secret (Slack incoming-webhook URLs embed the token in
 *      the path) so leaking it via the read endpoint would be a
 *      credential disclosure.
 *
 * The webhook delivery itself is unit-tested via the end-to-end
 * autopilot orchestrator in qa-autopilot-classifier.test.ts; here we
 * only stand up the route + settings layer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

// Singleton `db` from @workspace/db connects via the bare DATABASE_URL
// with no `search_path`, so without this mock the qa_settings reads/writes
// in the route + settings layer would land in `public` instead of the
// per-file test schema. Mirrors the proxy used by userLookup.test.ts.
vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("qa-autopilot-notify.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  delete process.env["QA_AUTOPILOT_ALLOW_INSECURE_WEBHOOKS"];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/qa/autopilot — notify shape", () => {
  it("never echoes back the persisted webhook URL", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const settings = await import("../lib/qa/settings");
    // Persist a known-secret URL directly through the settings layer
    // so we don't rely on the route's validation path.
    await settings.setSetting(
      "autopilot.notify.webhook",
      "https://hooks.slack.com/services/SECRET-TOKEN-XYZ",
    );
    await settings.setSetting("autopilot.notify.minSeverity", "warning");

    const res = await request(getApp()).get("/api/qa/autopilot");
    expect(res.status).toBe(200);
    expect(res.body.notify).toEqual({
      enabled: true,
      hint: "https://hooks.slack.com/…",
      minSeverity: "warning",
    });
    // Defense in depth: the secret token must not appear anywhere in
    // the response, even via a key we forgot about.
    expect(JSON.stringify(res.body)).not.toContain("SECRET-TOKEN-XYZ");
  });

  it("reports disabled when no webhook is configured", async () => {
    const res = await request(getApp()).get("/api/qa/autopilot");
    expect(res.status).toBe(200);
    expect(res.body.notify).toEqual({
      enabled: false,
      hint: null,
      minSeverity: "error",
    });
  });
});

describe("PATCH /api/qa/autopilot/settings — webhook SSRF guard", () => {
  it("accepts a public https webhook", async () => {
    // Stub DNS to avoid relying on the test container's network.
    const dns = await import("node:dns");
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
    ] as unknown as unknown as Awaited<ReturnType<typeof dns.promises.lookup>>);

    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://hooks.example.com/services/abc",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.notify.enabled).toBe(true);
    expect(res.body.notify.hint).toBe("https://hooks.example.com/…");
  });

  it("rejects http (non-tls) URLs", async () => {
    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "http://hooks.example.com/services/abc",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("scheme_not_allowed");
  });

  it("rejects URLs that resolve to a loopback address", async () => {
    const dns = await import("node:dns");
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "127.0.0.1", family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dns.promises.lookup>>);

    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://attacker-controlled.example.com/x",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("private_address_not_allowed");
  });

  it("rejects URLs that resolve to a private RFC1918 address", async () => {
    const dns = await import("node:dns");
    vi.spyOn(dns.promises, "lookup").mockResolvedValue([
      { address: "10.0.0.5", family: 4 },
    ] as unknown as Awaited<ReturnType<typeof dns.promises.lookup>>);

    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://internal-rebind.example.com/x",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("private_address_not_allowed");
  });

  it("rejects URLs targeting cloud metadata (link-local 169.254.0.0/16)", async () => {
    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://169.254.169.254/latest/meta-data/",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("private_address_not_allowed");
  });

  it("rejects URLs that embed userinfo credentials", async () => {
    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://user:pass@hooks.example.com/x",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("credentials_not_allowed");
  });

  it("rejects literal localhost", async () => {
    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: {
          webhook: "https://localhost/x",
          minSeverity: "error",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("private_address_not_allowed");
  });

  it("accepts an empty webhook string as 'disable'", async () => {
    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({
        notify: { webhook: "", minSeverity: "warning" },
      });
    expect(res.status).toBe(200);
    expect(res.body.notify).toEqual({
      enabled: false,
      hint: null,
      minSeverity: "warning",
    });
  });

  it("supports minSeverity-only updates without changing the webhook", async () => {
    const settings = await import("../lib/qa/settings");
    await settings.setSetting(
      "autopilot.notify.webhook",
      "https://hooks.slack.com/services/STAY-PUT",
    );
    await settings.setSetting("autopilot.notify.minSeverity", "error");

    const res = await request(getApp())
      .patch("/api/qa/autopilot/settings")
      .send({ notify: { minSeverity: "warning" } });
    expect(res.status).toBe(200);
    expect(res.body.notify.enabled).toBe(true);
    expect(res.body.notify.minSeverity).toBe("warning");
    // The persisted webhook is preserved.
    expect(await settings.getSetting("autopilot.notify.webhook")).toBe(
      "https://hooks.slack.com/services/STAY-PUT",
    );
  });
});
