/**
 * Task #29 — cross-user engagement isolation (mirrors gate tenant-isolation rigor).
 * Anonymous sessions scope to per-browser ephemeral owners only.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, engagements } from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

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

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

describe("engagement ownership isolation", () => {
  beforeEach(async () => {
    await db.insert(engagements).values([
      {
        name: "Legacy Internal Project",
        nameLower: "legacy internal project",
        ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
      },
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
    const res = await asUser(request(getApp()).get("/api/engagements"), "user-a");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("User A Project");
  });

  it("user-B cannot read user-A engagement by id", async () => {
    const [rowA] = await db
      .select({ id: engagements.id })
      .from(engagements)
      .where(eq(engagements.ownerUserId, "user-a"));

    const res = await asUser(
      request(getApp()).get(`/api/engagements/${rowA!.id}`),
      "user-b",
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("anonymous caller sees no legacy-internal engagements in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const res = await request(getApp()).get("/api/engagements");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("anonymous caller cannot read user-owned engagement by id in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const [rowA] = await db
        .select({ id: engagements.id })
        .from(engagements)
        .where(eq(engagements.ownerUserId, "user-a"));

      const res = await request(getApp()).get(`/api/engagements/${rowA!.id}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("engagement_not_found");
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("anonymous caller can create engagements owned by their ephemeral id in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const res = await agent
        .post("/api/engagements")
        .send({ name: "New Anonymous Project" });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe("New Anonymous Project");

      const [row] = await db
        .select({ ownerUserId: engagements.ownerUserId })
        .from(engagements)
        .where(eq(engagements.id, res.body.id));
      expect(row?.ownerUserId).toMatch(/^anon_/);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });
});
