/**
 * P-492 3f — affiliate routes.
 *
 * Covers:
 *   - an unauthenticated application lands as `applied` and enqueues
 *     `affiliate_applied` once per partner, against the partner (not a user);
 *   - the per-client rate limit answers 429;
 *   - the operator routes refuse without the service token;
 *   - operator stages move forward only, and `approved` enqueues
 *     `affiliate_approved` once.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";

const SERVICE_TOKEN = "test-service-token-affiliates";
process.env["SERVICE_API_KEY"] = SERVICE_TOKEN;

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("affiliates: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { affiliatePartner, peLifecycleOutbox } = await vi.importActual<
  typeof import("@workspace/db")
>("@workspace/db");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

async function outboxFor(partnerId: string) {
  return ctx.schema!.db
    .select()
    .from(peLifecycleOutbox)
    .where(eq(peLifecycleOutbox.affiliatePartnerId, partnerId));
}

describe("POST /api/property-explorer/v1/affiliates/apply", () => {
  it("records an applied partner and enqueues affiliate.applied once", async () => {
    const body = { email: "Creator@Example.com", firstName: "Casey", channelUrl: "https://youtube.com/@casey" };
    const first = await request(getApp())
      .post("/api/property-explorer/v1/affiliates/apply")
      .set("X-Forwarded-For", "203.0.113.10")
      .send(body);
    expect(first.status).toBe(202);
    const again = await request(getApp())
      .post("/api/property-explorer/v1/affiliates/apply")
      .set("X-Forwarded-For", "203.0.113.10")
      .send(body);
    expect(again.status).toBe(202);

    const partners = await ctx.schema!.db.select().from(affiliatePartner);
    expect(partners).toHaveLength(1);
    expect(partners[0]).toMatchObject({ email: "creator@example.com", firstName: "Casey", stage: "applied" });
    const rows = await outboxFor(partners[0]!.id);
    expect(rows.map((r) => r.eventType)).toEqual(["affiliate_applied"]);
    expect(rows[0]).toMatchObject({ ownerUserId: null, localStatus: "skipped", metaStatus: "skipped" });
  });

  it("refuses an application carrying any other field", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/affiliates/apply")
      .set("X-Forwarded-For", "203.0.113.11")
      .send({ email: "x@example.com", firstName: "X", address: "1 Main St" });
    expect(res.status).toBe(400);
  });

  it("rate-limits a single client", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await request(getApp())
        .post("/api/property-explorer/v1/affiliates/apply")
        .set("X-Forwarded-For", "203.0.113.99")
        .send({ email: `rl${i}@example.com`, firstName: "R" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 202)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe("operator affiliate routes", () => {
  it("refuse without the service token", async () => {
    const res = await request(getApp()).get("/api/property-explorer/v1/internal/affiliates");
    expect(res.status).toBe(401);
  });

  it("identified -> contacted -> approved; approved enqueues affiliate.approved once; never backward", async () => {
    const auth = { Authorization: `Bearer ${SERVICE_TOKEN}` };
    const created = await request(getApp())
      .post("/api/property-explorer/v1/internal/affiliates")
      .set(auth)
      .send({ email: "partner@example.com", firstName: "Pat" });
    expect(created.status).toBe(201);
    const id = created.body.affiliate.id as string;

    const stage = (s: string) =>
      request(getApp())
        .post(`/api/property-explorer/v1/internal/affiliates/${id}/stage`)
        .set(auth)
        .send({ stage: s });

    expect((await stage("contacted")).status).toBe(200);
    const approved = await stage("approved");
    expect(approved.status).toBe(200);
    expect(approved.body.affiliate.stage).toBe("approved");
    expect(approved.body.lifecycleEventId).toBeTruthy();
    expect((await stage("approved")).status).toBe(200);
    const back = await stage("contacted");
    expect(back.status).toBe(409);
    expect(back.body.error).toBe("stage_moves_forward_only");

    const rows = await outboxFor(id);
    expect(rows.map((r) => r.eventType)).toEqual(["affiliate_approved"]);

    const list = await request(getApp()).get("/api/property-explorer/v1/internal/affiliates").set(auth);
    expect(list.status).toBe(200);
    expect(list.body.affiliates).toHaveLength(1);
  });
});
