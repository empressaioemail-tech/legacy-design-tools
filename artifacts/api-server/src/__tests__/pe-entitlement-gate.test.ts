/**
 * WDLL item 14 — deep-route tier gate (free vs paid vs anonymous).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import {
  db,
  peUserEntitlements,
  peUserIdentities,
  placeLayerSnapshots,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-entitlement-gate: ctx.schema not set");
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

const USER_FREE = "user-free";
const USER_PAID = "user-paid";
const BAKED_NODE_ID = "48055:10068";

function asUser(req: Test, userId: string): Test {
  return req.set("x-audience", "user").set("x-requestor", `user:${userId}`);
}

function exchangeAuth(req: Test): Test {
  const secret =
    process.env["PE_SESSION_EXCHANGE_SECRET"] ||
    process.env["SESSION_SECRET"] ||
    "test-session-secret";
  return req.set("Authorization", `Bearer ${secret}`);
}

describe("PE entitlement gate", () => {
  beforeEach(async () => {
    await db.insert(users).values([
      { id: USER_FREE, displayName: "Free User" },
      { id: USER_PAID, displayName: "Paid User" },
    ]);
    await db.insert(peUserEntitlements).values([
      {
        ownerUserId: USER_FREE,
        tenantId: DEFAULT_TENANT_ID,
        accessTier: "free",
      },
      {
        ownerUserId: USER_PAID,
        tenantId: DEFAULT_TENANT_ID,
        accessTier: "paid",
      },
    ]);
  });

  it("anonymous GET entitlement shows unauthenticated free tier", async () => {
    const res = await request(getApp()).get(
      "/api/property-explorer/v1/entitlement",
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(false);
    expect(res.body.tier).toBe("free");
  });

  it("authed free user GET entitlement shows free tier", async () => {
    const res = await asUser(
      request(getApp()).get("/api/property-explorer/v1/entitlement"),
      USER_FREE,
    );
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.tier).toBe("free");
  });

  it("anonymous POST research/brief returns 401", async () => {
    const res = await request(getApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: "48055:10068" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("authentication_required");
  });

  it("authed free user POST research/brief returns 402", async () => {
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: "48055:10068" }),
      USER_FREE,
    );
    expect(res.status).toBe(402);
    expect(res.body.error).toBe("upgrade_required");
  });

  it("allows an identity on the dev paid email allowlist through deep routes", async () => {
    await db.insert(peUserIdentities).values({
      id: "pei_google_dev-operator",
      userId: USER_FREE,
      provider: "google",
      subject: "dev-operator",
      email: "nick@example.com",
    });
    const prior = process.env.PE_DEV_PAID_EMAILS;
    process.env.PE_DEV_PAID_EMAILS = "nick@example.com";
    try {
      const res = await asUser(
        request(getApp())
          .post("/api/property-explorer/v1/research/brief")
          .send({ parcelNodeId: BAKED_NODE_ID }),
        USER_FREE,
      );
      // The identity bypass clears the 402 gate. The honest 404 is expected
      // because this test has not seeded a snapshot in this case.
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("baked_snapshot_not_found");
    } finally {
      if (prior === undefined) delete process.env.PE_DEV_PAID_EMAILS;
      else process.env.PE_DEV_PAID_EMAILS = prior;
    }
  });

  it("authed paid user receives a cited baked R1 brief and manifest", async () => {
    await db.insert(placeLayerSnapshots).values([
      {
        placeKey: `node:${BAKED_NODE_ID}`,
        adapterKey: TIER1_ADAPTER_KEY,
        latRounded: "30.04220",
        lngRounded: "-97.67650",
        contentHash: "pe-r1-test",
        payloadJson: {
          bakedAt: "2026-07-22T00:00:00.000Z",
          zoning: { district: "R-1" },
          baseFacts: {
            landUse: { code: "A1", citationUrl: "https://example.test/land-use" },
          },
          envelope: {
            status: "ok",
            districtNote: "Mapped from the published district table.",
            disclosure: "Approximate envelope only.",
            citationUrl: "https://example.test/setbacks",
            geojson: {
              type: "Feature",
              properties: {},
              geometry: {
                type: "Polygon",
                coordinates: [[[-97, 30], [-97.1, 30], [-97, 30]]],
              },
            },
          },
        },
      },
      {
        placeKey: `node:${BAKED_NODE_ID}`,
        adapterKey: TIER2_ADAPTER_KEY,
        latRounded: "30.04220",
        lngRounded: "-97.67650",
        contentHash: "pe-r1-flood-test",
        payloadJson: {
          bakedAt: "2026-07-22T00:00:00.000Z",
          flood: {
            status: "in-sfha",
            citationUrl: "https://example.test/flood",
          },
        },
      },
    ]);
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: BAKED_NODE_ID }),
      USER_PAID,
    );
    expect(res.status).toBe(200);
    expect(res.body.reportFamily).toBe("R1");
    expect(res.body.mode).toBe("baked-facet-intel-v1");
    expect(res.body.source).toBe("baked-snapshot");
    expect(res.body.citations).toEqual(
      expect.arrayContaining([
        "https://example.test/land-use",
        "https://example.test/setbacks",
        "https://example.test/flood",
      ]),
    );
    expect(res.body.brief.disclosure).toEqual(
      expect.arrayContaining([
        "Mapped from the published district table.",
        "Approximate envelope only.",
      ]),
    );

    const manifest = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/research/layer-manifest/${encodeURIComponent(res.body.runId)}`,
      ),
      USER_PAID,
    );
    expect(manifest.status).toBe(200);
    expect(manifest.body.contract).toBe("layer-manifest-v1");
    expect(manifest.body.layers.map((layer: { id: string }) => layer.id)).toEqual(
      expect.arrayContaining(["buildable-envelope", "flood"]),
    );
  });

  it("session-exchange mints token for verified BFF identity", async () => {
    const res = await exchangeAuth(
      request(getApp()).post("/api/auth/session-exchange"),
    ).send({
      provider: "google",
      subject: "google-subject-123",
      email: "pe.test@example.com",
      displayName: "PE Test",
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.userId).toMatch(/^u_/);
    expect(res.body.entitlement.tier).toBe("free");
  });

  it("session-exchange rejects missing exchange secret", async () => {
    const res = await request(getApp())
      .post("/api/auth/session-exchange")
      .send({
        provider: "google",
        subject: "google-subject-456",
        email: "bad@example.com",
      });
    expect(res.status).toBe(401);
  });
});
