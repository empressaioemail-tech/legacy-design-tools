/**
 * Plan-review BFF — reviewer tool reads are unscoped by engagement owner.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, engagements, submissions } from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("planReviewBff.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("plan-review BFF reviewer reads", () => {
  beforeEach(async () => {
    await db.insert(engagements).values({
      name: "146 S Fredricksburg",
      nameLower: "146 s fredricksburg",
      ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
      jurisdiction: "bastrop-tx",
      address: "146 S Fredricksburg, Bastrop TX",
    });
  });

  it("GET /plan-review/engagements/:id returns engagement without session ownership", async () => {
    const [row] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.nameLower, "146 s fredricksburg"));

    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${row!.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row!.id);
    expect(res.body.name).toBe("146 S Fredricksburg");
    expect(res.body.jurisdiction).toBe("bastrop-tx");
  });

  it("GET /plan-review/engagements/:id returns 404 when id missing", async () => {
    const res = await request(getApp()).get(
      "/api/plan-review/engagements/00000000-0000-0000-0000-000000000000",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("GET /plan-review/engagements/:id/submissions lists submissions without session ownership", async () => {
    const [engagement] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.nameLower, "146 s fredricksburg"));

    await db.insert(submissions).values({
      engagementId: engagement!.id,
      jurisdiction: "bastrop-tx",
      note: "Permit set v1",
      status: "submitted",
    });

    const res = await request(getApp()).get(
      `/api/plan-review/engagements/${engagement!.id}/submissions`,
    );

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].note).toBe("Permit set v1");
    expect(res.body[0].findingGenerationState).toBe("idle");
  });

  it("GET /plan-review/engagements/:id/submissions returns 404 when engagement missing", async () => {
    const res = await request(getApp()).get(
      "/api/plan-review/engagements/00000000-0000-0000-0000-000000000000/submissions",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });
});
