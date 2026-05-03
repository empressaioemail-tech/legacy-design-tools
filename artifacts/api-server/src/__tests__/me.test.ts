/**
 * /api/me — self-edit surface for the architect's own profile row.
 *
 * Two endpoints share a file because they share the auth gate (user-
 * kind requestor required, no admin claim) and the same per-file test
 * schema:
 *
 *   - `PATCH /api/me/architect-pdf-header` — DA-PI-6 PDF header
 *     override.
 *   - `PATCH /api/me/profile` — Task #366 displayName / email /
 *     avatarUrl self-edit.
 *
 * Coverage strategy mirrors `users.test.ts`: a per-file test schema is
 * mounted via `vi.mock`, dev session middleware override headers
 * (`x-requestor`) stand in for an authenticated session, and the route
 * is exercised end-to-end through supertest.
 *
 * The forbidden path (anonymous / agent caller) is explicitly tested
 * for both routes so the self-edit gate cannot regress to "any session
 * may write any profile".
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { requestUploadUrlBodySizeMax } from "@workspace/api-zod";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("me.test: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

/**
 * Mock the object-storage service the way `users.test.ts` does — the
 * `/me/profile` endpoint applies the same size cap and image-bytes
 * sniff as the admin route, and would otherwise try to reach the
 * Replit object-storage sidecar (which isn't running in the unit-test
 * container). The architect-pdf-header endpoint never touches storage,
 * so the mock is harmless for those tests.
 */
const deleteObjectIfStoredMock = vi.fn(async () => true);
const getObjectEntitySizeMock = vi.fn<
  (rawPath: string) => Promise<number | null>
>(async () => null);
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

/** 8-byte PNG magic — passes `looksLikeImage`. */
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
  deleteObjectIfStoredMock.mockReset();
  deleteObjectIfStoredMock.mockResolvedValue(true);
  getObjectEntitySizeMock.mockReset();
  getObjectEntitySizeMock.mockResolvedValue(null);
  getObjectEntityHeadMock.mockReset();
  getObjectEntityHeadMock.mockResolvedValue(PNG_SIGNATURE);
});

describe("PATCH /api/me/architect-pdf-header", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .send({ architectPdfHeader: "Should not land" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signed-in/i);
  });

  it("rejects agent-kind requestors with 401", async () => {
    // Self-edit is meaningful only for human users — agents do not
    // own a profile to edit.
    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "agent:snapshot-ingest")
      .send({ architectPdfHeader: "Should not land" });
    expect(res.status).toBe(401);
  });

  it("rejects bodies missing the architectPdfHeader key with 400", async () => {
    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-arch")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid request body");
  });

  it("sets the override and returns the updated profile row", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-arch", displayName: "Architect" });

    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-arch")
      .send({ architectPdfHeader: "Studio Foo — Pre-Design Briefing" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u-arch");
    expect(res.body.architectPdfHeader).toBe(
      "Studio Foo — Pre-Design Briefing",
    );

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-arch"));
    expect(rows[0]?.architectPdfHeader).toBe(
      "Studio Foo — Pre-Design Briefing",
    );
  });

  it("upserts a profile row on the way in for a never-before-seen architect", async () => {
    // The session middleware fires `ensureUserProfile` for every
    // fresh requestor, but it's fire-and-forget. The route re-runs
    // the upsert inline so a freshly-seen architect editing their
    // header on their first visit doesn't 404.
    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-brand-new")
      .send({ architectPdfHeader: "First Visit" });
    expect(res.status).toBe(200);

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-brand-new"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.architectPdfHeader).toBe("First Visit");
  });

  it("trims surrounding whitespace before persisting", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-trim", displayName: "Trim Test" });

    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-trim")
      .send({ architectPdfHeader: "   Padded Header   " });
    expect(res.status).toBe(200);
    expect(res.body.architectPdfHeader).toBe("Padded Header");
  });

  it("clears the override when null is sent", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-clear",
      displayName: "Clear Test",
      architectPdfHeader: "Old Override",
    });

    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-clear")
      .send({ architectPdfHeader: null });
    expect(res.status).toBe(200);
    expect(res.body.architectPdfHeader).toBeNull();
  });

  it("clears the override when an empty / whitespace-only string is sent", async () => {
    // Single "save" affordance — empty input clears the override
    // rather than persisting a literal "" the PDF route would have
    // to special-case.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-empty",
      displayName: "Empty Test",
      architectPdfHeader: "Old Override",
    });

    const r1 = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-empty")
      .send({ architectPdfHeader: "" });
    expect(r1.status).toBe(200);
    expect(r1.body.architectPdfHeader).toBeNull();

    // Reseed and re-test with whitespace-only.
    await ctx.schema.db
      .update(users)
      .set({ architectPdfHeader: "Old Override" })
      .where(eq(users.id, "u-empty"));
    const r2 = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-empty")
      .send({ architectPdfHeader: "   " });
    expect(r2.status).toBe(200);
    expect(r2.body.architectPdfHeader).toBeNull();
  });

  it("only edits the requestor's own row", async () => {
    // Defense-in-depth pin: the handler must use `req.session.requestor.id`
    // (not a body-supplied id) so a malicious payload that smuggles
    // another user's id can't reach `users.id = <other>`.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      { id: "u-self", displayName: "Self", architectPdfHeader: null },
      {
        id: "u-victim",
        displayName: "Victim",
        architectPdfHeader: "untouched",
      },
    ]);

    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-self")
      // Even if a future schema adds an `id` field, the current
      // body shape rejects unknown keys — and the handler reads
      // requestor.id regardless. Send something benign.
      .send({ architectPdfHeader: "mine" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u-self");

    const victim = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-victim"));
    expect(victim[0]?.architectPdfHeader).toBe("untouched");
  });

  it("does not require the users:manage permission claim (architect self-edit)", async () => {
    // The admin /users/:id route requires `users:manage`; this route
    // intentionally does not, since architects are not admins. Pin
    // the contract so a future refactor doesn't quietly add an admin
    // gate that locks architects out of their own setting.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-architect-only", displayName: "Architect Only" });

    const res = await request(getApp())
      .patch("/api/me/architect-pdf-header")
      .set("x-requestor", "user:u-architect-only")
      // Deliberately no x-permissions header — verifies the gate
      // does not require admin claims.
      .send({ architectPdfHeader: "Studio Bar" });
    expect(res.status).toBe(200);
    expect(res.body.architectPdfHeader).toBe("Studio Bar");
  });
});

describe("PATCH /api/me/profile — auth gate", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(getApp())
      .patch("/api/me/profile")
      .send({ displayName: "Should not land" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signed-in/i);
  });

  it("rejects agent-kind requestors with 401", async () => {
    // Agents do not own a profile row to edit, even if a session
    // somehow attaches them as the requestor.
    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "agent:snapshot-ingest")
      .send({ displayName: "Should not land" });
    expect(res.status).toBe(401);
  });

  it("does not require the users:manage permission claim (architect self-edit)", async () => {
    // The admin /users/:id route requires `users:manage`; this route
    // intentionally does not. The whole point of the new endpoint is
    // that an architect can fix their own opaque-id-as-display-name
    // without needing an admin to PATCH /users/{id} for them.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-arch-only", displayName: "u-arch-only" });

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-arch-only")
      // Deliberately no x-permissions header.
      .send({ displayName: "Architect Person" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Architect Person");
  });
});

describe("PATCH /api/me/profile — round-trip", () => {
  it("updates displayName and reflects the persisted (trimmed) value back", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-rename", displayName: "u-rename" });

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-rename")
      .send({ displayName: "  Architect Renamed  " });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u-rename");
    expect(res.body.displayName).toBe("Architect Renamed");

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-rename"));
    expect(rows[0]?.displayName).toBe("Architect Renamed");
  });

  it("updates email and clears it when an empty / null value is sent", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-email",
      displayName: "Email Test",
      email: "old@example.com",
    });

    const r1 = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-email")
      .send({ email: "  new@example.com  " });
    expect(r1.status).toBe(200);
    expect(r1.body.email).toBe("new@example.com");

    const r2 = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-email")
      .send({ email: "   " });
    expect(r2.status).toBe(200);
    expect(r2.body.email).toBeNull();

    // Re-seed and pin the explicit-null branch as well.
    await ctx.schema.db
      .update(users)
      .set({ email: "again@example.com" })
      .where(eq(users.id, "u-email"));
    const r3 = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-email")
      .send({ email: null });
    expect(r3.status).toBe(200);
    expect(r3.body.email).toBeNull();
  });

  it("rejects an empty / whitespace-only displayName with 400", async () => {
    // The architect's own name should never be silently demoted to
    // "" — that would make the timeline render a blank actor label
    // (worse than the opaque user id we'd be replacing).
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-blank", displayName: "Original" });

    const r1 = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-blank")
      .send({ displayName: "" });
    expect(r1.status).toBe(400);

    const r2 = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-blank")
      .send({ displayName: "    " });
    expect(r2.status).toBe(400);

    // Original value is untouched after the failed writes.
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-blank"));
    expect(rows[0]?.displayName).toBe("Original");
  });

  it("rejects an empty patch with 400", async () => {
    // Mirrors the admin /users/:id contract — silently no-op'ing an
    // empty body would still tick `updatedAt`, which is confusing,
    // and usually means the FE has a bug worth surfacing.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-empty-patch", displayName: "Untouched" });

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-empty-patch")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Empty update");
  });

  it("upserts a profile row on the way in for a never-before-seen architect", async () => {
    // Same first-visit story as the architect-pdf-header route —
    // the session middleware's `ensureUserProfile` is fire-and-
    // forget, so the handler re-runs the upsert inline.
    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-fresh")
      .send({ displayName: "Fresh Architect" });
    expect(res.status).toBe(200);

    if (!ctx.schema) throw new Error("schema not ready");
    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-fresh"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Fresh Architect");
  });

  it("only edits the requestor's own row", async () => {
    // Defense-in-depth pin: the handler must use the session
    // requestor's id, never a body-supplied id, so a malicious
    // payload smuggling another user's id can't bleed across rows.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values([
      { id: "u-self", displayName: "u-self" },
      { id: "u-victim", displayName: "Victim Untouched" },
    ]);

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-self")
      // Smuggled `id` field — even if zod silently drops it (it
      // does), the handler must read `requestor.id` regardless.
      .send({ id: "u-victim", displayName: "Pwned" });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u-self");
    expect(res.body.displayName).toBe("Pwned");

    const victim = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-victim"));
    expect(victim[0]?.displayName).toBe("Victim Untouched");
  });

  it("rejects an avatar object that exceeds the per-asset cap with 413", async () => {
    // Same gate as the admin POST/PATCH paths — the architect must
    // not be able to use this surface as a backdoor for landing an
    // oversized blob at users.avatar_url.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-big-avatar", displayName: "Big Avatar" });

    const oversized = requestUploadUrlBodySizeMax + 1;
    getObjectEntitySizeMock.mockResolvedValueOnce(oversized);

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-big-avatar")
      .send({ avatarUrl: "/objects/uploads/oversized" });
    expect(res.status).toBe(413);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/oversized",
    );

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-big-avatar"));
    expect(rows[0]?.avatarUrl).toBeNull();
  });

  it("rejects an avatar whose bytes are not an image with 415", async () => {
    // Mirrors the admin route's bytes-are-an-image gate. A non-
    // browser caller can declare image/jpeg at presigned-URL time
    // and PUT arbitrary bytes; the route sniffs the head before
    // letting the row reference it.
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db
      .insert(users)
      .values({ id: "u-html-avatar", displayName: "HTML Avatar" });

    getObjectEntitySizeMock.mockResolvedValueOnce(2048);
    getObjectEntityHeadMock.mockResolvedValueOnce(
      Buffer.from("<!DOCTYPE html><html>", "utf8"),
    );

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-html-avatar")
      .send({ avatarUrl: "/objects/uploads/sneaky-html" });
    expect(res.status).toBe(415);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/sneaky-html",
    );

    const rows = await ctx.schema.db
      .select()
      .from(users)
      .where(eq(users.id, "u-html-avatar"));
    expect(rows[0]?.avatarUrl).toBeNull();
  });

  it("persists a valid avatarUrl and garbage-collects the prior one", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    await ctx.schema.db.insert(users).values({
      id: "u-swap-avatar",
      displayName: "Swap Avatar",
      avatarUrl: "/objects/uploads/old-avatar",
    });
    // Fresh PNG bytes from the default mock — pass both checks.
    getObjectEntitySizeMock.mockResolvedValueOnce(1024);

    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-swap-avatar")
      .send({ avatarUrl: "/objects/uploads/new-avatar" });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe("/objects/uploads/new-avatar");

    // The prior avatar object is best-effort cleaned up so it doesn't
    // accumulate — same posture as the admin /users/:id PATCH.
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/old-avatar",
    );
  });

  it("rolls back a freshly-uploaded avatar when the body fails validation (400)", async () => {
    // The FE PUTs the avatar bytes to GCS BEFORE calling PATCH. If
    // the PATCH ends up failing (here: empty displayName 400), the
    // freshly-uploaded blob would otherwise orphan in the bucket.
    const res = await request(getApp())
      .patch("/api/me/profile")
      .set("x-requestor", "user:u-orphan")
      .send({
        displayName: "",
        avatarUrl: "/objects/uploads/orphan-from-400",
      });
    expect(res.status).toBe(400);
    expect(deleteObjectIfStoredMock).toHaveBeenCalledWith(
      "/objects/uploads/orphan-from-400",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                Track 1 — PATCH /api/me/disciplines coverage                 */
/* -------------------------------------------------------------------------- */

describe("PATCH /api/me/disciplines — auth gate", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .send({ disciplines: ["building"] });
    expect(res.status).toBe(401);
  });

  it("rejects agent-kind requestors with 401", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "agent:my-agent")
      .send({ disciplines: ["building"] });
    expect(res.status).toBe(401);
  });
});

describe("PATCH /api/me/disciplines — UpdateMyDisciplinesBody validation (post-codegen)", () => {
  it("rejects an unknown discipline value with 400", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-validation")
      .send({ disciplines: ["building", "not-a-real-discipline"] });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("rejects a missing disciplines key with 400", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-validation")
      .send({});
    expect(res.status).toBe(400);
  });

  it("rejects a non-array disciplines value with 400", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-validation")
      .send({ disciplines: "building" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/me/disciplines — round-trip", () => {
  it("persists the disciplines and returns the full User envelope", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-roundtrip")
      .send({
        disciplines: ["building", "fire-life-safety", "accessibility"],
      });
    expect(res.status).toBe(200);
    // Full User envelope (matches /me/architect-pdf-header pattern):
    // id, displayName, email, avatarUrl, architectPdfHeader,
    // disciplines, createdAt, updatedAt.
    expect(res.body).toMatchObject({
      id: "reviewer-roundtrip",
      disciplines: ["building", "fire-life-safety", "accessibility"],
    });
    expect(typeof res.body.displayName).toBe("string");
    expect("email" in res.body).toBe(true);
    expect("avatarUrl" in res.body).toBe(true);
    expect("architectPdfHeader" in res.body).toBe(true);
    expect(typeof res.body.createdAt).toBe("string");
    expect(typeof res.body.updatedAt).toBe("string");
  });

  it("accepts an empty array as a legitimate clear-all-assignments self-edit", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    // Seed disciplines so we can verify the clear actually persists.
    await db.insert(users).values({
      id: "reviewer-clear",
      displayName: "Clear Reviewer",
      disciplines: ["building", "electrical"],
    });
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-clear")
      .send({ disciplines: [] });
    expect(res.status).toBe(200);
    expect(res.body.disciplines).toEqual([]);
    const after = await db
      .select({ disciplines: users.disciplines })
      .from(users)
      .where(eq(users.id, "reviewer-clear"));
    expect(after[0]?.disciplines).toEqual([]);
  });

  it("de-duplicates repeated values before persisting (preserving first-seen order)", async () => {
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-dedupe")
      .send({
        disciplines: ["building", "fire-life-safety", "building"],
      });
    expect(res.status).toBe(200);
    expect(res.body.disciplines).toEqual(["building", "fire-life-safety"]);
  });

  it("upserts a profile row on the way in for a never-before-seen reviewer", async () => {
    if (!ctx.schema) throw new Error("ctx.schema not set");
    const db = ctx.schema.db;
    const before = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, "reviewer-fresh"));
    expect(before).toHaveLength(0);
    const res = await request(getApp())
      .patch("/api/me/disciplines")
      .set("x-requestor", "user:reviewer-fresh")
      .send({ disciplines: ["mechanical"] });
    expect(res.status).toBe(200);
    expect(res.body.disciplines).toEqual(["mechanical"]);
    const after = await db
      .select({ id: users.id, disciplines: users.disciplines })
      .from(users)
      .where(eq(users.id, "reviewer-fresh"));
    expect(after[0]?.disciplines).toEqual(["mechanical"]);
  });
});
