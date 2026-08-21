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
  disposeTier2Flood,
  TIER2_FLOOD_PRODUCERS,
} from "../routes/brokerageNodeFacets";
import { TIER1_ADAPTER_KEY } from "../lib/nodeFacetTier1Constants";
import { TIER2_ADAPTER_KEY } from "../lib/nodeFacetTier2Constants";
import {
  memoryFloodHazardAtoms,
  resetFloodHazardAtomQueryableForTests,
  setFloodHazardAtomQueryableForTests,
} from "../lib/floodHazardFactRead";
import {
  memoryLandUseFactAtoms,
  resetLandUseFactAtomQueryableForTests,
  setLandUseFactAtomQueryableForTests,
} from "../lib/landUseFactRead";

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
// SS-W16 (2026-08-19) — the Tier-2 flood facet is RETIRED at the read path.
//
// Every case below is seeded with a value the OLD code served, so each one is
// a known violation the new guard has to refuse. The in-SFHA "AE" payload is
// the exact shape that was live on the anonymous route; if any of these start
// returning a determination again, these tests go red.
// -------------------------------------------------------------------------

/** The real shape the Tier-2 bake writes — a determination, with its producer. */
const RETIRED_FLOOD_FACET = {
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
};

describe("extractTier2Overlay — flood is refused, never served (SS-W16)", () => {
  it("refuses a REAL in-SFHA determination and puts no value on the wire", () => {
    const tier2Payload = {
      facetSchemaVersion: "node-facets-tier2-v1",
      tier: 2,
      parcelNodeId: "48055:10068",
      countyFips: "48055",
      countyName: "Caldwell",
      envelope: { status: "declined", edgeSignal: "shape" },
      flood: RETIRED_FLOOD_FACET,
      bakedAt: "2026-07-21T00:00:00.000Z",
    };
    const overlay = extractTier2Overlay(
      tier2Payload,
      new Date("2026-07-21T00:00:00.000Z"),
    );
    expect(overlay).not.toBeNull();
    expect(overlay!.flood).toBeNull();

    // The refusal names the retired instrument and its replacement.
    expect(overlay!.floodDisposition.state).toBe("refused");
    expect(overlay!.floodDisposition.code).toBe("retired-instrument");
    expect(overlay!.floodDisposition.producer).toBe("fema:nfhl-flood-zone");

    // NOTHING of the determination survives serialization — not the zone code,
    // not the SFHA flag, not the FEMA vintage. This is the assertion that would
    // catch a partial strip that left a value nested somewhere.
    const wire = JSON.stringify(overlay);
    expect(wire).not.toContain("in-sfha");
    expect(wire).not.toContain('"AE"');
    expect(wire).not.toContain("inSpecialFloodHazardArea");
    expect(wire).not.toContain("FLOODWAY");
    expect(wire).not.toContain("512.4");

    // Anti-zombie: Tier-2 envelope is still never product truth on the wire.
    expect(overlay!.envelope).toBeNull();
    expect(overlay!.snapshotAt).toBe("2026-07-21T00:00:00.000Z");
  });

  it("refuses the 'outside-sfha' answer too — the 1,995-parcel failure mode", () => {
    // The adjudication found 1,995 parcels told they were OUTSIDE a Special
    // Flood Hazard Area whose centroid is inside one. A false negative is the
    // dangerous direction, so it must be refused exactly as loudly as a hit.
    const overlay = extractTier2Overlay(
      {
        flood: {
          status: "outside-sfha",
          floodZone: null,
          inSpecialFloodHazardArea: false,
          provenance: {
            source: "fema-nfhl",
            adapterKey: "fema:nfhl-flood-zone",
            layer: "flood-hazard-zones",
            vintage: "2026-07-21T00:00:00.000Z",
          },
        },
      },
      null,
    );
    expect(overlay!.flood).toBeNull();
    expect(overlay!.floodDisposition.code).toBe("retired-instrument");
    expect(JSON.stringify(overlay)).not.toContain("inSpecialFloodHazardArea");
  });

  it("FAILS CLOSED on an unrecognised producer rather than passing it through", () => {
    // A facet from an instrument nobody has ruled on must not be served on the
    // grounds that it is merely not the retired one. Refusal is the default.
    const overlay = extractTier2Overlay(
      {
        flood: {
          status: "in-sfha",
          floodZone: "VE",
          provenance: { source: "somewhere", adapterKey: "some:new-adapter" },
        },
      },
      null,
    );
    expect(overlay!.flood).toBeNull();
    expect(overlay!.floodDisposition.code).toBe("unrecognised-producer");
    expect(overlay!.floodDisposition.producer).toBe("some:new-adapter");
    expect(JSON.stringify(overlay)).not.toContain('"VE"');
  });

  it("FAILS CLOSED when the facet declares no producer at all", () => {
    const overlay = extractTier2Overlay(
      { flood: { status: "in-sfha", floodZone: "AO" } },
      null,
    );
    expect(overlay!.flood).toBeNull();
    expect(overlay!.floodDisposition.code).toBe("unrecognised-producer");
    expect(overlay!.floodDisposition.producer).toBeNull();
    expect(JSON.stringify(overlay)).not.toContain('"AO"');
  });

  it("distinguishes 'row exists, flood refused' from 'no Tier-2 row at all'", () => {
    // Three states, never collapsed into one. A row with no flood facet is a
    // THIRD thing again: it reports no-flood-facet, not a retirement.
    const noFacet = extractTier2Overlay({ tier: 2, envelope: {} }, null);
    expect(noFacet).not.toBeNull();
    expect(noFacet!.flood).toBeNull();
    expect(noFacet!.floodDisposition.code).toBe("no-flood-facet");

    // No row at all -> no overlay. This is the only null the route emits.
    expect(extractTier2Overlay(null, null)).toBeNull();
    expect(extractTier2Overlay("not-an-object", null)).toBeNull();
  });

  it("disposeTier2Flood is TOTAL — no SNAPSHOT input yields a value (SS-W16 stays)", () => {
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      "",
      "AE",
      [],
      [RETIRED_FLOOD_FACET],
      {},
      { provenance: null },
      { provenance: {} },
      { provenance: { adapterKey: "" } },
      { provenance: { adapterKey: "  fema:nfhl-flood-zone  " } },
      { provenance: { adapterKey: "fema:nfhl-flood-zone-v2" } },
      { provenance: { adapterKey: "prefix/fema:nfhl-flood-zone" } },
      RETIRED_FLOOD_FACET,
    ];
    for (const input of inputs) {
      const disposition = disposeTier2Flood(input);
      expect(disposition.state).toBe("refused");
    }
    // Exact equality, not substring: a key that merely CONTAINS the retired one
    // is unrecognised, and a padded exact key is still the retired one.
    expect(
      disposeTier2Flood({ provenance: { adapterKey: "fema:nfhl-flood-zone-v2" } })
        .code,
    ).toBe("unrecognised-producer");
    expect(
      disposeTier2Flood({
        provenance: { adapterKey: "prefix/fema:nfhl-flood-zone" },
      }).code,
    ).toBe("unrecognised-producer");
    expect(
      disposeTier2Flood({
        provenance: { adapterKey: "  fema:nfhl-flood-zone  " },
      }).code,
    ).toBe("retired-instrument");
  });

  it("the recognised-producer set is closed and holds exactly the retired one", () => {
    // If this grows, disposeTier2Flood's switch must grow with it or the build
    // fails at its `never` assignment. This assertion makes the intent explicit
    // so a future reader does not widen the set casually.
    expect([...TIER2_FLOOD_PRODUCERS]).toEqual(["fema:nfhl-flood-zone"]);
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

  it("the route source wires floodHazardFact from atoms and keeps flood: null", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(
      /from\s+["']\.\.\/lib\/floodHazardFactRead["']/,
    );
    expect(routeSrc).toMatch(/loadFloodHazardFactAtom/);
    expect(routeSrc).toMatch(/floodHazardFact/);
    // SS-W16 floor: the CI gate requires these two markers in this file.
    expect(routeSrc).toMatch(/flood:\s*null;/);
    expect(routeSrc).toMatch(/flood:\s*null,/);
    expect(routeSrc).not.toMatch(/flood:\s*p\.flood/);
  });

  it("the route source wires landUseFact from atoms and keeps baked landUse", () => {
    const routeSrc = readFileSync(
      join(here, "..", "routes", "brokerageNodeFacets.ts"),
      "utf8",
    );
    expect(routeSrc).toMatch(
      /from\s+["']\.\.\/lib\/landUseFactRead["']/,
    );
    expect(routeSrc).toMatch(/loadLandUseFactAtom/);
    expect(routeSrc).toMatch(/landUseFact/);
    expect(routeSrc).not.toMatch(/from\s+["'][^"']*cad_property[^"']*["']/i);
    expect(routeSrc).not.toMatch(/\.from\(\s*cad_property/i);
    expect(routeSrc).not.toMatch(/landUseFact\s*=\s*.*baseFacts\.landUse/);
  });
});

// -------------------------------------------------------------------------
// 2. Integration tests — seed a baked row, hit the anonymous endpoint.
// -------------------------------------------------------------------------

const hasDb =
  Boolean(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL) &&
  process.env.VITEST_DATABASE_STUB !== "1";

// NB: do NOT destructure `db` here — the mocked `db` is a getter that throws
// until ctx.schema is set (inside setupRouteTests' beforeAll). Destructuring at
// module scope would invoke the getter too early. `placeLayerSnapshots` is a
// plain export, safe to destructure; `db` is read lazily inside the hooks.
const dbMod = await import("@workspace/db");
const { placeLayerSnapshots } = dbMod;
const { setupRouteTests } = await import("./setup");
const { truncateAll } = await import("@workspace/db/testing");

let getApp: () => Express;
if (hasDb) {
  setupRouteTests((g) => {
    getApp = g;
  });
}

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
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    setLandUseFactAtomQueryableForTests(memoryLandUseFactAtoms([]));
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
    resetFloodHazardAtomQueryableForTests();
    resetLandUseFactAtomQueryableForTests();
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

  it("REFUSES the snapshot flood facet even though a real in-SFHA row is seeded", async () => {
    // No atom fixture: the atoms path must name the miss, not copy the snapshot.
    setFloodHazardAtomQueryableForTests(memoryFloodHazardAtoms([]));
    // The seeded Tier-2 row is a genuine in-SFHA "AE" determination — the exact
    // shape that was live on this anonymous route before SS-W16. The endpoint
    // must return 200 with every other facet intact and NO snapshot flood value.
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(BAKED_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);

    // The overlay still exists (the row exists) but carries no determination.
    expect(res.body.tier2).not.toBeNull();
    expect(res.body.tier2.flood).toBeNull();
    expect(res.body.tier2.floodDisposition.state).toBe("refused");
    expect(res.body.tier2.floodDisposition.code).toBe("retired-instrument");
    expect(res.body.tier2.floodDisposition.producer).toBe(
      "fema:nfhl-flood-zone",
    );
    expect(res.body.tier2.floodDisposition.supersededBy).toBe(
      "flood-hazard-fact",
    );

    // SNAPSHOT tokens must not appear. These values exist only on the bake.
    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain("in-sfha");
    expect(wire).not.toContain('"AE"');
    expect(wire).not.toContain("inSpecialFloodHazardArea");
    expect(wire).not.toContain("FLOODWAY");
    expect(wire).not.toContain("512.4");

    // Atom miss is named, never a silent null.
    expect(res.body.floodHazardFact).not.toBeNull();
    expect(res.body.floodHazardFact.state).toBe("refused");
    expect(res.body.floodHazardFact.code).toBe("atom-miss");
    expect(res.body.floodHazardFact.source).toBe("flood-hazard-fact");
    expect(res.body.floodHazardFact.tried).toEqual([
      BAKED_NODE_ID,
      `${BAKED_NODE_ID}.00000000`,
    ]);

    // Land-use-fact miss is named too. Cad-roll bake stays on retiredStore.
    expect(res.body.landUseFact).not.toBeNull();
    expect(res.body.landUseFact.state).toBe("refused");
    expect(res.body.landUseFact.code).toBe("atom-miss");
    expect(res.body.landUseFact.source).toBe("land-use-fact");
    expect(res.body.landUseFact.tried).toEqual([
      BAKED_NODE_ID,
      `${BAKED_NODE_ID}.00000000`,
    ]);
    expect(res.body.landUseFact.landUseCode).toBeUndefined();
    expect(res.body.landUseFact.code).not.toBe("A1");

    // SCOPE ASSERTION — the cut is the snapshot flood facet, NOT the endpoint.
    expect(res.body.facets.baseFacts.landUse.code).toBe("A1");
    expect(res.body.facets.baseFacts.apn).toBe("10068");
    expect(res.body.facets.baseFacts.acreage.value).toBeCloseTo(0.2388);
    expect(res.body.adapterKey).toBe(TIER1_ADAPTER_KEY);
    expect(res.body.source).toBe("baked-snapshot");

    // OWNER LEAK GUARD extends to the overlay — the injected Tier-2 owner is gone.
    expect(payloadHasOwnerKey(res.body.tier2)).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/SHOULD NOT LEAK/);
  });

  it("serves a fixture flood-hazard-fact while still refusing the snapshot bake", async () => {
    // Divergence: snapshot is AE/FLOODWAY/512.4, atom is AO with no those tokens.
    // If this test passed while serving the snapshot, AO would be missing and
    // FLOODWAY would still be on the wire.
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([
        {
          entityId: `${BAKED_NODE_ID}.00000000`,
          body: {
            entityType: "flood-hazard-fact",
            atomDid: "fhfact_fedcba9876543210",
            parcelNodeId: `${BAKED_NODE_ID}.00000000`,
            sourceTier: "fema-nfhl",
            inSpecialFloodHazardArea: true,
            floodZone: "AO",
            zoneSubtype: null,
            baseFloodElevation: null,
            sourceAdapter: "fema-nfhl-bulk-v1",
            sourceVintage: "NFHL_48_20260101",
            evaluatedAt: "2026-08-11T23:13:43.774Z",
          },
        },
      ]),
    );
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(BAKED_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);

    expect(res.body.tier2.flood).toBeNull();
    expect(res.body.tier2.floodDisposition.code).toBe("retired-instrument");

    expect(res.body.floodHazardFact.state).toBe("present");
    expect(res.body.floodHazardFact.source).toBe("flood-hazard-fact");
    expect(res.body.floodHazardFact.floodZone).toBe("AO");
    expect(res.body.floodHazardFact.inSpecialFloodHazardArea).toBe(true);
    expect(res.body.floodHazardFact.boundAs).toBe(`${BAKED_NODE_ID}.00000000`);
    expect(res.body.floodHazardFact.tried).toEqual([
      BAKED_NODE_ID,
      `${BAKED_NODE_ID}.00000000`,
    ]);

    const wire = JSON.stringify(res.body);
    expect(wire).toContain('"AO"');
    expect(wire).not.toContain("FLOODWAY");
    expect(wire).not.toContain("512.4");
    expect(wire).not.toContain("in-sfha");
    expect(wire).not.toContain('"AE"');
  });

  it("gold parcel 48021:34137 dual-grammar bind yields the fixture atom", async () => {
    const gold = "48021:34137";
    await dbMod.db.insert(placeLayerSnapshots).values({
      placeKey: placeKeyForNode(gold),
      adapterKey: TIER1_ADAPTER_KEY,
      latRounded: "30.11000",
      lngRounded: "-97.31500",
      payloadJson: {
        ...bakedPayload,
        parcelNodeId: gold,
        countyFips: "48021",
        countyName: "Bastrop",
      },
      contentHash: "test-hash-gold",
    });
    setFloodHazardAtomQueryableForTests(
      memoryFloodHazardAtoms([
        {
          entityId: gold,
          body: {
            entityType: "flood-hazard-fact",
            atomDid: "fhfact_4802134137aaaaaa",
            parcelNodeId: gold,
            sourceTier: "fema-nfhl",
            inSpecialFloodHazardArea: false,
            floodZone: "X",
            sourceAdapter: "fema-nfhl-bulk-v1",
            sourceVintage: "NFHL_48_20260101",
            evaluatedAt: "2026-08-11T23:13:43.774Z",
          },
        },
      ]),
    );
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(gold)}/facets`,
    );
    expect(res.status).toBe(200);
    expect(res.body.floodHazardFact.state).toBe("present");
    expect(res.body.floodHazardFact.floodZone).toBe("X");
    expect(res.body.floodHazardFact.source).toBe("flood-hazard-fact");
    expect(res.body.tier2).toBeNull();
  });

  it("serves a fixture land-use-fact while keeping baked cad-roll landUse as retiredStore", async () => {
    // Divergence: bake is A1 / Single-family residential / cad-roll.
    // Atom is C1 / Vacant commercial on ${parcel}:2025. If landUseFact copied
    // the bake, landUseCode would be missing and code would be A1.
    setLandUseFactAtomQueryableForTests(
      memoryLandUseFactAtoms([
        {
          entityId: `${BAKED_NODE_ID}:2025`,
          body: {
            entityType: "land-use-fact",
            atomDid: "lufact_fedcba9876543210",
            parcelNodeId: BAKED_NODE_ID,
            taxYear: 2025,
            sourceTier: "cad-authoritative",
            landUseCode: "C1",
            landUseLabel: "Vacant commercial",
            sourceAdapter: "cad-roll-v1",
            sourceVintage: "2025-caldwell-cad-export",
            evaluatedAt: "2026-08-11T23:13:43.774Z",
          },
        },
      ]),
    );
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(BAKED_NODE_ID)}/facets`,
    );
    expect(res.status).toBe(200);

    expect(res.body.landUseFact.state).toBe("present");
    expect(res.body.landUseFact.source).toBe("land-use-fact");
    expect(res.body.landUseFact.landUseCode).toBe("C1");
    expect(res.body.landUseFact.landUseLabel).toBe("Vacant commercial");
    expect(res.body.landUseFact.taxYear).toBe(2025);
    expect(res.body.landUseFact.boundAs).toBe(`${BAKED_NODE_ID}:2025`);
    expect(res.body.landUseFact.tried).toEqual([
      BAKED_NODE_ID,
      `${BAKED_NODE_ID}.00000000`,
    ]);
    expect(res.body.landUseFact.code).toBeUndefined();
    expect(res.body.landUseFact.description).toBeUndefined();

    expect(res.body.facets.baseFacts.landUse.code).toBe("A1");
    expect(res.body.facets.baseFacts.landUse.description).toBe(
      "Single-family residential",
    );
    expect(res.body.facets.baseFacts.landUse.source).toBe("cad-roll");
  });

  it("gold parcel 48021:34137 dual-grammar prefix bind yields the :2025 fixture atom", async () => {
    const gold = "48021:34137";
    await dbMod.db.insert(placeLayerSnapshots).values({
      placeKey: placeKeyForNode(gold),
      adapterKey: TIER1_ADAPTER_KEY,
      latRounded: "30.11000",
      lngRounded: "-97.31500",
      payloadJson: {
        ...bakedPayload,
        parcelNodeId: gold,
        countyFips: "48021",
        countyName: "Bastrop",
      },
      contentHash: "test-hash-gold-landuse",
    });
    setLandUseFactAtomQueryableForTests(
      memoryLandUseFactAtoms([
        {
          entityId: `${gold}:2025`,
          body: {
            entityType: "land-use-fact",
            atomDid: "lufact_4802134137aaaaaa",
            parcelNodeId: gold,
            taxYear: 2025,
            sourceTier: "cad-authoritative",
            landUseCode: "A1",
            landUseLabel: "Single Family",
            sourceAdapter: "cad-roll-v1",
            sourceVintage: "2025-bastrop-cad-export",
            evaluatedAt: "2026-08-11T23:13:43.774Z",
          },
        },
      ]),
    );
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(gold)}/facets`,
    );
    expect(res.status).toBe(200);
    expect(res.body.landUseFact.state).toBe("present");
    expect(res.body.landUseFact.landUseCode).toBe("A1");
    expect(res.body.landUseFact.source).toBe("land-use-fact");
    expect(res.body.landUseFact.taxYear).toBe(2025);
    expect(res.body.landUseFact.boundAs).toBe(`${gold}:2025`);
    expect(res.body.landUseFact.tried).toEqual([
      gold,
      `${gold}.00000000`,
    ]);
  });

  it("padded gold prefix 48021:34137.00000000:2025 dual-grammar bind yields landUseCode", async () => {
    const gold = "48021:34137";
    const goldPadded = "48021:34137.00000000";
    await dbMod.db.insert(placeLayerSnapshots).values({
      placeKey: placeKeyForNode(gold),
      adapterKey: TIER1_ADAPTER_KEY,
      latRounded: "30.11000",
      lngRounded: "-97.31500",
      payloadJson: {
        ...bakedPayload,
        parcelNodeId: gold,
        countyFips: "48021",
        countyName: "Bastrop",
      },
      contentHash: "test-hash-gold-landuse-padded",
    });
    setLandUseFactAtomQueryableForTests(
      memoryLandUseFactAtoms([
        {
          entityId: `${goldPadded}:2025`,
          body: {
            entityType: "land-use-fact",
            parcelNodeId: goldPadded,
            taxYear: 2025,
            sourceTier: "cad-authoritative",
            landUseCode: "C1",
            sourceAdapter: "cad-roll-v1",
            evaluatedAt: "2026-08-11T23:13:43.774Z",
          },
        },
      ]),
    );
    const res = await request(getApp()).get(
      `/api/brokerage/v1/place/node/${encodeURIComponent(gold)}/facets`,
    );
    expect(res.status).toBe(200);
    expect(res.body.landUseFact.state).toBe("present");
    expect(res.body.landUseFact.landUseCode).toBe("C1");
    expect(res.body.landUseFact.boundAs).toBe(`${goldPadded}:2025`);
    expect(res.body.landUseFact.landUseLabel).toBeNull();
  });

  it("returns tier2:null for a node with a Tier-1 row and NO Tier-2 row at all", async () => {
    // Comal has only a Tier-1 row. `tier2: null` now means exactly one thing —
    // no Tier-2 row exists — and is distinct from the refusal above.
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
    // Anti-zombie: baked envelope stripped from the wire (atom path only).
    expect(res.body.facets.envelope).toBeNull();
    expect(res.body.facets.facetCoverage.envelope).toBe(false);
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
