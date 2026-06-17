/**
 * Hosted extension auth page — Hauska-branded HTML + static assets.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import type { Express } from "express";

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

describe("GET /api/auth/extension-login", () => {
  it("serves signup mode when intent=signup", async () => {
    const res = await request(getApp())
      .get("/api/auth/extension-login")
      .query({ intent: "signup", install_id: "test-install-00000001" });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toContain('data-initial-mode="signup"');
    expect(res.text).toContain('id="signup-confirm"');
    expect(res.text).toContain("Create your account");
    expect(res.text).toContain("class=\"mark\"");
    expect(res.text).toContain("/api/auth/hauska/hauska.css");
  });

  it("serves hauska.css static asset", async () => {
    const res = await request(getApp()).get("/api/auth/hauska/hauska.css");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/css/);
    expect(res.text).toContain("--brand:var(--blue-600)");
  });
});
