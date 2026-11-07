/**
 * Browser-proxy end-user identity — no database.
 *
 * DEFECT (live, 2026-10-13): the hauska-map proxy (`api/spine.ts`) attached
 * the cortex SERVICE_API_KEY to every browser request and forwarded no end
 * user. That key is a service caller and resolves to the Max package tier,
 * so an anonymous POST through smartsite.cloud got every Max map-data layer
 * (W3 measured: `packageTier: "max"` on parcels, fema and the
 * motivated-seller composite, the last carrying owner mailing addresses and
 * homestead exemptions on 172 features).
 *
 * The proxy now presents its OWN key (BROWSER_PROXY_API_KEYS). These cases
 * pin: an anonymous proxy request gets the PUBLIC tier; a forged end-user
 * context without the proxy key is refused; the proxy key can never become
 * a service caller; and SERVICE_API_KEY callers (smartsite-mcp,
 * hauska-mcp-server, workers, the console) are unchanged.
 *
 * The signed-in Solo / Studio matrix needs the PE entitlement tables and
 * runs in browserProxyEndUserTiers.test.ts (DB-backed). Synthetic only.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import type { Express, Request, Response } from "express";

const SERVICE_TOKEN = "test-service-token-browser-proxy";
const PROXY_KEY = "test-browser-proxy-key";
const PROXY_KEY_ROTATED = "test-browser-proxy-key-next";
const BROKERAGE_KEY = "brokerage-test-key-browser-proxy";
const MAX_INSTALL = "install-browser-proxy-max";
const SYNTH = "SYNTHETIC-GATED-VALUE";

function synthParcel(id: string) {
  return {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    properties: {
      provider: "txgio",
      countyFips: "48999",
      apn: id,
      parcel_node_id: `48999:${id}`,
      situsAddress: "1 SYNTHETIC WAY",
      owner: SYNTH,
      ownerMailingAddress: SYNTH,
      landUseCode: "A1",
    },
  };
}

vi.mock("../lib/brokerageGisLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisLayers")
  >("../lib/brokerageGisLayers");
  return {
    ...actual,
    queryGisLayerGeoJson: vi.fn(async (input: { layer: string }) => ({
      layer: input.layer,
      provider: "synthetic",
      adapterKey: `synthetic:${input.layer}`,
      serviceUrl: "https://synthetic.invalid",
      featureCount: 2,
      queryMode: "bbox",
      geojson: {
        type: "FeatureCollection",
        features: [synthParcel("1"), synthParcel("2")],
      },
    })),
  };
});

vi.mock("../lib/brokerageGisCompositeLayers", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/brokerageGisCompositeLayers")
  >("../lib/brokerageGisCompositeLayers");
  return {
    ...actual,
    queryCompositeLayer: vi.fn(async () => ({
      payload: { geojson: { type: "FeatureCollection", features: [] } },
    })),
  };
});

const { buildTestApp } = await import("./setup");
const { resetBrokerageApiKeysForTests } = await import(
  "../middlewares/brokerageAuth"
);
const { __resetServiceApiKeyCacheForTests } = await import(
  "../lib/serviceToken"
);
const {
  __resetBrowserProxyKeysForTests,
  browserProxyEndUserMiddleware,
  END_USER_SESSION_HEADER,
} = await import("../middlewares/browserProxyEndUser");
const { mintSessionToken } = await import("../lib/sessionToken");
const { DEFAULT_TENANT_ID } = await import("../middlewares/session");
const { resolvePeUserIdFromTrustedServiceCall } = await import(
  "../lib/peServiceUserId"
);

let app: Express;

function resetKeys(): void {
  __resetServiceApiKeyCacheForTests();
  resetBrokerageApiKeysForTests();
  __resetBrowserProxyKeysForTests();
}

beforeAll(async () => {
  process.env.SESSION_SECRET ||= "test-session-secret-browser-proxy";
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROKERAGE_API_KEYS = BROKERAGE_KEY;
  process.env.BROWSER_PROXY_API_KEYS = `${PROXY_KEY}, ${PROXY_KEY_ROTATED}`;
  process.env.BROKERAGE_MAP_DATA_MAX_INSTALL_IDS = MAX_INSTALL;
  resetKeys();
  app = await buildTestApp();
});

beforeEach(() => {
  process.env.SERVICE_API_KEY = SERVICE_TOKEN;
  process.env.BROWSER_PROXY_API_KEYS = `${PROXY_KEY}, ${PROXY_KEY_ROTATED}`;
  resetKeys();
});

const BBOX = { west: -97.4, south: 30.0, east: -97.39, north: 30.01 };

function gis(layer: string, headers: Record<string, string>) {
  const r = request(app).post("/api/brokerage/v1/map-data/gis-layer");
  for (const [k, v] of Object.entries(headers)) r.set(k, v);
  return r.send({ layer, bbox: BBOX });
}

const viaProxy = (extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${PROXY_KEY}`,
  ...extra,
});

describe("anonymous visitor through the browser proxy gets the PUBLIC tier", () => {
  it("a Max-only layer (fema) is refused with tier_required, packageTier free", async () => {
    const res = await gis("fema", viaProxy());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("tier_required");
    expect(res.body.packageTier).toBe("free");
  });

  it("the motivated-seller composite (owner mailing / exemptions) is refused", async () => {
    const res = await request(app)
      .post("/api/brokerage/v1/map-data/composite-layer")
      .set(viaProxy())
      .send({ layer: "motivated-seller", bbox: BBOX });
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });

  it("GET /map-data/gis-layers (Max catalog) is refused", async () => {
    const res = await request(app)
      .get("/api/brokerage/v1/map-data/gis-layers")
      .set(viaProxy());
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });

  it("parcels (public-record geometry the PE map draws) is served at packageTier free with NO owner co-gated key", async () => {
    const res = await gis("parcels", viaProxy());
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("free");
    const fs = res.body.geojson.features as Array<{ properties: Record<string, unknown> }>;
    expect(fs).toHaveLength(2);
    for (const f of fs) {
      expect("owner" in f.properties).toBe(false);
      expect("ownerMailingAddress" in f.properties).toBe(false);
      expect(f.properties.parcel_node_id).toBeTruthy();
      expect(f.properties.situsAddress).toBe("1 SYNTHETIC WAY");
    }
    expect(JSON.stringify(res.body)).not.toContain(SYNTH);
  });

  it("a rotated proxy key behaves identically (anonymous, public tier)", async () => {
    const res = await gis("fema", { Authorization: `Bearer ${PROXY_KEY_ROTATED}` });
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });

  it("a browser-supplied install id on the Max allowlist does NOT lift a proxy request to Max", async () => {
    const res = await gis("fema", viaProxy({ "X-Hauska-Install-Id": MAX_INSTALL }));
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });

  it("an invalid / forged end-user session on a PROXY request runs as anonymous, not as anyone", async () => {
    const res = await gis(
      "fema",
      viaProxy({ [END_USER_SESSION_HEADER]: "forged.payload.signature" }),
    );
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });

  it("a proxy key equal to SERVICE_API_KEY still runs as anonymous (default deny wins)", async () => {
    process.env.BROWSER_PROXY_API_KEYS = SERVICE_TOKEN;
    resetKeys();
    const res = await gis("fema", { Authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(res.status).toBe(403);
    expect(res.body.packageTier).toBe("free");
  });
});

describe("a forged end-user context WITHOUT the proxy's service authentication is rejected", () => {
  const studioLike = () =>
    mintSessionToken({
      audience: "user",
      tenantId: DEFAULT_TENANT_ID,
      requestor: { kind: "user", id: "user_forged_context" },
    });

  for (const [label, auth] of [
    ["no key at all", null],
    ["the SERVICE key", `Bearer ${SERVICE_TOKEN}`],
    ["a brokerage operator key", `Bearer ${BROKERAGE_KEY}`],
    ["an unknown key", "Bearer not-a-real-key"],
  ] as const) {
    it(`X-Hauska-End-User-Session with ${label} -> 401 end_user_context_untrusted`, async () => {
      const headers: Record<string, string> = { [END_USER_SESSION_HEADER]: studioLike() };
      if (auth) headers.Authorization = auth;
      const res = await gis("parcels", headers);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("end_user_context_untrusted");
    });
  }

  it("is refused on a public route too (node facets), before the route runs", async () => {
    const res = await request(app)
      .get("/api/brokerage/v1/place/node/48999:1/facets")
      .set(END_USER_SESSION_HEADER, studioLike());
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("end_user_context_untrusted");
  });
});

describe("service-key callers (MCP servers, workers, console) are unchanged", () => {
  it("SERVICE_API_KEY still resolves to packageTier max on a Max-only layer", async () => {
    const res = await gis("fema", { Authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
  });

  it("SERVICE_API_KEY via X-Hauska-Key is unchanged", async () => {
    const res = await gis("fema", { "X-Hauska-Key": SERVICE_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.packageTier).toBe("max");
  });

  it("service impersonation (smartsite-mcp: SERVICE_API_KEY + X-PE-User-Id) still resolves the user", () => {
    const req = {
      header: (n: string) =>
        ({ authorization: `Bearer ${SERVICE_TOKEN}`, "x-pe-user-id": "user_mcp_oauth" })[
          n.toLowerCase()
        ],
    } as unknown as Request;
    expect(resolvePeUserIdFromTrustedServiceCall(req)).toBe("user_mcp_oauth");
  });

  it("no key at all is still 401 on the gated surface (the proxy key did not open it)", async () => {
    const res = await gis("parcels", {});
    expect(res.status).toBe(401);
  });
});

describe("browserProxyEndUserMiddleware (unit)", () => {
  function run(headers: Record<string, string>) {
    const req = {
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      session: {
        audience: "user",
        tenantId: DEFAULT_TENANT_ID,
        requestor: { kind: "user", id: "anon_x" },
      },
    } as unknown as Request;
    let status = 0;
    let body: unknown;
    const res = {
      status(c: number) {
        status = c;
        return res;
      },
      json(b: unknown) {
        body = b;
        return res;
      },
    } as unknown as Response;
    let nexted = false;
    browserProxyEndUserMiddleware(req, res, () => {
      nexted = true;
    });
    return { req, status, body, nexted };
  }

  it("a valid end-user session runs the request AS that user and strips every credential", () => {
    const token = mintSessionToken({
      audience: "user",
      tenantId: DEFAULT_TENANT_ID,
      requestor: { kind: "user", id: "user_real_visitor" },
    });
    const { req, nexted } = run({
      Authorization: `Bearer ${PROXY_KEY}`,
      [END_USER_SESSION_HEADER]: token,
      "X-Hauska-Install-Id": MAX_INSTALL,
      "X-PE-User-Id": "someone_else",
      "X-Hauska-Platform-Internal": "1",
    });
    expect(nexted).toBe(true);
    expect(req.browserProxyEndUser).toEqual({ kind: "user", userId: "user_real_visitor" });
    expect(req.session.requestor).toEqual({ kind: "user", id: "user_real_visitor" });
    expect(req.brokerageAuth).toEqual({ tier: "user" });
    expect(req.brokerageServiceCaller).toBeUndefined();
    for (const h of [
      "authorization",
      END_USER_SESSION_HEADER,
      "x-hauska-install-id",
      "x-pe-user-id",
      "x-hauska-platform-internal",
    ]) {
      expect(req.headers[h]).toBeUndefined();
    }
  });

  it("no end-user session -> anonymous with NO requestor (not even an anon owner)", () => {
    const { req, nexted } = run({ Authorization: `Bearer ${PROXY_KEY}` });
    expect(nexted).toBe(true);
    expect(req.browserProxyEndUser).toEqual({ kind: "anonymous", reason: "no_context" });
    expect(req.session.requestor).toBeUndefined();
    expect(req.brokerageAuth).toBeUndefined();
  });

  it("an internal-audience (operator console) token is never relayed through the proxy", () => {
    const token = mintSessionToken({
      audience: "internal",
      tenantId: DEFAULT_TENANT_ID,
      requestor: { kind: "user", id: "operator_1" },
    });
    const { req } = run({
      Authorization: `Bearer ${PROXY_KEY}`,
      [END_USER_SESSION_HEADER]: token,
    });
    expect(req.browserProxyEndUser).toEqual({ kind: "anonymous", reason: "invalid_context" });
    expect(req.session.audience).toBe("user");
    expect(req.session.requestor).toBeUndefined();
  });

  it("a request with no proxy key and no end-user header passes through untouched", () => {
    const { req, nexted } = run({ Authorization: `Bearer ${SERVICE_TOKEN}` });
    expect(nexted).toBe(true);
    expect(req.browserProxyEndUser).toBeUndefined();
    expect(req.headers.authorization).toBe(`Bearer ${SERVICE_TOKEN}`);
  });
});
