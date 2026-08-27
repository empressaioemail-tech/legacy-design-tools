/**
 * WDLL item 14 — deep-route tier gate (free vs paid vs anonymous).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request, { type Test } from "supertest";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { ctx } from "./test-context";
import {
  db,
  peUserEntitlements,
  placeLayerSnapshots,
  users,
} from "@workspace/db";
import { DEFAULT_TENANT_ID } from "../middlewares/session";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";
import {
  memoryFloodHazardAtoms,
  resetFloodHazardAtomQueryableForTests,
  setFloodHazardAtomQueryableForTests,
} from "../lib/floodHazardFactRead";

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
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
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

  afterEach(() => {
    resetFloodHazardAtomQueryableForTests();
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

  it("allows a DB dev_role user through deep routes (env allowlist retired)", async () => {
    await db
      .update(peUserEntitlements)
      .set({ devRole: true })
      .where(eq(peUserEntitlements.ownerUserId, USER_FREE));
    const res = await asUser(
      request(getApp())
        .post("/api/property-explorer/v1/research/brief")
        .send({ parcelNodeId: BAKED_NODE_ID }),
      USER_FREE,
    );
    // The dev-role bypass clears the 402 gate. The honest 404 is expected
    // because this test has not seeded a snapshot in this case.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("baked_snapshot_not_found");
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
    // Anti-zombie: baked envelope is stripped from the facets wire, so setbacks
    // citation is no longer composed from Tier-1 envelope. Land-use remains.
    expect(res.body.citations).toEqual(
      expect.arrayContaining(["https://example.test/land-use"]),
    );
    expect(res.body.citations).not.toContain("https://example.test/setbacks");

    // SS-W16 (2026-08-19): this assertion USED to require the flood citation
    // "https://example.test/flood", composed from the baked Tier-2 flood facet.
    // That facet is retired — it asked FEMA at a 0.005-degree tile centre, a
    // measured median 227 m from the parcel, and was correct in 0 of 5,714
    // adjudicated cases. A test asserting a citation the system should never
    // have emitted converts the defect into a specification and makes the fix
    // read as a regression, so it is inverted here rather than deleted: the
    // brief must NOT cite the retired instrument.
    expect(res.body.citations).not.toContain("https://example.test/flood");

    // The paid brief must not go silently blank either. The flood section keeps
    // its place and carries the refusal, so "withdrawn and why" is legible and
    // is not collapsed into "never measured".
    const floodSection = res.body.brief.sections.find(
      (section: { id: string }) => section.id === "flood",
    );
    expect(floodSection).toBeDefined();
    expect(floodSection.data).toBeNull();
    expect(floodSection.refusal.state).toBe("refused");
    expect(floodSection.refusal.code).toBe("unrecognised-producer");

    const envelopeSection = res.body.brief.sections.find(
      (section: { id: string }) => section.id === "setbacks-envelope",
    );
    expect(envelopeSection.data).toBeNull();
    expect(envelopeSection.refusal.code).toBe("baked-envelope-not-served");

    // Disclosure may be empty when envelope is stripped; brief still 200 cited.
    expect(Array.isArray(res.body.brief.disclosure)).toBe(true);

    const manifest = await asUser(
      request(getApp()).get(
        `/api/property-explorer/v1/research/layer-manifest/${encodeURIComponent(res.body.runId)}`,
      ),
      USER_PAID,
    );
    expect(manifest.status).toBe(200);
    expect(manifest.body.contract).toBe("layer-manifest-v1");
    // SS-W16: the manifest used to emit a "flood" layer off the baked Tier-2
    // facet. No flood layer is composed from a baked snapshot any more, and the
    // buildable-envelope layer is absent because the baked envelope is stripped
    // (atom path owns envelope product truth). The manifest therefore degrades
    // HONESTLY, naming the refusal, rather than shipping a wrong hazard layer.
    expect(manifest.body.layers.map((layer: { id: string }) => layer.id)).not.toContain(
      "flood",
    );
    expect(manifest.body.degraded).toBe(true);
    expect(manifest.body.reason).toContain("refused");
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
