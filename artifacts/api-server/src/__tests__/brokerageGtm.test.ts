/**
 * /api/brokerage/v1/gtm/* — observation layer for Empressa wedge.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";

const TEST_API_KEY = "brokerage-test-key-gtm";
const PUBLIC_API_KEY = "brokerage-test-key-public-store-zzzzzzzz";
const INSTALL_ID = "test-install-00000001";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageGtm.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
};

beforeAll(async () => {
  process.env.BROKERAGE_OPERATOR_API_KEYS = TEST_API_KEY;
  process.env.BROKERAGE_EXTENSION_PUBLIC_KEY = PUBLIC_API_KEY;
  process.env.BROKERAGE_API_KEYS =
    "external-mcp-caller-key-01,external-mcp-caller-key-02";
  resetBrokerageApiKeysForTests();

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql28 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0028_gtm_observation_layer.sql"),
    "utf8",
  );
  const sql31 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0032_gtm_mcp_observation.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql28);
  await ctx.schema.pool.query(sql31);
});

describe("brokerage GTM", () => {
  it("POST /gtm/consent accepts extension_public key via X-Hauska-Key", async () => {
    const app = getApp();
    const res = await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set({ "X-Hauska-Key": PUBLIC_API_KEY })
      .send({
        installId: "install-public-aaaaaaaa",
        consentVersion: "2026-05-26-v1",
        graphOptIn: false,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.installId).toBe("install-public-aaaaaaaa");
  });

  it("POST /gtm/events accepts extension_public key via X-Hauska-Key after consent", async () => {
    const installId = "install-public-events-bbbb";
    const app = getApp();
    await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set({ "X-Hauska-Key": PUBLIC_API_KEY })
      .send({ installId, graphOptIn: false });

    const ev = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set({ "X-Hauska-Key": PUBLIC_API_KEY })
      .send({
        installId,
        eventType: "extension_install",
        payload: { version: "0.4.3" },
      });
    expect(ev.status).toBe(201);
    expect(ev.body.eventId).toBeTruthy();
  });

  it("POST /gtm/consent then GET consent", async () => {
    const app = getApp();
    const post = await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        consentVersion: "2026-05-26-v1",
        graphOptIn: false,
      });
    expect(post.status).toBe(200);
    expect(post.body.graphOptIn).toBe(false);

    const get = await request(app)
      .get(`/api/brokerage/v1/gtm/consent/${INSTALL_ID}`)
      .set(authHeaders);
    expect(get.status).toBe(200);
    expect(get.body.installId).toBe(INSTALL_ID);
  });

  it("POST /gtm/events requires consent", async () => {
    const app = getApp();
    const noConsent = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set(authHeaders)
      .send({
        installId: "no-consent-install-id",
        eventType: "brief_started",
      });
    expect(noConsent.status).toBe(403);

    await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        graphOptIn: true,
      });

    const ev = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        eventType: "extension_install",
        payload: { version: "0.4.3" },
      });
    expect(ev.status).toBe(201);
    expect(ev.body.eventId).toBeTruthy();
  });

  it("GET /gtm/digest returns counts", async () => {
    const app = getApp();
    const res = await request(app)
      .get("/api/brokerage/v1/gtm/digest")
      .set(authHeaders);
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(7);
    expect(Array.isArray(res.body.eventCounts)).toBe(true);
    expect(Array.isArray(res.body.sourceSurfaceCounts)).toBe(true);
    expect(res.body.mcpCallerSplit).toBeTruthy();
    expect(res.body.scoreboardMetrics).toMatchObject({
      external_callers: expect.any(Number),
      mcp_tool_calls: expect.any(Number),
      mcp_error_rate: expect.any(Number),
    });
    expect(res.body.mcp.scoreboard).toEqual(res.body.scoreboardMetrics);
    expect(Array.isArray(res.body.triageSample)).toBe(true);
    expect(res.body.policyTier.tier1Held).toBe(true);
    expect(res.body.investorFunnel).toMatchObject({
      windowDays: 7,
      funnel: expect.any(Array),
      upgrades: expect.objectContaining({
        paywall_hit: expect.any(Number),
        upgrade_started: expect.any(Number),
        subscription_active: expect.any(Number),
        churned: expect.any(Number),
      }),
    });
  });

  it("GET /gtm/digest scoreboard counts external MCP caller", async () => {
    const app = getApp();
    const externalKey = "external-mcp-caller-key-01";
    await request(app)
      .post("/api/brokerage/v1/gtm/mcp-event")
      .set({ Authorization: `Bearer ${externalKey}` })
      .send({
        eventType: "mcp_tool_call",
        sourceSurface: "mcp",
        tool_name: "resolve_place",
        jurisdiction_key: "bastrop_tx",
      });

    const digest = await request(app)
      .get("/api/brokerage/v1/gtm/digest")
      .set(authHeaders);
    expect(digest.body.scoreboardMetrics.mcp_tool_calls).toBeGreaterThanOrEqual(1);
    expect(digest.body.scoreboardMetrics.external_callers).toBeGreaterThanOrEqual(1);
  });

  it("GET /gtm/triage classifies external MCP events", async () => {
    const app = getApp();
    const externalKey = "external-mcp-caller-key-02";
    await request(app)
      .post("/api/brokerage/v1/gtm/mcp-event")
      .set({ Authorization: `Bearer ${externalKey}` })
      .send({
        eventType: "mcp_tool_call",
        sourceSurface: "mcp",
        tool_name: "resolve_place",
        jurisdiction_key: "bastrop_tx",
      });

    const triage = await request(app)
      .get("/api/brokerage/v1/gtm/triage")
      .set(authHeaders);
    expect(triage.status).toBe(200);
    expect(triage.body.externalEventCount).toBeGreaterThanOrEqual(1);
    const hit = triage.body.classifications.find(
      (c: { toolName?: string }) => c.toolName === "resolve_place",
    );
    expect(hit?.triage.dataPackage).toBe("parcel");
    expect(hit?.triage.conversionOpportunity).toBe("high");
  });

  it("POST /gtm/outbound/attempt does not send when OUTBOUND_ENABLED=false", async () => {
    delete process.env.OUTBOUND_ENABLED;
    const app = getApp();
    await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({ installId: INSTALL_ID, graphOptIn: false });

    const res = await request(app)
      .post("/api/brokerage/v1/gtm/outbound/attempt")
      .set(authHeaders)
      .send({ action: "email_send", installId: INSTALL_ID });
    expect(res.status).toBe(403);
    expect(res.body.sent).toBe(false);
    expect(res.body.error).toBe("outbound_blocked");
    expect(res.body.reason).toContain("OUTBOUND_ENABLED=false");
  });

  it("POST /gtm/mcp-event accepts sample MCP payload", async () => {
    const app = getApp();
    const res = await request(app)
      .post("/api/brokerage/v1/gtm/mcp-event")
      .set(authHeaders)
      .send({
        eventType: "mcp_tool_call",
        sourceSurface: "mcp",
        tool_name: "resolve_place",
        jurisdiction_key: "bastrop_tx",
        latency_ms: 42,
      });
    expect(res.status).toBe(201);
    expect(res.body.eventId).toBeTruthy();

    const digest = await request(app)
      .get("/api/brokerage/v1/gtm/digest")
      .set(authHeaders);
    expect(digest.body.mcpTopTools.some(
      (t: { tool_name: string }) => t.tool_name === "resolve_place",
    )).toBe(true);
  });

  it("POST /gtm/events records mcp_docs_clicked with source_surface", async () => {
    const app = getApp();
    await request(app)
      .post("/api/brokerage/v1/gtm/consent")
      .set(authHeaders)
      .send({ installId: INSTALL_ID, graphOptIn: false });

    const ev = await request(app)
      .post("/api/brokerage/v1/gtm/events")
      .set(authHeaders)
      .send({
        installId: INSTALL_ID,
        eventType: "mcp_docs_clicked",
        sourceSurface: "extension",
        payload: { utm_source: "brief-extension" },
      });
    expect(ev.status).toBe(201);
  });
});
