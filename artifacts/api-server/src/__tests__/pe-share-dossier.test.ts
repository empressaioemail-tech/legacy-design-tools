/**
 * Service-key share-dossier read route — the cortex-side leg of "the share
 * link carries the dossier".
 *
 * The PE BFF validates the sharer's HMAC share token, then calls this route
 * with the SERVICE_API_KEY bearer to read the SHARER's single saved row.
 * Assertions: service key required (session headers never suffice), single
 * (tenantId, ownerUserId, parcelNodeId) row round-trip, honest 404, strict
 * param validation (no list mode, no wildcards).
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { vi } from "vitest";
import { ctx } from "./test-context";
import { db, peSavedProperties, users } from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";

const SERVICE_TOKEN = "test-service-token-share-dossier";

vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) {
        throw new Error("pe-share-dossier.test: ctx.schema not set");
      }
      return ctx.schema.db;
    },
  };
});

const { setupRouteTests } = await import("./setup");
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

beforeAll(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  __resetServiceApiKeyCacheForTests();
});

const ROUTE = "/api/property-explorer/v1/internal/share-dossier";
const OWNER = "u_sharer_1";
const OTHER_OWNER = "u_other_2";
const PARCEL = "48055:10068";
const SNAPSHOT = {
  drawings: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { kind: "sketch" },
        geometry: {
          type: "Polygon",
          coordinates: [[[-97.6, 30.1], [-97.61, 30.1], [-97.6, 30.11], [-97.6, 30.1]]],
        },
      },
    ],
  },
  chatSummary: "Buyer asked about septic feasibility.",
  notes: "Walk the east fence line before offer.",
};

function serviceGet(query: Record<string, string>) {
  return request(getApp())
    .get(ROUTE)
    .query(query)
    .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
}

describe("GET /api/property-explorer/v1/internal/share-dossier", () => {
  beforeEach(async () => {
    // OPS-16 P-111: pe_saved_properties.owner_user_id now FKs to users.id
    // (previously ungated -- exactly the gap OPS-16 A-075 found), so the
    // fixture rows below need real parent rows first.
    await db.insert(users).values([
      { id: OWNER, displayName: OWNER },
      { id: OTHER_OWNER, displayName: OTHER_OWNER },
    ]);
    await db.insert(peSavedProperties).values([
      {
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: OWNER,
        parcelNodeId: PARCEL,
        label: "Ranchette on FM 969",
        snapshot: SNAPSHOT,
      },
      {
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: OTHER_OWNER,
        parcelNodeId: PARCEL,
        label: "Other owner's dossier",
        snapshot: { notes: "must never leak across owners" },
      },
    ]);
  });

  it("401s without any Authorization header", async () => {
    const res = await request(getApp()).get(ROUTE).query({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: OWNER,
      parcelNodeId: PARCEL,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("401s with a wrong bearer token", async () => {
    const res = await request(getApp())
      .get(ROUTE)
      .query({
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: OWNER,
        parcelNodeId: PARCEL,
      })
      .set("Authorization", "Bearer not-the-service-key");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("401s for session-style auth headers (never session auth)", async () => {
    const res = await request(getApp())
      .get(ROUTE)
      .query({
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: OWNER,
        parcelNodeId: PARCEL,
      })
      .set("x-audience", "user")
      .set("x-requestor", `user:${OWNER}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("round-trips exactly the addressed row for the service caller", async () => {
    const res = await serviceGet({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: OWNER,
      parcelNodeId: PARCEL,
    });
    expect(res.status).toBe(200);
    expect(res.body.parcelNodeId).toBe(PARCEL);
    expect(res.body.label).toBe("Ranchette on FM 969");
    expect(res.body.snapshot).toEqual(SNAPSHOT);
    expect(typeof res.body.updatedAt).toBe("string");
    // No owner identifiers beyond what was queried; no row/db internals.
    expect(res.body.ownerUserId).toBeUndefined();
    expect(res.body.tenantId).toBeUndefined();
    expect(res.body.id).toBeUndefined();
    expect(Object.keys(res.body).sort()).toEqual([
      "label",
      "parcelNodeId",
      "snapshot",
      "updatedAt",
    ]);
  });

  it("404s when no row exists for the (tenantId, ownerUserId, parcelNodeId) triple", async () => {
    const res = await serviceGet({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: "u_nobody",
      parcelNodeId: PARCEL,
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("saved_property_not_found");
  });

  it("404s for a parcel the owner has not saved (no cross-parcel leak)", async () => {
    const res = await serviceGet({
      tenantId: DEFAULT_TENANT_ID,
      ownerUserId: OWNER,
      parcelNodeId: "48055:99999",
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("saved_property_not_found");
  });

  it("400s when any of the three params is missing", async () => {
    const partials: Array<Record<string, string>> = [
      { ownerUserId: OWNER, parcelNodeId: PARCEL },
      { tenantId: DEFAULT_TENANT_ID, parcelNodeId: PARCEL },
      { tenantId: DEFAULT_TENANT_ID, ownerUserId: OWNER },
    ];
    for (const query of partials) {
      const res = await serviceGet(query);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_input");
    }
  });

  it("400s on a malformed parcelNodeId (no wildcards, no list mode)", async () => {
    for (const parcelNodeId of ["not-a-node-id", "48055:", "*", "48055:%"]) {
      const res = await serviceGet({
        tenantId: DEFAULT_TENANT_ID,
        ownerUserId: OWNER,
        parcelNodeId,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_input");
    }
  });

  it("400s on duplicate query params (array injection)", async () => {
    const res = await request(getApp())
      .get(
        `${ROUTE}?tenantId=${DEFAULT_TENANT_ID}&ownerUserId=${OWNER}&ownerUserId=${OTHER_OWNER}&parcelNodeId=${encodeURIComponent(PARCEL)}`,
      )
      .set("Authorization", `Bearer ${SERVICE_TOKEN}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
  });
});
