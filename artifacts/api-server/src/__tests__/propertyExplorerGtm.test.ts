/**
 * Property Explorer GTM + CRM routes (WDLL 25–26).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

const SERVICE_KEY = "service-key-pe-gtm-test-01";
const INSTALL_ID = "pe-install-wave45-test-01";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("propertyExplorerGtm.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { gtmConsent, gtmEvents } = await import("@workspace/db");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

beforeAll(async () => {
  process.env.SERVICE_API_KEY = SERVICE_KEY;
  delete process.env.PIPEDRIVE_API_TOKEN;
  delete process.env.STRIPE_SECRET_KEY;

  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql28 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0028_gtm_observation_layer.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql28);
});

describe("property explorer GTM + billing seam", () => {
  beforeEach(async () => {
    if (!ctx.schema) return;
    await ctx.schema.db.delete(gtmEvents);
    await ctx.schema.db.delete(gtmConsent);
  });

  it("records consent then a research event with simulated Pipedrive", async () => {
    const app = getApp();
    const consent = await request(app)
      .post("/api/brokerage/v1/gtm/property-explorer/consent")
      .set("Authorization", `Bearer ${SERVICE_KEY}`)
      .send({ installId: INSTALL_ID });

    expect(consent.status).toBe(200);
    expect(consent.body.consentVersion).toMatch(/property-explorer/);

    const event = await request(app)
      .post("/api/brokerage/v1/gtm/property-explorer/events")
      .set("Authorization", `Bearer ${SERVICE_KEY}`)
      .send({
        installId: INSTALL_ID,
        eventType: "pe_research_clicked",
        personaInferred: "homeowner",
        payload: { parcelNodeId: "48453:907247" },
      });

    expect(event.status).toBe(201);
    expect(event.body.pipedriveMode).toBe("simulated");
    expect(event.body.pipedriveConfigured).toBe(false);

    const rows = await ctx.schema!.db
      .select()
      .from(gtmEvents)
      .where(eq(gtmEvents.installId, INSTALL_ID));
    expect(rows.some((r) => r.eventType === "pe_research_clicked")).toBe(true);
  });

  it("returns simulated checkout when Stripe is not configured", async () => {
    const app = getApp();
    const res = await request(app)
      .post("/api/brokerage/v1/property-explorer/billing/checkout")
      .set("Authorization", `Bearer ${SERVICE_KEY}`)
      .set("X-Hauska-Install-Id", INSTALL_ID)
      .send({ tier: "pro" });

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("simulated");
    expect(res.body.stripeConfigured).toBe(false);
    expect(res.body.honestNote).toMatch(/simulated/i);
  });

  it("rejects unknown PE event types", async () => {
    const app = getApp();
    await request(app)
      .post("/api/brokerage/v1/gtm/property-explorer/consent")
      .set("Authorization", `Bearer ${SERVICE_KEY}`)
      .send({ installId: INSTALL_ID });

    const event = await request(app)
      .post("/api/brokerage/v1/gtm/property-explorer/events")
      .set("Authorization", `Bearer ${SERVICE_KEY}`)
      .send({
        installId: INSTALL_ID,
        eventType: "not_a_real_event",
      });

    expect(event.status).toBe(400);
    expect(event.body.error).toBe("invalid_event_type");
  });
});
