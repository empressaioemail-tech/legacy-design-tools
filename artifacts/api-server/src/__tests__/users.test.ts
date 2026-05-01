/**
 * /api/users — admin CRUD over the `users` profile table.
 *
 * Exercises the full create / list / get / update / delete cycle plus
 * the session-middleware backfill: when a request arrives carrying a
 * user requestor (via the dev `x-requestor` override or the
 * `pr_session` cookie path), the middleware should upsert a default
 * profile row so the timeline never has to render "Unknown user" for
 * a freshly-seen id.
 *
 * The mock-`db` proxy wires every drizzle call in the route + the
 * `ensureUserProfile` helper to the per-file test schema; without the
 * proxy both would hit the production singleton pool.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("users.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { users } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("GET /api/users", () => {
  it("returns an empty array when no profiles exist", async () => {
    const res = await request(getApp()).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns rows ordered by displayName", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      { id: "u-z", displayName: "Zara" },
      { id: "u-a", displayName: "Alex" },
      { id: "u-m", displayName: "Mira" },
    ]);

    const res = await request(getApp()).get("/api/users");
    expect(res.status).toBe(200);
    expect(res.body.map((u: { displayName: string }) => u.displayName)).toEqual([
      "Alex",
      "Mira",
      "Zara",
    ]);
    // Spot-check shape so the OpenAPI contract is enforced at the
    // edge — `email`/`avatarUrl` are nullable strings, the timestamp
    // fields are ISO strings.
    expect(res.body[0]).toEqual({
      id: "u-a",
      displayName: "Alex",
      email: null,
      avatarUrl: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
  });
});

describe("POST /api/users", () => {
  it("creates a new profile and returns 201", async () => {
    const res = await request(getApp())
      .post("/api/users")
      .send({ id: "u-new", displayName: "Newcomer" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("u-new");
    expect(res.body.displayName).toBe("Newcomer");
    expect(res.body.email).toBeNull();
    expect(res.body.avatarUrl).toBeNull();

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-new"));
    expect(rows).toHaveLength(1);
  });

  it("accepts optional email and avatarUrl", async () => {
    const res = await request(getApp()).post("/api/users").send({
      id: "u-full",
      displayName: "Full Profile",
      email: "full@example.com",
      avatarUrl: "https://example.com/full.png",
    });
    expect(res.status).toBe(201);
    expect(res.body.email).toBe("full@example.com");
    expect(res.body.avatarUrl).toBe("https://example.com/full.png");
  });

  it("rejects bodies missing required fields with 400", async () => {
    const r1 = await request(getApp())
      .post("/api/users")
      .send({ displayName: "No Id" });
    expect(r1.status).toBe(400);

    const r2 = await request(getApp())
      .post("/api/users")
      .send({ id: "u-no-name" });
    expect(r2.status).toBe(400);

    const r3 = await request(getApp())
      .post("/api/users")
      .send({ id: "u-empty", displayName: "" });
    expect(r3.status).toBe(400);
  });

  it("returns 409 when the id already exists", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-dup", displayName: "Original" });

    const res = await request(getApp())
      .post("/api/users")
      .send({ id: "u-dup", displayName: "Duplicate" });
    expect(res.status).toBe(409);
    // Original row is untouched.
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-dup"));
    expect(rows[0]?.displayName).toBe("Original");
  });
});

describe("GET /api/users/:id", () => {
  it("returns the matching profile", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-get", displayName: "Findme" });

    const res = await request(getApp()).get("/api/users/u-get");
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Findme");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(getApp()).get("/api/users/u-missing");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("User not found");
  });
});

describe("PATCH /api/users/:id", () => {
  it("updates the display name and bumps updatedAt", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const [seeded] = await ctx.schema.db
      .insert(users)
      .values({ id: "u-edit", displayName: "Old Name" })
      .returning();
    if (!seeded) throw new Error("seed failed");
    // Slight delay so the updatedAt comparison is meaningful — the
    // route bumps `updatedAt` to `new Date()` on every patch.
    await new Promise((r) => setTimeout(r, 10));

    const res = await request(getApp())
      .patch("/api/users/u-edit")
      .send({ displayName: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("New Name");
    expect(new Date(res.body.updatedAt).getTime()).toBeGreaterThan(
      seeded.updatedAt.getTime(),
    );
  });

  it("clears email when null is sent and preserves avatar when absent", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-clear",
      displayName: "Clear Test",
      email: "old@example.com",
      avatarUrl: "https://example.com/keep.png",
    });

    const res = await request(getApp())
      .patch("/api/users/u-clear")
      .send({ email: null });
    expect(res.status).toBe(200);
    expect(res.body.email).toBeNull();
    // avatarUrl was not in the patch body, so the row should still
    // carry the original value — proves "absent != null" in the route.
    expect(res.body.avatarUrl).toBe("https://example.com/keep.png");
  });

  it("rejects an empty patch with 400", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-noop", displayName: "Noop" });
    const res = await request(getApp()).patch("/api/users/u-noop").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Empty update");
  });

  it("rejects null displayName with 400 (zod schema enforces non-null)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-null-name", displayName: "Original" });
    const res = await request(getApp())
      .patch("/api/users/u-null-name")
      .send({ displayName: null });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id does not exist", async () => {
    const res = await request(getApp())
      .patch("/api/users/u-ghost")
      .send({ displayName: "Ghost" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/users/:id", () => {
  it("deletes the profile and returns 204", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-del", displayName: "Delete Me" });

    const res = await request(getApp()).delete("/api/users/u-del");
    expect(res.status).toBe(204);

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-del"));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the id does not exist", async () => {
    const res = await request(getApp()).delete("/api/users/u-ghost");
    expect(res.status).toBe(404);
  });
});

describe("session middleware — auto-upsert profile", () => {
  it("backfills a default profile the first time a user requestor is seen", async () => {
    // Hit any cheap endpoint with the dev `x-requestor` header that
    // the test session middleware honors. The backfill is fire-and-
    // forget, so we wait a tick before asserting the row landed.
    const res = await request(getApp())
      .get("/api/healthz")
      .set("x-requestor", "user:u-fresh");
    expect(res.status).toBe(200);

    // Give the void-promise a microtask to flush. The route returns
    // synchronously so the insert runs in parallel; a single setTimeout
    // is more than enough for an in-process drizzle call.
    await new Promise((r) => setTimeout(r, 50));

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-fresh"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("u-fresh");
  });

  it("does not overwrite an existing profile's displayName", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-existing",
      displayName: "Curated Name",
      email: "curated@example.com",
    });

    const res = await request(getApp())
      .get("/api/healthz")
      .set("x-requestor", "user:u-existing");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-existing"));
    expect(rows[0]?.displayName).toBe("Curated Name");
    expect(rows[0]?.email).toBe("curated@example.com");
  });

  it("does not insert a profile for agent-kind requestors", async () => {
    const res = await request(getApp())
      .get("/api/healthz")
      .set("x-requestor", "agent:snapshot-ingest");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "snapshot-ingest"));
    expect(rows).toHaveLength(0);
  });
});
