import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";
import { stripNearestOwnerAndDollars } from "../src/map-tool-wire.js";
import { buildReadingLayoutText } from "../src/reading-layout.js";
import { applyHostTierToResult } from "../src/host-tier-result.js";

const mockCortexFetch = vi.fn();
const CORTEX_TEST_CONFIG = { baseUrl: "http://cortex.test", serviceApiKey: "test-key" };
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => CORTEX_TEST_CONFIG,
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

vi.mock("../src/property-unlock.js", () => ({
  hasPropertyUnlock: () => Promise.resolve(false),
}));

const soloAuth: SmartsiteAuthContext = {
  userId: "user-solo-1",
  email: "solo@example.com",
  accessTier: "paid",
  subscriptionTier: "solo",
  devRole: false,
  hostSession: { clientName: "vitest", uiCapable: true },
};

let mockAuth: SmartsiteAuthContext = { ...soloAuth };

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-context.js")>();
  return {
    ...actual,
    requireAuthContext: () => mockAuth,
  };
});

async function withTestClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: "0.0.1" });
  registerTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await fn(client);
  await client.close();
  await server.close();
}

function firstJson(result: { content?: unknown }): Record<string, unknown> {
  const parts = (result.content as { type: string; text?: string }[] | undefined) ?? [];
  const parsed: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    try {
      const rec = JSON.parse(part.text) as Record<string, unknown>;
      if (rec && typeof rec === "object" && !Array.isArray(rec)) parsed.push(rec);
    } catch {
      continue;
    }
  }
  const toolBody = parsed.find(
    (rec) =>
      "nearestNeighbors" in rec ||
      "subjectParcelNodeId" in rec ||
      "parcels" in rec ||
      rec.status === "refused",
  );
  if (toolBody) return toolBody;
  if (parsed[0]) return parsed[0];
  throw new Error(`no JSON tool body in content: ${JSON.stringify(parts).slice(0, 400)}`);
}

function assertNoOwnerOrDollarField(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((child, i) => assertNoOwnerOrDollarField(child, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(
      ["ownerFact", "ownerName", "ownerMailingAddress", "marketValue", "assessedValue", "landValue", "improvementValue", "cadRoll"].includes(key),
      `${path}.${key} must not appear on find_nearest_parcels`,
    ).toBe(false);
    assertNoOwnerOrDollarField(child, `${path}.${key}`);
  }
}

const NEAREST_OK = {
  subjectParcelNodeId: "48021:32342",
  cap: 5,
  received: 2,
  truncated: false,
  distanceMethod: "boundary",
  spatialIndex: "txgio_parcel_geom_gist_idx",
  parcels: [
    {
      parcelNodeId: "48021:32324",
      distanceFt: 42.2,
      label: "1303 FAYETTE ST",
      situs: "present",
      acreageAcres: 0.4,
      acreage: "present",
      zoning: "present",
      landUse: "present",
      flood: "present",
      url: "https://smartsite.cloud/p/48021:32324",
    },
    {
      parcelNodeId: "48021:32350",
      distanceFt: 88.7,
      label: "1307 FAYETTE ST",
      situs: "present",
      acreageAcres: 0.5,
      acreage: "present",
      zoning: "present",
      landUse: "present",
      flood: "present",
      url: "https://smartsite.cloud/p/48021:32350",
    },
  ],
  notFound: [],
};

const PLANTED_BRIEF = {
  parcels: [
    {
      parcelNodeId: "48021:32324",
      ownerFact: { ownerName: "PLANTED OWNER", ownerMailingAddress: "1 Secret Rd" },
      onRecord: { apn: "x", marketValue: 999999, assessedValue: 888888, landValue: 100, improvementValue: 200 },
      cadRoll: { marketValue: 999999 },
      draw: { label: "1303 FAYETTE ST", ring: [] },
      brief: {
        sections: [
          { id: "zoning", title: "Zoning", disposition: "present", data: { district: "SF-1" } },
          { id: "land-use", title: "Land use", disposition: "present", data: { landUseLabel: "Vacant lot or tract" } },
          { id: "flood", title: "Flood", disposition: "present", data: { floodZone: "A" } },
        ],
      },
    },
    {
      parcelNodeId: "48021:32350",
      ownerName: "PLANTED TWO",
      draw: { label: "1307 FAYETTE ST", ring: [] },
    },
  ],
};

describe("find_nearest_parcels catalog", () => {
  const tool = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_nearest_parcels");

  it("is live and tells the model not to web-search comparables", () => {
    expect(tool?.readiness).toBe("live");
    expect(tool?.description.toLowerCase()).toContain("never search the web");
    expect(tool?.description.toLowerCase()).toContain("comparables");
    expect(tool?.description).toContain("query");
    expect(tool?.description).not.toMatch(/\u2014|\u2013/);
  });

  it("is distinct from find_parcels constraint search", () => {
    const plural = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_parcels");
    expect(plural?.description).toContain("filters");
    expect(tool?.description).not.toContain("filters array");
  });
});

describe("find_nearest_parcels tools/list and handler", () => {
  beforeEach(() => {
    mockAuth = { ...soloAuth };
    mockCortexFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tools/list advertises find_nearest_parcels", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("find_nearest_parcels");
    });
  });

  it("Dallas 48113 is refused by name, never an empty list", async () => {
    mockCortexFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          errorClass: "serve_refused",
          error: "nearest_county_out_of_scope",
          message: "Dallas County (48113) is outside Smart Site coverage.",
        }),
        { status: 422 },
      ),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_nearest_parcels",
        arguments: { parcelNodeId: "48113:12345", cap: 5 },
      });
      expect(result.isError).toBe(true);
      const parsed = firstJson(result);
      expect(parsed.status).toBe("refused");
      expect(parsed.reason).toBe("nearest_county_out_of_scope");
      expect(String(parsed.message)).toMatch(/48113|Dallas/i);
      expect(parsed).not.toHaveProperty("parcels");
    });
  });

  it("Solo caller receives no owner or dollar field after a planted brief", async () => {
    mockCortexFetch.mockImplementation(async (_config: unknown, path: string) => {
      if (String(path).includes("nearest-parcels")) {
        return new Response(JSON.stringify(NEAREST_OK), { status: 200 });
      }
      if (String(path).includes("research/brief")) {
        return new Response(JSON.stringify(PLANTED_BRIEF), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_nearest_parcels",
        arguments: { parcelNodeId: "48021:32342", cap: 5 },
      });
      expect(result.isError).toBe(false);
      const parsed = firstJson(result);
      expect(Array.isArray(parsed.nearestNeighbors)).toBe(true);
      expect((parsed.nearestNeighbors as unknown[]).length).toBe(2);
      assertNoOwnerOrDollarField(parsed);
      const text = JSON.stringify(parsed);
      expect(text).not.toContain("PLANTED OWNER");
      expect(text).not.toContain("999999");
    });
  });

  it("query address resolves one hit then calls the live nearest route", async () => {
    mockCortexFetch.mockImplementation(async (_config: unknown, path: string, init?: { body?: string }) => {
      if (String(path).includes("situs-search")) {
        return new Response(
          JSON.stringify({
            hits: [{ parcelNodeId: "48021:32342", situs: "1305 FAYETTE ST" }],
          }),
          { status: 200 },
        );
      }
      if (String(path).includes("nearest-parcels")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { parcelNodeId?: string };
        expect(body.parcelNodeId).toBe("48021:32342");
        return new Response(JSON.stringify(NEAREST_OK), { status: 200 });
      }
      if (String(path).includes("research/brief")) {
        return new Response(JSON.stringify({ parcels: [] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_nearest_parcels",
        arguments: { query: "1305 FAYETTE ST, BASTROP", cap: 5 },
      });
      expect(result.isError).toBe(false);
      const parsed = firstJson(result);
      expect(parsed.subjectParcelNodeId).toBe("48021:32342");
    });
  });
});

describe("find_nearest_parcels reading layout (P-447)", () => {
  it("lists nearest neighbors with distance and stub facts", () => {
    const text = buildReadingLayoutText(
      {
        subjectParcelNodeId: "48021:32342",
        nearestNeighbors: NEAREST_OK.parcels,
        parcels: PLANTED_BRIEF.parcels,
      },
      {
        url: "https://smartsite.cloud/card#test",
        expiresAt: "2026-10-03T00:00:00.000Z",
        expiryReason: "seven-day link",
      },
    );
    expect(text).toContain("1303 FAYETTE ST");
    expect(text).toContain("42 ft");
    expect(text).toContain("SF-1");
    expect(text).toContain("Vacant lot or tract");
    expect(text).toContain("48021:32324");
    expect(text).toContain("Open this answer as a web page");
  });

  it("text-only host gets the reading-layout table, not only JSON", () => {
    process.env.PE_SHARE_SECRET = "test-share-secret";
    const raw = JSON.stringify({
      subjectParcelNodeId: "48021:32342",
      nearestNeighbors: NEAREST_OK.parcels,
      parcels: NEAREST_OK.parcels,
    });
    const result = applyHostTierToResult(
      "find_nearest_parcels",
      { content: [{ type: "text", text: raw }] },
      { clientName: "mcp-inspector", uiCapable: false },
      "user-solo-1",
    );
    const first = result.content[0];
    expect(first?.type).toBe("text");
    expect(String(first && "text" in first ? first.text : "")).toContain("Distance");
    delete process.env.PE_SHARE_SECRET;
  });
});

describe("stripNearestOwnerAndDollars", () => {
  it("drops planted owner and dollar keys and keeps stub facts", () => {
    const stripped = stripNearestOwnerAndDollars({
      parcels: PLANTED_BRIEF.parcels,
      nearestNeighbors: NEAREST_OK.parcels,
    }) as Record<string, unknown>;
    assertNoOwnerOrDollarField(stripped);
    const neighbors = stripped.nearestNeighbors as { label: string }[];
    expect(neighbors[0]?.label).toBe("1303 FAYETTE ST");
  });
});
