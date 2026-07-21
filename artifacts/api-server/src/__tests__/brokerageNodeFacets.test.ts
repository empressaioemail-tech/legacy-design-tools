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
  extractTier2Overlay,
} from "../routes/brokerageNodeFacets";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";

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

describe("extractTier2Overlay (the card's FEMA flood read, pure)", () => {
  it("pulls flood + envelope + bakedAt from a real Tier-2 payload", () => {
    const tier2Payload = {
      facetSchemaVersion: "node-facets-tier2-v1",
      tier: 2,
      parcelNodeId: "48055:10068",
      countyFips: "48055",
      countyName: "Caldwell",
      envelope: { status: "declined", edgeSignal: "shape" },
      flood: {
        status: "in-sfha",
        floodZone: "AE",
        inSpecialFloodHazardArea: true,
        provenance: { source: "fema-nfhl", vintage: "2026-07-21T00:00:00.000Z" },
      },
      bakedAt: "2026-07-21T00:00:00.000Z",
    };
    const overlay = extractTier2Overlay(tier2Payload, new Date("2026-07-21T00:00:00.000Z"));
    expect(overlay).not.toBeNull();
    expect((overlay!.flood as Record<string, unknown>).status).toBe("in-sfha");
    expect((overlay!.flood as Record<string, unknown>).floodZone).toBe("AE");
    expect(overlay!.envelope).not.toBeNull();
    expect(overlay!.snapshotAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("surfaces an honest-absence flood (unavailable) verbatim, never a fabricated zone", () => {
    const overlay = extractTier2Overlay(
      {
        flood: {
          status: "unavailable",
          floodZone: null,
          provenance: { source: "fema-nfhl", unavailableReason: "FEMA NFHL fetch failed" },
        },
      },
      null,
    );
    expect(overlay).not.toBeNull();
    expect((overlay!.flood as Record<string, unknown>).status).toBe("unavailable");
    expect((overlay!.flood as Record<string, unknown>).floodZone).toBeNull();
  });

  it("returns null for a payload with no flood facet (malformed/legacy row)", () => {
    expect(extractTier2Overlay({ tier: 2, envelope: {} }, null)).toBeNull();
    expect(extractTier2Overlay(null, null)).toBeNull();
    expect(extractTier2Overlay("not-an-object", null)).toBeNull();
  });
});

// -------------------------------------------------------------------------
// 1b. BOOT-PROOF regression — the anonymous read route must NOT pull the
//     Tier-1 bake CLI into the server boot graph. The CLI's `main()` runs on
//     import in the prod bundle (its entrypoint guard misfires), errors
//     `--county=<fips> is required`, and `process.exit(1)` before the server
//     can listen on PORT 8080. This crashed the deployed cortex-api. The route
//     now imports TIER1_ADAPTER_KEY from a side-effect-free constants module
//     instead, so its module graph is CLI-free.
// -------------------------------------------------------------------------

describe("brokerageNodeFacets boot-proof (no bake CLI on the boot graph)", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it("the route source imports zero *Cli module (static guarantee)", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    // No import/re-export from any `...Cli` module — that is the whole fix.
    expect(routeSrc).not.toMatch(/from\s+["'][^"']*Cli["']/);
    // And it pulls BOTH adapter keys from the side-effect-free constants
    // modules (Tier 1 base + Tier 2 flood overlay), never the bake CLIs.
    expect(routeSrc).toMatch(
      /from\s+["']\.\.\/lib\/nodeFacetTier1Constants["']/,
    );
    expect(routeSrc).toMatch(
      /from\s+["']\.\.\/lib\/nodeFacetTier2Constants["']/,
    );
  });

  it("importing the route module emits no bake output and does not exit", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code}) was called on route import`);
      }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // Fresh evaluation of the route module graph — must not run the bake.
      await vi.resetModules();
      await import("../routes/brokerageNodeFacets");

      const allOutput = [...errSpy.mock.calls, ...logSpy.mock.calls]
        .map((args) => args.join(" "))
        .join("\n");
      expect(allOutput).not.toContain("[node-facet-bake-t1]");
      expect(allOutput).not.toContain("--county");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("the constants module carries the unchanged deployed adapter_key", () => {
    // Value integrity: deployed place_layer_snapshots rows use this exact key.
    expect(TIER1_ADAPTER_KEY).toBe("node-facets:tier1");
    // The Tier-2 bake writes rows under this exact key; the read composes them.
    expect(TIER2_ADAPTER_KEY).toBe("node-facets:tier2");
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

/** A Tier-2 flood overlay for the BAKED node — a real in-SFHA FEMA hit, with a
 * deliberately-injected owner key to prove the strip runs over the overlay too
 * (the real Tier-2 bake never writes one). */
const tier2FloodPayload = {
  facetSchemaVersion: "node-facets-tier2-v1",
  tier: 2,
  parcelNodeId: BAKED_NODE_ID,
  countyFips: "48055",
  countyName: "Caldwell",
  envelope: { status: "declined", edgeSignal: "shape", roadsPending: false },
  flood: {
    status: "in-sfha",
    floodZone: "AE",
    inSpecialFloodHazardArea: true,
    zoneSubtype: "FLOODWAY",
    baseFloodElevation: 512.4,
    provenance: {
      source: "fema-nfhl",
      adapterKey: "fema:nfhl-flood-zone",
      layer: "flood-hazard-zones",
      vintage: "2026-07-21T00:00:00.000Z",
    },
  },
  provenance: { roadsPending: false, floodSource: "fema-nfhl" },
  // Injected — must be stripped by the route.
  owner_name: "TIER2 PRIVATE OWNER SHOULD NOT LEAK",
  bakedAt: "2026-07-21T00:00:00.000Z",
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
        // The Tier-2 flood overlay for the SAME node (separate adapter key).
        placeKey: placeKeyForNode(BAKED_NODE_ID),
        adapterKey: TIER2_ADAPTER_KEY,
        latRounded: "30.04220",
        lngRounded: "-97.67650",
        payloadJson: tier2FloodPayload,
        contentHash: "test-hash-tier2",
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

  it("composes the Tier-2 FEMA flood overlay onto the card's read (real per-node zone)", async () => {
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(BAKED_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);
    // The Tier-2 overlay the card + the map's "FEMA flood zone" layer consume.
    expect(res.body.tier2).not.toBeNull();
    expect(res.body.tier2.flood.status).toBe("in-sfha");
    expect(res.body.tier2.flood.floodZone).toBe("AE");
    expect(res.body.tier2.flood.inSpecialFloodHazardArea).toBe(true);
    // Carries the FEMA vintage so the card can cite it (commitment #1).
    expect(res.body.tier2.flood.provenance.source).toBe("fema-nfhl");
    expect(res.body.tier2.flood.provenance.vintage).toBe(
      "2026-07-21T00:00:00.000Z",
    );
    // Tier-1 base still present alongside the overlay.
    expect(res.body.facets.baseFacts.landUse.code).toBe("A1");
    // OWNER LEAK GUARD extends to the overlay — the injected Tier-2 owner is gone.
    expect(payloadHasOwnerKey(res.body.tier2)).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/SHOULD NOT LEAK/);
  });

  it("returns tier2:null for a node with a Tier-1 row but no Tier-2 flood overlay yet", async () => {
    // Comal has only a Tier-1 row — the card renders the base unchanged, no flood.
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(COMAL_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);
    expect(res.body.tier2).toBeNull();
    // Base facets are still fully served.
    expect(res.body.facets.baseFacts.acreage.value).toBe(1.0);
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
