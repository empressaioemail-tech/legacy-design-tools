/**
 * Task #29 — cross-user engagement isolation (mirrors gate tenant-isolation rigor).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, engagements } from "@workspace/db";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("engagement-ownership-isolation: ctx.schema not set");
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

function userToken(userId: string): string {
  return mintSessionToken({
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: userId },
  });
}

describe("engagement ownership isolation", () => {
  beforeEach(async () => {
    await db.insert(engagements).values([
      {
        name: "User A Project",
        nameLower: "user a project",
        ownerUserId: "user-a",
      },
      {
        name: "User B Project",
        nameLower: "user b project",
        ownerUserId: "user-b",
      },
    ]);
  });

  it("GET /engagements returns only the caller's engagements", async () => {
    const res = await request(getApp())
      .get("/api/engagements")
      .set("Authorization", `Bearer ${userToken("user-a")}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("User A Project");
  });

  it("user-B cannot read user-A engagement by id", async () => {
    const [rowA] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.ownerUserId, "user-a"));

    const res = await request(getApp())
      .get(`/api/engagements/${rowA!.id}`)
      .set("Authorization", `Bearer ${userToken("user-b")}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("anonymous caller receives 401 on GET /engagements in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const res = await request(getApp()).get("/api/engagements");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("authentication_required");
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });
});
