/**
 * Baked node-facet READ endpoint — anonymous, NO-AI, owner-free.
 *
 *   GET /api/brokerage/v1/place/node/:parcelNodeId/facets
 *
 * Two layers:
 *   1. Pure unit tests (always run) — the id validator and the
 *      defense-in-depth owner-strip / owner-detect helpers.
 *   2. Integration tests (skipIf no DB) — seed a baked snapshot row into the
 *      test schema (including a deliberately-injected owner key to PROVE the
 *      strip) and exercise the anonymous endpoint end-to-end: baked facets are
 *      returned, owner is omitted, honest-absence is served, un-baked nodes
 *      404, malformed ids 400 — all WITHOUT an API key (browse is public-tier).
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from "vitest";
import request from "supertest";
import type { Express } from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ctx } from "./test-context";
import {
  isValidParcelNodeId,
  placeKeyForNode,
  sanitizeNodeFacetPayload,
  payloadHasOwnerKey,
} from "../routes/brokerageNodeFacets";
import { TIER1_ADAPTER_KEY } from "../nodeFacetBakeTier1Cli";

// Point the route module's `db` (and this test's seeding `db`) at the
// per-file test schema, so writes land where `truncateAll` clears them
// between cases. Without this, `db` uses the default public-schema
// connection, the shared setupRouteTests truncate (which targets the test
// schema) never clears the seeded rows, and the second case duplicate-keys.
vi.mock("@workspace/db", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/db")>("@workspace/db");
  return {
    ...actual,
    get db() {
      if (!ctx.schema) throw new Error("brokerageNodeFacets: ctx.schema not set");
      return ctx.schema.db;
    },
  };
});

// -------------------------------------------------------------------------
// 1. Pure unit tests — no DB, always run, exit-bounded.
// -------------------------------------------------------------------------

describe("brokerageNodeFacets helpers (pure)", () => {
  it("validates {fips}:{propId} node ids and rejects junk", () => {
    expect(isValidParcelNodeId("48055:10068")).toBe(true);
    expect(isValidParcelNodeId("48091:ABC-123")).toBe(true);
    expect(isValidParcelNodeId("")).toBe(false);
    expect(isValidParcelNodeId("48055")).toBe(false); // no prop id
    expect(isValidParcelNodeId("4805:10068")).toBe(false); // 4-digit fips
    expect(isValidParcelNodeId("48055:")).toBe(false); // empty prop id
    expect(isValidParcelNodeId("48055:1 OR 1=1")).toBe(false); // no spaces
    expect(isValidParcelNodeId("../../etc")).toBe(false);
  });

  it("builds the bake's place_key form", () => {
    expect(placeKeyForNode("48055:10068")).toBe("node:48055:10068");
  });

  it("strips owner-shaped keys at any depth (defense-in-depth)", () => {
    const dirty = {
      parcelNodeId: "48055:10068",
      owner: "SHOULD NOT LEAK",
      ownerName: "SHOULD NOT LEAK",
      owner_name: "SHOULD NOT LEAK",
      baseFacts: {
        apn: "10068",
        owner: { name: "SHOULD NOT LEAK", mailing: "x" },
        landUse: { code: "A1", ownerOccupied: true },
      },
      history: [{ ownerOfRecord: "SHOULD NOT LEAK", year: 2020 }],
      // NOT owner-shaped — must survive.
      landOwnership: "public",
      downtown: "kept",
    };
    const clean = sanitizeNodeFacetPayload(dirty) as Record<string, unknown>;
    expect(payloadHasOwnerKey(dirty)).toBe(true);
    expect(payloadHasOwnerKey(clean)).toBe(false);
    expect(JSON.stringify(clean)).not.toMatch(/SHOULD NOT LEAK/);
    // Non-owner keys survive verbatim.
    expect(clean.landOwnership).toBe("public");
    expect(clean.downtown).toBe("kept");
    expect((clean.baseFacts as Record<string, unknown>).apn).toBe("10068");
    expect(
      (
        (clean.baseFacts as Record<string, unknown>).landUse as Record<
          string,
          unknown
        >
      ).code,
    ).toBe("A1");
  });

  it("owner-free payloads pass through untouched", () => {
    const clean = {
      tier: 1,
      baseFacts: { apn: "10068", landUse: { code: "A1" }, acreage: null },
      zoning: null,
      envelope: { status: "declined" },
      facetCoverage: { landUse: true },
    };
    expect(payloadHasOwnerKey(clean)).toBe(false);
    expect(sanitizeNodeFacetPayload(clean)).toEqual(clean);
  });
});

// -------------------------------------------------------------------------
// 2. Integration tests — seed a baked row, hit the anonymous endpoint.
// -------------------------------------------------------------------------

const hasDb = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
);

// NB: do NOT destructure `db` here — the mocked `db` is a getter that throws
// until ctx.schema is set (inside setupRouteTests' beforeAll). Destructuring at
// module scope would invoke the getter too early. `placeLayerSnapshots` is a
// plain export, safe to destructure; `db` is read lazily inside the hooks.
const dbMod = await import("@workspace/db");
const { placeLayerSnapshots } = dbMod;
const { setupRouteTests } = await import("./setup");
const { truncateAll } = await import("@workspace/db/testing");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

/** A realistic Tier-1 payload with a real land-use + a deliberately-injected
 * owner key at depth (to PROVE the route strips it — the real bake never
 * writes one). */
const BAKED_NODE_ID = "48055:10068";
const bakedPayload = {
  facetSchemaVersion: "node-facets-tier1-v1",
  tier: 1,
  parcelNodeId: BAKED_NODE_ID,
  countyFips: "48055",
  countyName: "Caldwell",
  baseFacts: {
    apn: "10068",
    situsAddress: "1391 FM 1854 , DALE, TX 78616",
    situsCity: "DALE",
    situsState: "TX",
    landUse: {
      code: "A1",
      description: "Single-family residential",
      source: "cad-roll",
      vintage: "2026-caldwell-cad-export_june-5-2026",
    },
    acreage: { value: 0.2388, sqft: 10403, method: "shoelace-wgs84" },
    // NOT baked by the real CLI — injected to prove the defense-in-depth strip.
    owner_name: "PRIVATE OWNER SHOULD NOT LEAK",
  },
  zoning: null,
  envelope: { status: "declined", confidence: 0, provisional: true },
  facetCoverage: {
    baseFacts: true,
    landUse: true,
    acreage: true,
    zoning: false,
    envelope: false,
  },
  provenance: { parcelSource: "txgio", landUseGateBlocked: false },
  bakedAt: "2026-07-20T22:34:46.946Z",
};

/** Comal honest-absence node — land-use legitimately absent (no CAD roll). */
const COMAL_NODE_ID = "48091:99999";
const comalPayload = {
  facetSchemaVersion: "node-facets-tier1-v1",
  tier: 1,
  parcelNodeId: COMAL_NODE_ID,
  countyFips: "48091",
  countyName: "Comal",
  baseFacts: {
    apn: "99999",
    situsAddress: "1 EXAMPLE RD",
    situsCity: "NEW BRAUNFELS",
    situsState: "TX",
    landUse: null,
    acreage: { value: 1.0, sqft: 43560, method: "shoelace-wgs84" },
  },
  zoning: null,
  envelope: { status: "declined", confidence: 0, declineReason: "no-setback-table" },
  facetCoverage: {
    baseFacts: true,
    landUse: false,
    acreage: true,
    zoning: false,
    envelope: false,
  },
  provenance: { parcelSource: "txgio", landUseGateBlocked: false },
  bakedAt: "2026-07-20T22:34:46.946Z",
};

describe.skipIf(!hasDb)("node-facet read endpoint (integration)", () => {
  beforeAll(async () => {
    if (!ctx.schema) return;
    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(
      join(here, "../../../../lib/db/drizzle/0030_place_layer_snapshots.sql"),
      "utf8",
    );
    await ctx.schema.pool.query(sql);
  });

  beforeEach(async () => {
    await dbMod.db.insert(placeLayerSnapshots).values([
      {
        placeKey: placeKeyForNode(BAKED_NODE_ID),
        adapterKey: TIER1_ADAPTER_KEY,
        latRounded: "30.04220",
        lngRounded: "-97.67650",
        payloadJson: bakedPayload,
        contentHash: "test-hash-baked",
      },
      {
        placeKey: placeKeyForNode(COMAL_NODE_ID),
        adapterKey: TIER1_ADAPTER_KEY,
        latRounded: "29.70300",
        lngRounded: "-98.12400",
        payloadJson: comalPayload,
        contentHash: "test-hash-comal",
      },
    ]);
  });

  afterEach(async () => {
    if (!ctx.schema) return;
    await truncateAll(ctx.schema.pool, ["place_layer_snapshots"]);
  });

  it("returns a baked node's facets ANONYMOUSLY (no API key) and OMITS owner", async () => {
    // NO auth header at all — browse is public-tier.
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(BAKED_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);
    expect(res.body.parcelNodeId).toBe(BAKED_NODE_ID);
    expect(res.body.source).toBe("baked-snapshot");
    expect(res.body.adapterKey).toBe(TIER1_ADAPTER_KEY);

    // Real facets are present.
    expect(res.body.facets.baseFacts.apn).toBe("10068");
    expect(res.body.facets.baseFacts.landUse.code).toBe("A1");
    expect(res.body.facets.baseFacts.acreage.value).toBeCloseTo(0.2388);
    expect(res.body.facets.facetCoverage.landUse).toBe(true);

    // OWNER LEAK GUARD — no owner key anywhere, no owner value anywhere.
    expect(payloadHasOwnerKey(res.body.facets)).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/owner/i);
    expect(JSON.stringify(res.body)).not.toMatch(/SHOULD NOT LEAK/);
  });

  it("serves honest absence (Comal land-use null) verbatim, not a fake value", async () => {
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(COMAL_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);
    // land-use is honestly absent — null, coverage:false — never fabricated.
    expect(res.body.facets.baseFacts.landUse).toBeNull();
    expect(res.body.facets.facetCoverage.landUse).toBe(false);
    // envelope declined honestly (still a legible state for the card).
    expect(res.body.facets.envelope.status).toBe("declined");
    // Facets that DO resolve are still present.
    expect(res.body.facets.baseFacts.acreage.value).toBe(1.0);
  });

  it("404s an un-baked node so the web app can fall back to live", async () => {
    const res = await request(getApp()).get(
      "/api/brokerage/v1/place/node/48055:00000/facets",
    );
    expect(res.status).toBe(404);
  });

  it("400s a malformed node id", async () => {
    const res = await request(getApp()).get(
      "/api/brokerage/v1/place/node/not-a-node/facets",
    );
    expect(res.status).toBe(400);
  });
});
