/**
 * WDLL item 15 — tenant-scoped saved-property isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import { db, peSavedProperties, users } from "@workspace/db";
import { mintSessionToken } from "../lib/sessionToken";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-saved-property-isolation: ctx.schema not set");
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

function bearerToken(userId: string): string {
  return mintSessionToken({
    audience: "user",
    tenantId: DEFAULT_TENANT_ID,
    requestor: { kind: "user", id: userId },
  });
}

describe("PE saved property isolation", () => {
  beforeEach(async () => {
    // OPS-16 P-111: pe_saved_properties.owner_user_id now FKs to users.id
    // (previously ungated -- exactly the gap OPS-16 A-075 found), so the
    // fixture rows below need real parent rows first.
    await db.insert(users).values([
      { id: "user-a", displayName: "user-a" },
      { id: "user-b", displayName: "user-b" },
    ]);
    await db.insert(peSavedProperties).values([
      {
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: "user-a",
        parcelNodeId: "48055:10068",
        label: "User A parcel",
        snapshot: { source: "test" },
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: "user-b",
        parcelNodeId: "48491:R062578",
        label: "User B parcel",
        snapshot: { source: "test" },
      },
    ]);
  });

  it("GET saved-properties composes punctuation situs to node id + unknown", async () => {
    await db.insert(peSavedProperties).values({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: "user-a",
      parcelNodeId: "48021:25420",
      label: ", ,",
      snapshot: { source: "test" },
    });
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/saved-properties"),
      "user-a",
    );
    expect(res.status).toBe(200);
    const junk = res.body.find(
      (row: { parcelNodeId: string }) => row.parcelNodeId === "48021:25420",
    );
    expect(junk).toMatchObject({
      parcelNodeId: "48021:25420",
      label: "48021:25420",
      situs: "unknown",
    });
    expect(junk.label).not.toMatch(/^[\s,.\-;:'"`]+$/);
  });

  it("GET saved-properties returns only caller's rows", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/saved-properties"),
      "user-a",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].parcelNodeId).toBe("48055:10068");
  });

  it("user-B cannot delete user-A saved property", async () => {
    const res = await asUser(
      request(getApp()).delete(
        "/api/property-explorer/v1/saved-properties/48055:10068",
      ),
      "user-b",
    );
    expect(res.status).toBe(404);
    const [row] = await db
      .select({ id: peSavedProperties.id })
      .from(peSavedProperties)
      .where(eq(peSavedProperties.parcelNodeId, "48055:10068"));
    expect(row).toBeDefined();
  });

  it("anonymous cannot list saved properties in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const res = await request(getApp()).get(
        "/api/property-explorer/v1/saved-properties",
      );
      expect(res.status).toBe(401);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("signed bearer session can list own saved properties in production", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const res = await request(getApp())
        .get("/api/property-explorer/v1/saved-properties")
        .set("Authorization", `Bearer ${bearerToken("user-a")}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    } finally {
      process.env["NODE_ENV"] = prev;
    }
  });

  it("SERVICE_API_KEY + X-PE-User-Id lists that user's saved properties", async () => {
    const prevEnv = process.env["NODE_ENV"];
    const prevKey = process.env.SERVICE_API_KEY;
    process.env["NODE_ENV"] = "production";
    process.env.SERVICE_API_KEY = "mcp-service-key-test";
    const { __resetServiceApiKeyCacheForTests } = await import(
      "../lib/serviceToken"
    );
    __resetServiceApiKeyCacheForTests();
    try {
      const res = await request(getApp())
        .get("/api/property-explorer/v1/saved-properties")
        .set("Authorization", "Bearer mcp-service-key-test")
        .set("X-PE-User-Id", "user-a");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].parcelNodeId).toBe("48055:10068");
    } finally {
      process.env["NODE_ENV"] = prevEnv;
      if (prevKey === undefined) delete process.env.SERVICE_API_KEY;
      else process.env.SERVICE_API_KEY = prevKey;
      __resetServiceApiKeyCacheForTests();
    }
  });
});
