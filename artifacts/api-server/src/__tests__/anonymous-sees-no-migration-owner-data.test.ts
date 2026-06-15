/**
 * Task #29 follow-up — anonymous sessions must not see legacy backfill data.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, engagements, snapshots } from "@workspace/db";
import { LEGACY_INTERNAL_OWNER_USER_ID } from "../lib/anonymousOwnerCookie";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("anonymous-sees-no-migration-owner-data: ctx.schema not set");
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

describe("anonymous-sees-no-migration-owner-data", () => {
  let legacyEngagementId: string;
  let legacySnapshotId: string;

  beforeEach(async () => {
    const [legacyEng] = await db
      .insert(engagements)
      .values({
        name: "Legacy Production Project",
        nameLower: "legacy production project",
        ownerUserId: LEGACY_INTERNAL_OWNER_USER_ID,
        revitDocumentPath: "P:\\Projects\\Hector Martinez\\613 Sturgeon\\",
      })
      .returning({ id: engagements.id });

    legacyEngagementId = legacyEng!.id;

    const [legacySnap] = await db
      .insert(snapshots)
      .values({
        engagementId: legacyEngagementId,
        projectName: "Legacy Production Project",
        payload: { address: "613 Sturgeon" },
      })
      .returning({ id: snapshots.id });

    legacySnapshotId = legacySnap!.id;

    await db.insert(engagements).values({
      name: "User A Project",
      nameLower: "user a project",
      ownerUserId: "user-a",
    });
  });

  it("unauthenticated production caller sees no legacy-internal engagements", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const res = await agent.get("/api/engagements");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("unauthenticated production caller gets 404 on legacy engagement by id", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const res = await agent.get(`/api/engagements/${legacyEngagementId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("engagement_not_found");
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("unauthenticated production caller gets 404 on legacy engagement submissions", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const res = await agent.get(
        `/api/engagements/${legacyEngagementId}/submissions`,
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("engagement_not_found");
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("unauthenticated production caller sees no legacy snapshots", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const list = await agent.get("/api/snapshots");
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);

      const detail = await agent.get(`/api/snapshots/${legacySnapshotId}`);
      expect(detail.status).toBe(404);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("unauthenticated production caller gets 404 on legacy snapshot sheets", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      const res = await agent.get(
        `/api/snapshots/${legacySnapshotId}/sheets`,
      );
      expect(res.status).toBe(404);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("anonymous production caller can create and read only their own engagement", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());

      const create = await agent
        .post("/api/engagements")
        .send({ name: "New Anonymous Project" });
      expect(create.status).toBe(201);

      const list = await agent.get("/api/engagements");
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].name).toBe("New Anonymous Project");

      const [row] = await db
        .select({ ownerUserId: engagements.ownerUserId })
        .from(engagements)
        .where(eq(engagements.id, create.body.id));
      expect(row?.ownerUserId).toMatch(/^anon_/);
      expect(row?.ownerUserId).not.toBe(LEGACY_INTERNAL_OWNER_USER_ID);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("authenticated user-A still cannot read legacy-internal engagement", async () => {
    const res = await asUser(
      request(getApp()).get(`/api/engagements/${legacyEngagementId}`),
      "user-a",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engagement_not_found");
  });

  it("ephemeral anonymous owner cannot PATCH /api/me/profile (real-auth gate)", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const agent = request.agent(getApp());
      await agent.get("/api/engagements");
      const res = await agent
        .patch("/api/me/profile")
        .send({ displayName: "Should not land" });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/signed-in/i);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });
});
