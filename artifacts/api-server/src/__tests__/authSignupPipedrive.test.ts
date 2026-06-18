/**
 * Extension web-auth signup → Pipedrive person sync (always, install id fallbacks).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";

const syncPipedrivePersonMock = vi.hoisted(() =>
  vi.fn(async () => ({ mode: "simulated", objectType: "person", payload: {} })),
);

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

vi.mock("../lib/brokeragePipedrive", () => ({
  syncPipedrivePerson: syncPipedrivePersonMock,
}));

const { setupRouteTests } = await import("./setup");

let getApp: () => Express;

setupRouteTests((g) => {
  getApp = g;
});

beforeEach(async () => {
  syncPipedrivePersonMock.mockClear();
  if (!ctx.schema) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const sql42 = readFileSync(
    join(here, "../../../../lib/db/drizzle/0042_brokerage_entitlements.sql"),
    "utf8",
  );
  await ctx.schema.pool.query(sql42);
});

describe("POST /api/auth/signup — extension web-auth Pipedrive", () => {
  it("syncs Pipedrive when only installId is in JSON body (extension-login path)", async () => {
    const installId = "ext-webauth-install-01";
    const email = `ext-signup-${Date.now()}@example.com`;

    const res = await request(getApp())
      .post("/api/auth/signup")
      .send({ email, password: "TestPass123!", installId });

    expect(res.status).toBe(201);
    expect(syncPipedrivePersonMock).toHaveBeenCalledTimes(1);
    expect(syncPipedrivePersonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email,
        installId,
        acquisitionSource: "hauska_extension_signup",
      }),
    );
  });

  it("syncs Pipedrive with user fallback when install id is absent", async () => {
    const email = `ext-noinstall-${Date.now()}@example.com`;

    const res = await request(getApp())
      .post("/api/auth/signup")
      .send({ email, password: "TestPass123!" });

    expect(res.status).toBe(201);
    expect(syncPipedrivePersonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        email,
        acquisitionSource: "hauska_web_signup",
        installId: expect.stringMatching(/^hauska-user-/) as unknown as string,
      }),
    );
  });
});
