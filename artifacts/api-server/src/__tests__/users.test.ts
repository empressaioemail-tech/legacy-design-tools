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
 * The write endpoints (POST/PATCH/DELETE) are gated on the
 * `users:manage` permission claim; happy-path tests opt in via the
 * dev `x-permissions` header (mirroring how the chat tests opt into a
 * specific audience). A separate suite below exercises the forbidden
 * path with no permission claim attached.
 *
 * The mock-`db` proxy wires every drizzle call in the route + the
 * `ensureUserProfile` helper to the per-file test schema; without the
 * proxy both would hit the production singleton pool.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

/**
 * Standing-in for an authenticated admin: the dev session middleware
 * honours `x-permissions` outside production, so attaching this header
 * is enough to satisfy the `requireUsersManage` gate without minting a
 * real cookie.
 */
const ADMIN_HEADERS = { "x-permissions": "users:manage" } as const;

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

/**
 * Mock the object-storage service so the route's avatar-cleanup branch
 * doesn't actually try to reach the Replit object-storage sidecar (which
 * isn't running in the unit-test container). The mock exposes a real
 * `vi.fn` on every instance so individual tests can assert on call
 * arguments and inject error paths.
 *
 * `deleteObjectIfStored` returns `true` by default (matching the route's
 * happy path where we own the underlying `/objects/...` file). Tests
 * that need to simulate "not ours" or a failure override the mock per
 * case.
 */
const deleteObjectIfStoredMock = vi.fn(async () => true);
vi.mock("../lib/objectStorage", () => {
  return {
    ObjectStorageService: vi.fn().mockImplementation(() => ({
      deleteObjectIfStored: deleteObjectIfStoredMock,
    })),
    ObjectNotFoundError: class ObjectNotFoundError extends Error {},
  };
});

const { setupRouteTests } = await import("./setup");
const { users } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeEach(() => {
  // Reset call history + restore the default success implementation so
  // tests that customize the mock (e.g. simulate a GCS failure) don't
  // leak that override into subsequent cases.
  deleteObjectIfStoredMock.mockReset();
  deleteObjectIfStoredMock.mockResolvedValue(true);
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
      .set(ADMIN_HEADERS)
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
    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
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
      .set(ADMIN_HEADERS)
      .send({ displayName: "No Id" });
    expect(r1.status).toBe(400);

    const r2 = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({ id: "u-no-name" });
    expect(r2.status).toBe(400);

    const r3 = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
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
      .set(ADMIN_HEADERS)
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
      .set(ADMIN_HEADERS)
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
      .set(ADMIN_HEADERS)
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
    const res = await request(getApp())
      .patch("/api/users/u-noop")
      .set(ADMIN_HEADERS)
      .send({});
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
      .set(ADMIN_HEADERS)
      .send({ displayName: null });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id does not exist", async () => {
    const res = await request(getApp())
      .patch("/api/users/u-ghost")
      .set(ADMIN_HEADERS)
      .send({ displayName: "Ghost" });
    expect(res.status).toBe(404);
  });

  // ---- avatar object cleanup ---------------------------------------
  // The route is responsible for deleting the prior avatar object out
  // of GCS when an admin uploads a new one or clears the field, so the
  // bucket doesn't slowly accumulate orphaned `/objects/uploads/<uuid>`
  // files. The mock at the top of the file lets us assert *which* path
  // the route asked storage to delete (or that it didn't ask at all).

  it("deletes the previous avatar object when avatarUrl is replaced", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-replace-avatar",
      displayName: "Replace Avatar",
      avatarUrl: "/objects/uploads/old-uuid",
    });

    const res = await request(getApp())
      .patch("/api/users/u-replace-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/new-uuid" });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("/objects/uploads/new-uuid");

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/old-uuid",
    );
  });

  it("deletes the previous avatar object when avatarUrl is cleared", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-clear-avatar",
      displayName: "Clear Avatar",
      avatarUrl: "/objects/uploads/about-to-go",
    });

    const res = await request(getApp())
      .patch("/api/users/u-clear-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: null });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/about-to-go",
    );
  });

  it("does not call storage when the patch leaves avatarUrl alone", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-untouched-avatar",
      displayName: "Old",
      avatarUrl: "/objects/uploads/keep-me",
    });

    const res = await request(getApp())
      .patch("/api/users/u-untouched-avatar")
      .set(ADMIN_HEADERS)
      .send({ displayName: "New" });
    expect(res.status).toBe(200);
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
  });

  it("does not call storage when the patch sets avatarUrl to its current value", async () => {
    // The PATCH treats `avatarUrl: "x"` as a write even when the value
    // matches what's already there (the FE shouldn't send it, but the
    // route still needs to be defensive). Cleanup should be skipped
    // since the previous and new URLs are identical — deleting the
    // file would yank the avatar that's still pointed at.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-same-avatar",
      displayName: "Same",
      avatarUrl: "/objects/uploads/same-uuid",
    });

    const res = await request(getApp())
      .patch("/api/users/u-same-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/same-uuid" });
    expect(res.status).toBe(200);
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
  });

  it("still calls cleanup when the previous URL was external (delegate filtering to storage)", async () => {
    // The route doesn't try to second-guess what is and isn't a
    // storage-served URL — that classification lives in
    // `deleteObjectIfStored`, which silently no-ops for external
    // values. So we assert the route DOES call into storage with the
    // raw previous value; the mock returning `true` here just stands
    // in for whatever decision the real implementation would make.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-external-avatar",
      displayName: "External",
      avatarUrl: "https://example.com/me.png",
    });

    const res = await request(getApp())
      .patch("/api/users/u-external-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/new-uuid" });
    expect(res.status).toBe(200);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "https://example.com/me.png",
    );
  });

  it("does not call cleanup when the previous avatar was already null", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-no-prev-avatar", displayName: "No Prev" });

    const res = await request(getApp())
      .patch("/api/users/u-no-prev-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/first-upload" });
    expect(res.status).toBe(200);
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
  });

  it("still returns 200 (and persists the row change) when storage cleanup fails", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-cleanup-fails",
      displayName: "Cleanup Fails",
      avatarUrl: "/objects/uploads/wont-delete",
    });
    deleteObjectIfStoredMock.mockRejectedValueOnce(new Error("GCS down"));

    const res = await request(getApp())
      .patch("/api/users/u-cleanup-fails")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/new-uuid" });
    // The DB row is the source of truth; a failed best-effort cleanup
    // must not bubble up as a 500 to the admin's edit.
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("/objects/uploads/new-uuid");

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-cleanup-fails"));
    expect(rows[0]?.avatarUrl).toBe("/objects/uploads/new-uuid");
  });
});

describe("DELETE /api/users/:id", () => {
  it("deletes the profile and returns 204", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-del", displayName: "Delete Me" });

    const res = await request(getApp())
      .delete("/api/users/u-del")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(204);

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-del"));
    expect(rows).toHaveLength(0);
  });

  it("returns 404 when the id does not exist", async () => {
    const res = await request(getApp())
      .delete("/api/users/u-ghost")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(404);
  });

  it("also deletes the avatar object when the row had one", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-del-with-avatar",
      displayName: "Has Avatar",
      avatarUrl: "/objects/uploads/del-uuid",
    });

    const res = await request(getApp())
      .delete("/api/users/u-del-with-avatar")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(204);

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/del-uuid",
    );
  });

  it("does not call storage when the deleted row had no avatar", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-del-no-avatar", displayName: "No Avatar" });

    const res = await request(getApp())
      .delete("/api/users/u-del-no-avatar")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(204);
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
  });

  it("still returns 204 when storage cleanup fails (row is gone, object leaks)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-del-cleanup-fails",
      displayName: "Cleanup Fails",
      avatarUrl: "/objects/uploads/wont-delete",
    });
    deleteObjectIfStoredMock.mockRejectedValueOnce(new Error("GCS down"));

    const res = await request(getApp())
      .delete("/api/users/u-del-cleanup-fails")
      .set(ADMIN_HEADERS);
    // The row delete already succeeded; a failed best-effort object
    // delete must not turn into a 500 the FE has no way to recover
    // from. The orphan is logged and moves on.
    expect(res.status).toBe(204);

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-del-cleanup-fails"));
    expect(rows).toHaveLength(0);
  });
});

describe("users:manage permission gate", () => {
  // The forbidden path the task explicitly calls out: any session
  // without the `users:manage` permission claim must be turned away
  // from POST/PATCH/DELETE before the request even reaches drizzle.
  // Reads stay open by design (the timeline-hydration helper needs
  // them), so the GET tests above already cover the read path
  // without elevating the caller.
  it("rejects POST /api/users without the permission claim", async () => {
    const res = await request(getApp())
      .post("/api/users")
      .send({ id: "u-nope", displayName: "Should Not Land" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires users:manage permission");

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-nope"));
    expect(rows).toHaveLength(0);
  });

  it("rejects PATCH /api/users/:id without the permission claim", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-locked", displayName: "Locked" });

    const res = await request(getApp())
      .patch("/api/users/u-locked")
      .send({ displayName: "Tampered" });
    expect(res.status).toBe(403);

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-locked"));
    expect(rows[0]?.displayName).toBe("Locked");
  });

  it("rejects DELETE /api/users/:id without the permission claim", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-keep", displayName: "Keep" });

    const res = await request(getApp()).delete("/api/users/u-keep");
    expect(res.status).toBe(403);

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-keep"));
    expect(rows).toHaveLength(1);
  });

  it("rejects when the session has unrelated permissions but not users:manage", async () => {
    // Guards against an over-broad check (e.g. truthy `permissions`
    // array) — the gate must look for the specific claim.
    const res = await request(getApp())
      .post("/api/users")
      .set("x-permissions", "plan-review:architect,codes:read")
      .send({ id: "u-other", displayName: "Other" });
    expect(res.status).toBe(403);
  });

  it("still allows GET /api/users without the permission claim", async () => {
    // Reads must stay open — the timeline-hydration helper relies on
    // anonymous lookups to resolve actor display names.
    const res = await request(getApp()).get("/api/users");
    expect(res.status).toBe(200);
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
