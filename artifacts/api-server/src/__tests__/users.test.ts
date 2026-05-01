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
import { requestUploadUrlBodySizeMax } from "@workspace/api-zod";
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
// Default to "not one of ours" so existing tests that don't seed an
// avatar object still pass the actual-size enforcement step the route
// runs before persisting `users.avatar_url`. Tests that exercise the
// 413 / missing-object branches override this per case.
const getObjectEntitySizeMock = vi.fn<(rawPath: string) => Promise<number | null>>(
  async () => null,
);
// Default to a real PNG magic signature so every existing happy-path
// test reaches the DB write without each one having to seed bytes by
// hand. Tests that exercise the 415 / missing-object branches override
// per case (with non-image bytes or a thrown ObjectNotFoundError).
// External-URL tests don't care about the value here — the real
// ObjectStorageService returns null for non-`/objects/` paths, but
// the route maps both null and "ok" onto "skip" so a PNG default
// doesn't change the behaviour the external-URL tests are pinning.
const getObjectEntityHeadMock = vi.fn<
  (rawPath: string, byteLen: number) => Promise<Buffer | null>
>();
class ObjectNotFoundErrorClass extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}
vi.mock("../lib/objectStorage", () => {
  return {
    ObjectStorageService: vi.fn().mockImplementation(() => ({
      deleteObjectIfStored: deleteObjectIfStoredMock,
      getObjectEntitySize: getObjectEntitySizeMock,
      getObjectEntityHead: getObjectEntityHeadMock,
    })),
    ObjectNotFoundError: ObjectNotFoundErrorClass,
  };
});

/**
 * 8-byte PNG magic signature. Anything starting with these bytes will
 * pass {@link looksLikeImage}, so tests that need the route's image
 * sniff to succeed can return this from `getObjectEntityHeadMock`.
 */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

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
  getObjectEntitySizeMock.mockReset();
  getObjectEntitySizeMock.mockResolvedValue(null);
  getObjectEntityHeadMock.mockReset();
  getObjectEntityHeadMock.mockResolvedValue(PNG_SIGNATURE);
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

  it("rejects a create whose avatar object exceeds the per-asset cap with 413", async () => {
    // The presigned-URL handler caps client-declared metadata, but a
    // non-browser client could lie about size and PUT a much larger
    // file. The actual stored size is what gates `users.avatar_url`,
    // so the row never references an oversized blob — this test pins
    // that promise on the create path.
    const oversized = requestUploadUrlBodySizeMax + 1;
    getObjectEntitySizeMock.mockResolvedValueOnce(oversized);

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-too-big",
        displayName: "Too Big",
        avatarUrl: "/objects/uploads/oversized-uuid",
      });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain(String(oversized));
    expect(res.body.error).toContain(String(requestUploadUrlBodySizeMax));
    // The orphan in storage gets best-effort cleaned up so the rejected
    // upload doesn't leak bytes.
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/oversized-uuid",
    );
    // The row itself must NOT have been inserted.
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-too-big"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a create whose avatar object is missing from storage with 400", async () => {
    // If the client claims an `/objects/...` URL but never PUT the
    // bytes (or PUT failed), the size check raises ObjectNotFoundError
    // and the route surfaces it as a clear 400 instead of letting the
    // row reference a phantom object.
    getObjectEntitySizeMock.mockRejectedValueOnce(new ObjectNotFoundErrorClass());

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-phantom",
        displayName: "Phantom",
        avatarUrl: "/objects/uploads/never-uploaded",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Avatar object not found in storage");
  });

  it("accepts a create whose avatar object is at or under the cap", async () => {
    // Exactly-at-cap is fine: the rejection branch is `> max`, not `>=`.
    getObjectEntitySizeMock.mockResolvedValueOnce(requestUploadUrlBodySizeMax);

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-at-cap",
        displayName: "At Cap",
        avatarUrl: "/objects/uploads/just-fits",
      });

    expect(res.status).toBe(201);
    expect(res.body.avatarUrl).toBe("/objects/uploads/just-fits");
  });

  it("rejects a create whose avatar bytes do not match an image signature with 415", async () => {
    // The presigned-URL endpoint pre-checks the *declared* contentType,
    // but a non-browser client can declare image/jpeg and PUT arbitrary
    // bytes (e.g. a JSON dump that fits under the size cap). The route
    // sniffs the head of the stored object before persisting the row;
    // if the signature doesn't match an image format, we 415 and the
    // orphan blob is best-effort cleaned up.
    getObjectEntityHeadMock.mockResolvedValueOnce(
      Buffer.from('{"not":"an image"}', "utf8"),
    );

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-fake-image",
        displayName: "Fake Image",
        avatarUrl: "/objects/uploads/smuggled-json",
      });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/image format/i);
    // Orphan cleanup: the rejected blob is deleted so the bucket
    // doesn't accumulate non-image junk after a rejected upload.
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/smuggled-json",
    );
    // The row itself must NOT have been inserted — the entire promise
    // of this gate is that `users.avatar_url` never references a blob
    // whose bytes aren't actually an image.
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-fake-image"));
    expect(rows).toHaveLength(0);
  });

  it("rejects a create whose avatar object is missing from storage during the image sniff with 400", async () => {
    // Same threat surface as the size-check missing branch, but the
    // image sniff runs second so this exercises the path where size
    // succeeded (no bytes claimed yet) and then the head read raised
    // ObjectNotFoundError. The route surfaces it as a 400 so the
    // FE can recover, instead of letting the row reference a phantom.
    getObjectEntitySizeMock.mockResolvedValueOnce(1024);
    getObjectEntityHeadMock.mockRejectedValueOnce(
      new ObjectNotFoundErrorClass(),
    );

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-vanished-during-sniff",
        displayName: "Vanished",
        avatarUrl: "/objects/uploads/vanished-during-sniff",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Avatar object not found in storage");
  });

  it("rejects an HTML page with an embedded `<svg>` tag with 415", async () => {
    // Specific bypass pin: a naïve "match `<svg` anywhere in the
    // head bytes" sniff would falsely accept this payload because
    // it contains the literal substring `<svg`. The strict prefix
    // walker rejects it because the *first* meaningful tag is
    // `<html>`, not `<svg>` — so the bytes would render as HTML in
    // any consumer, making them ineligible for the avatar slot.
    getObjectEntityHeadMock.mockResolvedValueOnce(
      Buffer.from(
        `<!DOCTYPE html><html><body>` +
          `<svg xmlns="http://www.w3.org/2000/svg"></svg>` +
          `</body></html>`,
        "utf8",
      ),
    );

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-html-with-svg",
        displayName: "HTML With Svg",
        avatarUrl: "/objects/uploads/html-with-embedded-svg",
      });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/image format/i);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/html-with-embedded-svg",
    );
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-html-with-svg"));
    expect(rows).toHaveLength(0);
  });

  it("returns 415 (not 500) when the orphan cleanup itself fails after a non-image upload", async () => {
    // Posture check: a transient GCS outage during cleanup of the
    // rejected blob must not mask the real 415 the caller is owed.
    // The orphan we failed to delete is precisely the failure mode
    // this whole feature is mitigating, so we log and move on.
    getObjectEntityHeadMock.mockResolvedValueOnce(
      Buffer.from("<html>not an image</html>", "utf8"),
    );
    deleteObjectIfStoredMock.mockRejectedValueOnce(new Error("GCS down"));

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-cleanup-fails-415",
        displayName: "Cleanup Fails",
        avatarUrl: "/objects/uploads/will-stay-orphaned",
      });

    expect(res.status).toBe(415);
    // The row still must not exist — the cleanup blip doesn't change
    // the gate's verdict on whether the row gets to reference the blob.
    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-cleanup-fails-415"));
    expect(rows).toHaveLength(0);
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

  // ---- freshly-uploaded avatar rollback on POST failure ------------
  // Same mirror leak as the PATCH path: the create modal also pushes
  // the avatar to GCS before the row exists. If the POST fails (409
  // duplicate, 400 bad body, 500), the freshly-uploaded object has
  // nothing pointing at it. The handler must roll it back.

  it("rolls back the freshly-uploaded avatar when the id already exists (409)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-dup-rollback", displayName: "Original" });

    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-dup-rollback",
        displayName: "Duplicate",
        avatarUrl: "/objects/uploads/orphan-from-409",
      });
    expect(res.status).toBe(409);

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/orphan-from-409",
    );
  });

  it("rolls back the freshly-uploaded avatar when the body fails validation (400)", async () => {
    // Missing `id` triggers the zod 400 path, but the freshly-
    // uploaded avatar in the same body still needs to be cleaned up.
    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        displayName: "No Id",
        avatarUrl: "/objects/uploads/orphan-from-400",
      });
    expect(res.status).toBe(400);

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/orphan-from-400",
    );
  });

  it("does not roll back when the create succeeds — the row references the avatar", async () => {
    const res = await request(getApp())
      .post("/api/users")
      .set(ADMIN_HEADERS)
      .send({
        id: "u-create-keeps-avatar",
        displayName: "Keeps Avatar",
        avatarUrl: "/objects/uploads/freshly-bound",
      });
    expect(res.status).toBe(201);

    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
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

  // ---- freshly-uploaded avatar rollback on PATCH failure -----------
  // Mirror leak: when the admin picks a new avatar, the FE pushes it
  // to GCS *first* and then PATCHes the row. If the PATCH fails for
  // any reason (validation 400, 404, transient 500), the new
  // `/objects/uploads/<uuid>` is already in the bucket and nothing
  // points at it. The handler must hand that path to
  // `deleteObjectIfStored` so the bucket doesn't accumulate orphans.

  it("rolls back the freshly-uploaded avatar when the user does not exist (404)", async () => {
    const res = await request(getApp())
      .patch("/api/users/u-ghost-rollback")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/orphan-from-404" });
    expect(res.status).toBe(404);

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/orphan-from-404",
    );
  });

  it("rolls back the freshly-uploaded avatar when the body fails validation (400)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-bad-body", displayName: "Bad Body" });

    // displayName=null trips the zod schema (it's `.optional()`, not
    // `.nullish()`), so the route 400s before any DB read. The
    // freshly-uploaded avatar in the same body still needs to be
    // cleaned up.
    const res = await request(getApp())
      .patch("/api/users/u-bad-body")
      .set(ADMIN_HEADERS)
      .send({
        displayName: null,
        avatarUrl: "/objects/uploads/orphan-from-400",
      });
    expect(res.status).toBe(400);

    expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/orphan-from-400",
    );
  });

  it("rolls back the freshly-uploaded avatar when the DB update throws (500)", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-db-blows-up",
      displayName: "DB Blows Up",
      avatarUrl: "/objects/uploads/old-still-referenced",
    });

    // Spy on the schema's `update` to force a transient failure mid-
    // PATCH. Reset after the assertion so other tests aren't affected.
    const updateSpy = vi
      .spyOn(ctx.schema.db, "update")
      .mockImplementationOnce(() => {
        throw new Error("simulated DB outage");
      });

    try {
      const res = await request(getApp())
        .patch("/api/users/u-db-blows-up")
        .set(ADMIN_HEADERS)
        .send({ avatarUrl: "/objects/uploads/orphan-from-500" });
      expect(res.status).toBe(500);

      // The freshly-uploaded path is the only one we should clean up
      // — the existing row's avatarUrl is still referenced (the row
      // didn't change), so we must NOT delete it.
      expect(deleteObjectIfStoredMock).toHaveBeenCalledTimes(1);
      expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
        "/objects/uploads/orphan-from-500",
      );

      const rows = await ctx.schema.db
        .select()
        .from(users)
        .where(eq(users.id, "u-db-blows-up"));
      expect(rows[0]?.avatarUrl).toBe("/objects/uploads/old-still-referenced");
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("does NOT roll back when the failed PATCH re-sends the same avatarUrl the existing row already references", async () => {
    // Subtle but important: a caller that PATCHes with the same
    // avatarUrl the row already has, and runs into a downstream 5xx,
    // must NOT see that referenced object yanked from under them.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-resend-same",
      displayName: "Resend Same",
      avatarUrl: "/objects/uploads/keep-me-around",
    });

    const updateSpy = vi
      .spyOn(ctx.schema.db, "update")
      .mockImplementationOnce(() => {
        throw new Error("simulated DB outage");
      });

    try {
      const res = await request(getApp())
        .patch("/api/users/u-resend-same")
        .set(ADMIN_HEADERS)
        .send({ avatarUrl: "/objects/uploads/keep-me-around" });
      expect(res.status).toBe(500);

      expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();

      const rows = await ctx.schema.db
        .select()
        .from(users)
        .where(eq(users.id, "u-resend-same"));
      expect(rows[0]?.avatarUrl).toBe("/objects/uploads/keep-me-around");
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("does not roll back anything when the failing PATCH did not include an avatarUrl", async () => {
    // No avatar on the wire = nothing freshly uploaded = nothing to
    // roll back, and no spurious cleanup call either.
    const res = await request(getApp())
      .patch("/api/users/u-no-avatar-in-body")
      .set(ADMIN_HEADERS)
      .send({ displayName: "Doesn't Exist" });
    expect(res.status).toBe(404);

    expect(deleteObjectIfStoredMock).not.toHaveBeenCalled();
  });

  it("still returns the original failure status when the rollback itself fails", async () => {
    // Posture check: a transient GCS outage during rollback must not
    // mutate the failure the caller already saw — the orphan we
    // failed to delete is precisely the failure mode this whole
    // feature is mitigating, so we log and move on.
    deleteObjectIfStoredMock.mockRejectedValueOnce(new Error("GCS down"));

    const res = await request(getApp())
      .patch("/api/users/u-ghost-rollback-fails")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/will-stay-orphaned" });
    expect(res.status).toBe(404);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/will-stay-orphaned",
    );
  });

  it("rejects a patch whose new avatar object exceeds the per-asset cap with 413", async () => {
    // Mirror of the POST 413 test on the patch path. This is the
    // primary surface for an attacker who lied to the presigned-URL
    // endpoint about size and PUT a huge file: the existing user row
    // wouldn't change to point at it, and the orphan gets cleaned up.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-patch-too-big",
      displayName: "Patch Too Big",
      avatarUrl: "/objects/uploads/old-but-fine",
    });
    const oversized = requestUploadUrlBodySizeMax + 1;
    getObjectEntitySizeMock.mockResolvedValueOnce(oversized);

    const res = await request(getApp())
      .patch("/api/users/u-patch-too-big")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/oversized-uuid" });

    expect(res.status).toBe(413);
    expect(res.body.error).toContain(String(oversized));

    // The oversized blob gets cleaned up; the previous (valid) avatar
    // is left intact because the row never changed.
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/oversized-uuid",
    );
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalledWith(
      "/objects/uploads/old-but-fine",
    );
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-patch-too-big"));
    expect(rows[0]?.avatarUrl).toBe("/objects/uploads/old-but-fine");
  });

  it("skips the size check (and accepts) when the new avatar URL is external", async () => {
    // External URLs (pasted by the admin in the picker) aren't ours to
    // measure, so getObjectEntitySize returns null and the row gets
    // updated normally. This keeps the legacy "paste a URL" path
    // working unchanged.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-external-avatar",
      displayName: "External Avatar",
    });
    // Default mock already returns null, but state it explicitly so
    // the intent is obvious to the next reader.
    getObjectEntitySizeMock.mockResolvedValueOnce(null);

    const res = await request(getApp())
      .patch("/api/users/u-external-avatar")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "https://example.com/avatar.png" });

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("https://example.com/avatar.png");
  });

  it("does not consult storage size when the patch only clears the avatar", async () => {
    // Clearing (`avatarUrl: null`) shouldn't pay for a GCS metadata
    // round-trip. The check is gated on a truthy new value.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-clear-skip-check",
      displayName: "Clear",
      avatarUrl: "/objects/uploads/about-to-clear",
    });

    const res = await request(getApp())
      .patch("/api/users/u-clear-skip-check")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: null });

    expect(res.status).toBe(200);
    expect(getObjectEntitySizeMock).not.toHaveBeenCalled();
    // Image sniff is also gated on a truthy new value — clearing the
    // column should never pay for a GCS head-read either.
    expect(getObjectEntityHeadMock).not.toHaveBeenCalled();
  });

  it("rejects a patch whose new avatar bytes do not match an image signature with 415", async () => {
    // Mirror of the POST 415 test on the patch path. The previous
    // (valid) avatar must NOT be deleted — the row never changed, so
    // it still references it. Only the freshly-uploaded non-image is
    // best-effort cleaned up.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-patch-fake-image",
      displayName: "Patch Fake Image",
      avatarUrl: "/objects/uploads/old-real-image",
    });
    getObjectEntityHeadMock.mockResolvedValueOnce(
      Buffer.from("<html><body>not an image</body></html>", "utf8"),
    );

    const res = await request(getApp())
      .patch("/api/users/u-patch-fake-image")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/smuggled-html" });

    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/image format/i);

    // The smuggled blob gets cleaned up; the previous (valid) avatar
    // is left intact because the row never changed.
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/smuggled-html",
    );
    expect(deleteObjectIfStoredMock).not.toHaveBeenCalledWith(
      "/objects/uploads/old-real-image",
    );
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-patch-fake-image"));
    expect(rows[0]?.avatarUrl).toBe("/objects/uploads/old-real-image");
  });

  it("accepts a patch when the avatar bytes match a real image signature", async () => {
    // Happy path: the route's image sniff sees a valid PNG header and
    // lets the row land. This is the same default the beforeEach hook
    // sets, but pinning it explicitly here documents the contract for
    // the next reader.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-patch-real-image",
      displayName: "Patch Real Image",
    });
    getObjectEntityHeadMock.mockResolvedValueOnce(PNG_SIGNATURE);

    const res = await request(getApp())
      .patch("/api/users/u-patch-real-image")
      .set(ADMIN_HEADERS)
      .send({ avatarUrl: "/objects/uploads/real-png" });

    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("/objects/uploads/real-png");
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
