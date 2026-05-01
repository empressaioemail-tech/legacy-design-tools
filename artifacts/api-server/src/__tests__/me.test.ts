/**
 * /api/me/architect-pdf-header — self-edit surface for the architect's
 * stakeholder-briefing PDF header override.
 *
 * Coverage strategy mirrors `users.test.ts`: a per-file test schema is
 * mounted via `vi.mock`, dev session middleware override headers
 * (`x-requestor`) stand in for an authenticated session, and the route
 * is exercised end-to-end through supertest.
 *
 * The forbidden path (anonymous / agent caller) is explicitly tested so
 * the self-edit gate cannot regress to "any session may write any
 * profile's header".
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
      if (!ctx.schema) throw new Error("me.test: ctx.schema not set");
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
