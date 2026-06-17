/**
 * Brokerage V1 — workspaces, wallet paywall, admin graph.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { ctx } from "./test-context";
import { eq } from "drizzle-orm";

const TEST_API_KEY = "brokerage-test-key-ws-001";
const ADMIN_KEY = "brokerage-admin-test-key";
const OWNER_INSTALL = "install-owner-aaaaaaaa";
const COLLAB_INSTALL = "install-collab-bbbbbbbb";
const VIEWER_INSTALL = "install-viewer-cccccccc";

const geocodeAddressMock = vi.hoisted(() => vi.fn());
const retrieveAtomsForQuestionMock = vi.hoisted(() => vi.fn());
const completeChatMock = vi.hoisted(() => vi.fn());
const fetchBrokerageSiteContextMock = vi.hoisted(() => vi.fn());

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

vi.mock("@workspace/site-context/server", () => ({
  geocodeAddress: geocodeAddressMock,
}));

vi.mock("@workspace/codes", async () => {
  const actual =
    await vi.importActual<typeof import("@workspace/codes")>("@workspace/codes");
  return {
    ...actual,
    retrieveAtomsForQuestion: retrieveAtomsForQuestionMock,
    countAtomsForJurisdiction: vi.fn(async () => 10),
  };
});

vi.mock("../lib/brokerageSiteContext", () => ({
  fetchBrokerageSiteContext: fetchBrokerageSiteContextMock,
  formatSiteContextForLlm: () => "",
  formatBrokerageContextForLlm: () => "",
  stripSiteContextForClient: (ctx: {
    placeKey: string;
    layers: Array<{ payload?: unknown; [key: string]: unknown }>;
  }) => ({
    placeKey: ctx.placeKey,
    layers: ctx.layers.map(({ payload: _payload, ...layer }) => layer),
  }),
  stripBriefPayloadForClient: (brief: Record<string, unknown>) => {
    const raw = brief.siteContext as
      | {
          placeKey: string;
          layers: Array<{ payload?: unknown; [key: string]: unknown }>;
        }
      | undefined;
    if (!raw) return brief;
    return {
      ...brief,
      siteContext: {
        placeKey: raw.placeKey,
        layers: raw.layers.map(({ payload: _payload, ...layer }) => layer),
      },
    };
  },
}));

vi.mock("../lib/briefingLlmClient", async () => {
  const actual = await vi.importActual<typeof import("../lib/briefingLlmClient")>(
    "../lib/briefingLlmClient",
  );
  return {
    ...actual,
    getBriefingLlmClient: vi.fn(async () => ({
      kind: "grok" as const,
      client: { completeChat: completeChatMock },
    })),
  };
});

const { setupRouteTests } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { setBriefingLlmClient } = await import("../lib/briefingLlmClient");
const { gtmConsent } = await import("@workspace/db");
const { listingKeyFromAddress } = await import("../lib/brokerageWorkspace");

let getApp: () => Express;
setupRouteTests((g) => {
  getApp = g;
});

const authHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
  "X-Hauska-Install-Id": OWNER_INSTALL,
};

const adminHeaders = {
  Authorization: `Bearer ${TEST_API_KEY}`,
  "X-Brokerage-Admin-Key": ADMIN_KEY,
};

const mockAtom = {
  id: "did:hauska:atom:bastrop-adu-1",
  sourceName: "bastrop_municode",
  jurisdictionKey: "bastrop_tx",
  codeBook: "MUNI_CODE",
  edition: "current",
  sectionNumber: "3.2.1",
  sectionTitle: "Accessory dwelling units",
  body: "ADUs shall comply with setback requirements.",
  sourceUrl: "https://example.com/adu",
  score: 0.82,
  retrievalMode: "vector" as const,
};

beforeEach(async () => {
  process.env.BROKERAGE_API_KEYS = TEST_API_KEY;
  process.env.BROKERAGE_ADMIN_API_KEYS = ADMIN_KEY;
  process.env.BROKERAGE_WALLET_BYPASS = "0";
  process.env.BROKERAGE_WALLET_START_BALANCE_CENTS = "0";
  process.env.BROKERAGE_COMPUTE_COST_CENTS = "100";
  resetBrokerageApiKeysForTests();

  geocodeAddressMock.mockResolvedValue({
    latitude: 30.11,
    longitude: -97.32,
    jurisdictionCity: "Bastrop",
    jurisdictionState: "TX",
    jurisdictionFips: null,
    source: "nominatim",
    geocodedAt: new Date().toISOString(),
  });
  retrieveAtomsForQuestionMock.mockResolvedValue([mockAtom]);
  fetchBrokerageSiteContextMock.mockResolvedValue({ layers: [] });
  completeChatMock.mockResolvedValue(
    JSON.stringify({
      headline: "Test headline",
      body: "Test body [1].",
      answer: "Test answer [1].",
    }),
  );
  setBriefingLlmClient({
    kind: "grok",
    client: { completeChat: completeChatMock },
  });

  if (!ctx.schema) throw new Error("schema missing");
  await ctx.schema.db.insert(gtmConsent).values({
    installId: OWNER_INSTALL,
    consentVersion: "2026-05-26-v1",
    termsAcceptedAt: new Date(),
    graphOptIn: true,
    updatedAt: new Date(),
  });
});

afterEach(() => {
  delete process.env.BROKERAGE_API_KEYS;
  delete process.env.BROKERAGE_ADMIN_API_KEYS;
  delete process.env.BROKERAGE_WALLET_BYPASS;
  delete process.env.BROKERAGE_WALLET_START_BALANCE_CENTS;
  delete process.env.BROKERAGE_COMPUTE_COST_CENTS;
  resetBrokerageApiKeysForTests();
  setBriefingLlmClient(null);
});

describe("brokerage brief response shape", () => {
  const fatLayerPayload = {
    parcel: {
      type: "FeatureCollection",
      features: Array.from({ length: 80 }, (_, i) => ({
        type: "Feature",
        properties: { blob: "x".repeat(400), idx: i },
      })),
    },
  };

  it("returns workspaceId matching recent list and omits layer payloads", async () => {
    fetchBrokerageSiteContextMock.mockResolvedValue({
      placeKey: "coord:30.50000:-97.60000",
      layers: [
        {
          layerKind: "regrid-parcel",
          adapterKey: "regrid:parcels",
          tier: "national",
          status: "ok",
          provider: "regrid",
          summary: "APN R123 · 0.25 ac · Residential",
          payload: fatLayerPayload,
        },
        {
          layerKind: "fema-nfhl",
          adapterKey: "federal:fema-nfhl",
          tier: "federal",
          status: "ok",
          provider: "FEMA NFHL",
          summary: "Zone X — minimal flood hazard",
          payload: { floodZone: "X", geometry: fatLayerPayload.parcel },
        },
      ],
    });

    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });

    const address = "1904 Heathwood Cir, Round Rock, TX 78664";
    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address,
        page_url: "https://zillow.com/homedetails/round-rock",
      });
    expect(brief.status).toBe(200);
    expect(brief.body.workspaceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(brief.body.workspaceDid).toMatch(
      /^did:hauska:property-workspace:/,
    );

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(authHeaders);
    expect(recent.status).toBe(200);
    expect(recent.body.workspaces[0].id).toBe(brief.body.workspaceId);

    const listingKey = listingKeyFromAddress(address);
    expect(brief.body.workspaceDid).toBe(
      `did:hauska:property-workspace:${listingKey}`,
    );

    for (const layer of brief.body.siteContext.layers) {
      expect(layer).not.toHaveProperty("payload");
      expect(layer.summary).toBeTruthy();
      expect(layer.status).toBe("ok");
      expect(layer.layerKind).toBeTruthy();
      expect(layer.provider).toBeTruthy();
    }

    const fullSize = Buffer.byteLength(
      JSON.stringify({
        ...brief.body,
        siteContext: {
          ...brief.body.siteContext,
          layers: brief.body.siteContext.layers.map(
            (layer: { layerKind: string }, i: number) => ({
              ...layer,
              payload:
                i === 0 ? fatLayerPayload : { floodZone: "X", geometry: fatLayerPayload.parcel },
            }),
          ),
        },
      }),
      "utf8",
    );
    const clientSize = Buffer.byteLength(JSON.stringify(brief.body), "utf8");
    expect(clientSize).toBeLessThan(fullSize * 0.2);
    expect(clientSize).toBeLessThan(80_000);

    const workspace = await request(getApp())
      .get(`/api/brokerage/v1/workspaces/${brief.body.workspaceId}`)
      .set(authHeaders);
    expect(workspace.status).toBe(200);
    for (const layer of workspace.body.brief.siteContext.layers) {
      expect(layer).not.toHaveProperty("payload");
    }
  });
});

describe("brokerage wallet paywall", () => {
  it("blocks brief at zero balance but allows workspace read", async () => {
    const blocked = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        page_url: "https://matrix.example/listing/1",
      });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error).toBe("insufficient_balance");

    const topUp = await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });
    expect(topUp.status).toBe(200);
    expect(topUp.body.wallet.balanceCents).toBe(500);

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "251 Cool Water Dr, Bastrop, TX 78602",
        page_url: "https://matrix.example/listing/1",
      });
    expect(brief.status).toBe(200);

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(authHeaders);
    expect(recent.status).toBe(200);
    expect(recent.body.workspaces.length).toBeGreaterThan(0);
    expect(recent.body.workspaces[0].sourceListingUrl).toBe(
      "https://matrix.example/listing/1",
    );

    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });
    const drain = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({ address: "999 Other St, Bastrop, TX 78602" });
    expect(drain.status).toBe(200);

    const read = await request(getApp())
      .get(`/api/brokerage/v1/workspaces/${recent.body.workspaces[0].id}`)
      .set(authHeaders);
    expect(read.status).toBe(200);
    expect(read.body.brief).toBeTruthy();
  });
});

describe("brokerage workspace attachments and share", () => {
  it("CRUD attachments and collaborator read via share token", async () => {
    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "100 Share Ln, Bastrop, TX 78602",
        page_url: "https://zillow.com/homedetails/share",
      });
    expect(brief.status).toBe(200);

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(authHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    const note = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/attachments`)
      .set(authHeaders)
      .send({ kind: "note", body: "Buyer asked about pool setback." });
    expect(note.status).toBe(201);

    const link = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/attachments`)
      .set(authHeaders)
      .send({
        kind: "link",
        uri: "https://example.com/flood-map",
        title: "FEMA map",
      });
    expect(link.status).toBe(201);

    const list = await request(getApp())
      .get(`/api/brokerage/v1/workspaces/${workspaceId}/attachments`)
      .set(authHeaders);
    expect(list.body.attachments).toHaveLength(2);

    const share = await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(authHeaders)
      .send({ collaboratorInstallId: COLLAB_INSTALL });
    expect(share.status).toBe(201);

    const collabRead = await request(getApp())
      .get(
        `/api/brokerage/v1/workspaces/shared/${share.body.shareToken}`,
      )
      .set({
        Authorization: `Bearer ${TEST_API_KEY}`,
        "X-Hauska-Install-Id": VIEWER_INSTALL,
      });
    expect(collabRead.status).toBe(200);
    expect(collabRead.body.attachments).toHaveLength(2);
    expect(collabRead.body.brief).toBeTruthy();

    await request(getApp())
      .delete(
        `/api/brokerage/v1/workspaces/${workspaceId}/attachments/${note.body.id}`,
      )
      .set(authHeaders);
    const afterDelete = await request(getApp())
      .get(`/api/brokerage/v1/workspaces/${workspaceId}/attachments`)
      .set(authHeaders);
    expect(afterDelete.body.attachments).toHaveLength(1);
  });
});

describe("brokerage wallet auto-refill", () => {
  it("auto-refills $5 before compute when balance is zero", async () => {
    await request(getApp())
      .post("/api/brokerage/v1/wallet/settings")
      .set(authHeaders)
      .send({ autoRefillEnabled: true });

    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });

    if (!ctx.schema) throw new Error("schema missing");
    const { brokerageWallets } = await import("@workspace/db");
    await ctx.schema.db
      .update(brokerageWallets)
      .set({ balanceCents: 0 })
      .where(eq(brokerageWallets.installId, OWNER_INSTALL));

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({ address: "51 Refill Rd, Bastrop, TX 78602" });
    expect(brief.status).toBe(200);

    const wallet = await request(getApp())
      .get("/api/brokerage/v1/wallet")
      .set(authHeaders);
    expect(wallet.body.balanceCents).toBe(400);
    expect(wallet.body.autoRefillEnabled).toBe(true);
  });
});

describe("brokerage admin graph", () => {
  it("returns consent-filtered nodes and share edges", async () => {
    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set(authHeaders)
      .send({ amountCents: 500 });

    const brief = await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set(authHeaders)
      .send({
        address: "77 Graph Ave, Bastrop, TX 78602",
        page_url: "https://matrix.example/g",
      });
    expect(brief.status).toBe(200);

    const recent = await request(getApp())
      .get("/api/brokerage/v1/workspaces/recent")
      .set(authHeaders);
    const workspaceId = recent.body.workspaces[0].id;

    await request(getApp())
      .post(`/api/brokerage/v1/workspaces/${workspaceId}/share`)
      .set(authHeaders)
      .send({});

    const graph = await request(getApp())
      .get("/api/brokerage/v1/admin/graph")
      .set(adminHeaders);
    expect(graph.status).toBe(200);
    expect(graph.body.consentFiltered).toBe(true);
    expect(graph.body.nodes.length).toBeGreaterThan(0);
    expect(graph.body.edges.length).toBeGreaterThan(0);
  });

  it("excludes non-opted-in installs from graph", async () => {
    const NO_OPT = "install-no-opt-dddddddd";
    if (!ctx.schema) throw new Error("schema missing");
    await ctx.schema.db.insert(gtmConsent).values({
      installId: NO_OPT,
      consentVersion: "2026-05-26-v1",
      termsAcceptedAt: new Date(),
      graphOptIn: false,
      updatedAt: new Date(),
    });

    await request(getApp())
      .post("/api/brokerage/v1/wallet/top-up")
      .set({
        Authorization: `Bearer ${TEST_API_KEY}`,
        "X-Hauska-Install-Id": NO_OPT,
      })
      .send({ amountCents: 500 });

    await request(getApp())
      .post("/api/brokerage/v1/brief")
      .set({
        Authorization: `Bearer ${TEST_API_KEY}`,
        "X-Hauska-Install-Id": NO_OPT,
      })
      .send({ address: "88 Private Rd, Bastrop, TX 78602" });

    const graph = await request(getApp())
      .get("/api/brokerage/v1/admin/graph")
      .set(adminHeaders);

    expect(graph.status).toBe(200);
    const nodeIds = graph.body.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds.some((id: string) => id.startsWith(NO_OPT.slice(0, 12)))).toBe(
      false,
    );
  });
});
