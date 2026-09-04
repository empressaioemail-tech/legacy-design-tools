/**
 * GHL contact creation on Property Explorer signup.
 *
 * Decision `_decisions/2026-08-31_gohighlevel_supersedes_pipedrive.md`,
 * 2026-09-04 addendum: `POST /api/auth/session-exchange` upserts a GHL
 * contact (name + email + `source-organic` tag only) exactly when
 * `upsertPeOidcIdentity` reports `isNewUser: true` — a brand-new `users`
 * row, i.e. a real signup, not a returning sign-in. See
 * `../lib/peGhlContact.ts` for the fail-open implementation this covers.
 *
 * Covers:
 *   - a new signup sends the right request body/headers to GHL and writes
 *     no `tier-*` tag
 *   - a GHL failure (network error and non-2xx) never blocks or fails the
 *     sign-up response
 *   - a returning user (isNewUser: false) never triggers a GHL call at all
 *   - GHL left unconfigured is itself a fail-open no-op, not an error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-ghl-contact: ctx.schema not set");
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

function exchangeAuth(req: Test): Test {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  return req.set("Authorization", `Bearer ${secret}`);
}

beforeEach(() => {
  process.env["GOHIGHLEVEL_API_KEY"] = "test_ghl_key";
  process.env["GOHIGHLEVEL_LOCATION_ID"] = "test_ghl_location";
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["GOHIGHLEVEL_API_KEY"];
  delete process.env["GOHIGHLEVEL_LOCATION_ID"];
});

describe("session-exchange -> GHL contact on new signup", () => {
  it("a new signup upserts a GHL contact with name + email + source-organic tag only, no tier tag", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(
        JSON.stringify({
          new: true,
          contact: { id: "ghl_contact_1" },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-new-1",
      email: "ghl-new-1@example.com",
      displayName: "GHL New User",
    });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://services.leadconnectorhq.com/contacts/upsert");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test_ghl_key");
    expect(headers["Version"]).toBe("2021-07-28");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(body["locationId"]).toBe("test_ghl_location");
    expect(body["email"]).toBe("ghl-new-1@example.com");
    expect(body["name"]).toBe("GHL New User");
    expect(body["tags"]).toEqual(["source-organic"]);
    // No pipeline/opportunity fields, and no tier-* tag from this hook — the
    // Stripe webhook is the sole writer of a tier tag, off a real payment.
    expect(body).not.toHaveProperty("pipelineId");
    expect(body).not.toHaveProperty("opportunity");
    const tags = body["tags"] as string[];
    expect(tags.some((t) => t.startsWith("tier-"))).toBe(false);
  });

  it("a GHL network failure does not block or fail the signup response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed: network error");
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-network-fail",
      email: "ghl-network-fail@example.com",
      displayName: "GHL Network Fail",
    });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();
    expect(res.body.token).toBeTruthy();
  });

  it("a GHL 4xx response does not block or fail the signup response", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({ message: "invalid credential" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-401",
      email: "ghl-401@example.com",
      displayName: "GHL 401",
    });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();
  });

  it("a returning user (isNewUser: false) never triggers a GHL contact call", async () => {
    const calls: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls.push(url);
      return new Response(
        JSON.stringify({ new: true, contact: { id: "ghl_contact_returning" } }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const first = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-returning",
      email: "ghl-returning@example.com",
      displayName: "GHL Returning",
    });
    expect(first.status).toBe(201);
    expect(calls).toHaveLength(1);

    const second = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-returning",
      email: "ghl-returning@example.com",
      displayName: "GHL Returning",
    });
    expect(second.status).toBe(200);
    expect(second.body.userId).toBe(first.body.userId);

    // No second GHL call for the returning sign-in.
    expect(calls).toHaveLength(1);
  });

  it("GHL left unconfigured is a fail-open no-op — no fetch attempted, signup still succeeds", async () => {
    delete process.env["GOHIGHLEVEL_API_KEY"];
    delete process.env["GOHIGHLEVEL_LOCATION_ID"];
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-ghl-unconfigured",
      email: "ghl-unconfigured@example.com",
      displayName: "GHL Unconfigured",
    });

    expect(res.status).toBe(201);
    expect(res.body.userId).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
