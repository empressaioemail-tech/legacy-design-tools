/**
 * Arrow two Phase 2 — outcome-observation capture.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema)
        throw new Error("finding-outcome.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { engagements, submissions, findings, atomEvents } = await import(
  "@workspace/db"
);
const { eq, and } = await import("drizzle-orm");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);
const { FINDING_OUTCOME_RECORDED_EVENT_TYPE } = await import(
  "../atoms/finding.atom"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const REVIEWER_HEADERS = {
  "x-audience": "internal",
  "x-requestor": "user:reviewer-test",
};

const SERVICE_TOKEN = "finding-outcome-service-token";

beforeEach(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

async function seedFindingWithTenant(tenantKey: string) {
  if (!ctx.schema) throw new Error("schema not ready");
  const [eng] = await ctx.schema.db
    .insert(engagements)
    .values({
      name: `Outcome ${tenantKey}`,
      nameLower: `outcome ${tenantKey}`,
      jurisdiction: "Bastrop, TX",
      cortexJurisdictionKey: tenantKey,
      status: "active",
    })
    .returning();
  const [sub] = await ctx.schema.db
    .insert(submissions)
    .values({
      engagementId: eng.id,
      jurisdiction: "Bastrop, TX",
    })
    .returning();
  const atomId = `finding:outcome:${tenantKey}:001`;
  await ctx.schema.db.insert(findings).values({
    atomId,
    submissionId: sub.id,
    severity: "concern",
    category: "setback",
    status: "accepted",
    text: "Outcome test finding.",
    citations: [
      { kind: "code-section", atomId: "code:outcome-test" },
    ] as unknown as Record<string, unknown>[],
    confidence: "0.70",
    aiGeneratedAt: new Date("2026-01-01T00:00:00Z"),
  });
  return { atomId, tenantKey };
}

describe("POST /api/findings/:findingId/outcome", () => {
  it("403s without internal audience or service token", async () => {
    const res = await request(getApp())
      .post("/api/findings/finding:missing/outcome")
      .send({ outcomeKind: "permit-approved" })
      .set({ "x-audience": "user", "x-requestor": "user:architect" });
    expect(res.status).toBe(403);
  });

  it("records append-only outcome partitioned by jurisdictionTenant", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { atomId, tenantKey } = await seedFindingWithTenant("bastrop_tx");

    const res = await request(getApp())
      .post(`/api/findings/${atomId}/outcome`)
      .set(REVIEWER_HEADERS)
      .send({
        outcomeKind: "permit-approved",
        notes: "Permit issued — finding was accurate.",
      });
    expect(res.status).toBe(201);
    expect(res.body.jurisdictionTenant).toBe("bastrop_tx");
    expect(res.body.outcomeKind).toBe("permit-approved");
    expect(res.body.eventId).toBeTruthy();

    const events = await ctx.schema.db
      .select()
      .from(atomEvents)
      .where(
        and(
          eq(atomEvents.entityType, "finding"),
          eq(atomEvents.entityId, atomId),
          eq(atomEvents.eventType, FINDING_OUTCOME_RECORDED_EVENT_TYPE),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      outcomeKind: "permit-approved",
      jurisdictionTenant: "bastrop_tx",
      findingAtomId: atomId,
    });

    const list = await request(getApp())
      .get(
        `/api/findings/outcome-observations?jurisdictionTenant=${tenantKey}&findingAtomId=${atomId}`,
      )
      .set(REVIEWER_HEADERS);
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].outcomeKind).toBe("permit-approved");
  });

  it("denies service caller when jurisdiction tenant mismatches the finding", async () => {
    if (!ctx.schema) throw new Error("ctx");
    const { atomId } = await seedFindingWithTenant("bastrop_tx");

    const res = await request(getApp())
      .post(`/api/findings/${atomId}/outcome`)
      .set({
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "x-hauska-jurisdiction-tenant": "elgin_tx",
      })
      .send({ outcomeKind: "comment-resolved" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tenant_scope_denied");
  });
});
