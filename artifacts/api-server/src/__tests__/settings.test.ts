/**
 * /api/settings — admin-only Settings surface (stub).
 *
 * Pins the permission gate the route installs router-wide: any session
 * without the `settings:manage` claim must be rejected with a 403
 * before the request reaches the handler, and a session that *does*
 * carry the claim must get a 200. Mirrors the pattern in
 * `users.test.ts` (the dev `x-permissions` header opts the test caller
 * into a specific permission set without minting a real cookie).
 *
 * This test exists so that when Task #121 swaps the stub handler for
 * the real Settings implementation, the gate that protects it cannot
 * silently regress — the 403/200 split keeps holding.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

/**
 * Standing-in for an authenticated admin: the dev session middleware
 * honours `x-permissions` outside production, so attaching this header
 * is enough to satisfy the `requireSettingsManage` gate without
 * minting a real cookie.
 */
const ADMIN_HEADERS = { "x-permissions": "settings:manage" } as const;

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("settings:manage permission gate", () => {
  it("rejects GET /api/settings without the permission claim", async () => {
    if (!ctx.schema) throw new Error("schema not ready");
    const res = await request(getApp()).get("/api/settings");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Requires settings:manage permission");
  });

  it("rejects when the session has unrelated permissions but not settings:manage", async () => {
    // Guards against an over-broad check (e.g. truthy `permissions`
    // array) — the gate must look for the specific claim.
    const res = await request(getApp())
      .get("/api/settings")
      .set("x-permissions", "users:manage,reviewers:manage,plan-review:architect");
    expect(res.status).toBe(403);
  });

  it("returns 200 when the session carries settings:manage", async () => {
    const res = await request(getApp())
      .get("/api/settings")
      .set(ADMIN_HEADERS);
    expect(res.status).toBe(200);
    // Stub returns an empty bag; the wire shape is forward-compatible
    // with the real settings payload Task #121 will install.
    expect(res.body).toEqual({});
  });
});
