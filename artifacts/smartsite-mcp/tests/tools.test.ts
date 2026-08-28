import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";

const mockCortexFetch = vi.fn();
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => ({
    baseUrl: "http://cortex.test",
    serviceApiKey: "test-key",
  }),
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const defaultAuth: SmartsiteAuthContext = {
  userId: "user-test-1",
  email: "test@example.com",
  accessTier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};

let mockAuth: SmartsiteAuthContext = { ...defaultAuth };

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-context.js")>();
  return {
    ...actual,
    requireAuthContext: () => mockAuth,
  };
});

async function withTestClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.0.1",
  });
  registerTools(server);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  await fn(client);

  await client.close();
  await server.close();
}

describe("smartsite-mcp tools/list", () => {
  it("registers exactly eight tools with Smart Site server name", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(8);
      expect(tools.map((t) => t.name).sort()).toEqual(
        SMARTSITE_MCP_TOOLS.map((t) => t.name).sort(),
      );
    });
  });
});

describe("smartsite-mcp tool honesty", () => {
  const originalHauskaUrl = process.env.HAUSKA_MCP_BASE_URL;

  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
    delete process.env.HAUSKA_MCP_BASE_URL;
  });

  afterEach(() => {
    if (originalHauskaUrl === undefined) {
      delete process.env.HAUSKA_MCP_BASE_URL;
    } else {
      process.env.HAUSKA_MCP_BASE_URL = originalHauskaUrl;
    }
    vi.restoreAllMocks();
  });

  it("export_instrument returns not_ready without fake started status", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "export_instrument",
        arguments: {
          parcelNodeId: "4813500100100100100",
          kind: "brief",
        },
      });
      expect(result.isError).toBe(true);
      const text = result.content?.[0];
      expect(text?.type).toBe("text");
      const parsed = JSON.parse((text as { text: string }).text);
      expect(parsed).toMatchObject({
        status: "not_ready",
        tool: "export_instrument",
      });
      expect(parsed).not.toHaveProperty("entitlementProbe");
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("export_instrument returns degraded (not server-down) when Hauska MCP is down", async () => {
    process.env.HAUSKA_MCP_BASE_URL = "https://hauska-mcp.test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("hauska-mcp.test/health")) {
        throw new Error("ECONNREFUSED");
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "export_instrument",
        arguments: {
          parcelNodeId: "4813500100100100100",
          kind: "brief",
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toMatchObject({
        status: "degraded",
        tool: "export_instrument",
        reason: "hauska_mcp_unavailable",
        dependency: "hauska-mcp",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("run_report flattens brief with synchronous honesty fields", async () => {
    const cortexBody = {
      runId: "r1-test",
      reportFamily: "R1",
      mode: "baked-facet-intel-v1",
      parcelNodeId: "4813500100100100100",
      brief: { sections: [], disclosure: [] },
      source: "baked-snapshot",
    };
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(cortexBody), { status: 200 }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "4813500100100100100" },
      });
      expect(result.isError).toBe(false);
      const text = result.content?.[0];
      const parsed = JSON.parse((text as { text: string }).text);
      expect(parsed).toMatchObject({
        reportKind: "R1-baked-snapshot",
        reportReadMode: "baked-snapshot-read",
        async: false,
        parcelNodeId: "4813500100100100100",
        runId: "r1-test",
        mode: "baked-facet-intel-v1",
        brief: { sections: [], disclosure: [] },
      });
      expect(parsed.brief).not.toHaveProperty("brief");
    });
  });

  it("list_my_properties strips snapshot chat blobs", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "saved-1",
            parcelNodeId: "48021:34137",
            label: "908 PINE",
            updatedAt: "2026-08-27T12:00:00.000Z",
            snapshot: { chatThreads: [{ messages: ["secret"] }] },
          },
        ]),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_my_properties",
        arguments: {},
      });
      expect(result.isError).toBe(false);
      const text = result.content?.[0];
      const parsed = JSON.parse((text as { text: string }).text);
      expect(parsed).toEqual([
        {
          id: "saved-1",
          parcelNodeId: "48021:34137",
          label: "908 PINE",
          situs: "present",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
      ]);
    });
  });

  it("list_my_properties never returns a punctuation-only label", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "saved-junk",
            parcelNodeId: "48021:25420",
            label: ", ,",
            updatedAt: "2026-08-27T12:00:00.000Z",
          },
        ]),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_my_properties",
        arguments: {},
      });
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual([
        {
          id: "saved-junk",
          parcelNodeId: "48021:25420",
          label: "48021:25420",
          situs: "unknown",
          updatedAt: "2026-08-27T12:00:00.000Z",
        },
      ]);
    });
  });

  it("run_report description does not promise async jobs", () => {
    const runReport = SMARTSITE_MCP_TOOLS.find((t) => t.name === "run_report");
    const desc = runReport?.description.toLowerCase() ?? "";
    expect(desc).not.toMatch(/start an async|job id when|returns started/);
    expect(desc).toContain("synchron");
  });
});

describe("smartsite-mcp tier gates (P-87 item 11)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("free session cannot run run_report (deep gate)", async () => {
    mockAuth = {
      userId: "user-free",
      email: "free@example.com",
      accessTier: "free",
      subscriptionTier: null,
      devRole: false,
    };

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "4813500100100100100" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toMatchObject({
        status: "upgrade_required",
        reason: "deep_report",
        tier: "free",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("studio session can run run_report", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ runId: "r1", brief: {} }), { status: 200 }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "4813500100100100100" },
      });
      expect(result.isError).toBe(false);
      expect(mockCortexFetch).toHaveBeenCalled();
    });
  });

  it("free session cannot run a Studio export (siteplan)", async () => {
    mockAuth = {
      userId: "user-free",
      email: "free@example.com",
      accessTier: "free",
      subscriptionTier: null,
      devRole: false,
    };

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "export_instrument",
        arguments: {
          parcelNodeId: "4813500100100100100",
          kind: "siteplan",
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toMatchObject({
        status: "upgrade_required",
        reason: "studio_report",
        tier: "free",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("studio session passes studio gate but export remains not_ready", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "export_instrument",
        arguments: {
          parcelNodeId: "4813500100100100100",
          kind: "terrain",
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toMatchObject({
        status: "not_ready",
        tool: "export_instrument",
      });
      expect(parsed.reason).not.toBe("studio_report");
    });
  });
});

const GOLD_DRAW = {
  node: "48021:34137",
  kind: "parcel",
  label: "908 PINE, BASTROP, TX 78602",
  url: "https://smartsite.cloud/p/48021:34137",
  asOf: "2026-08-04",
  frame: {
    units: "ft",
    origin: "centroid",
    yAxis: "true-north",
    convertedFrom: "local-enu-m",
    factor: "us-survey-foot",
    quality: "gis-approximate",
  },
  ring: [
    [48.6, 83.94],
    [-50.37, 83.7],
    [-49.07, -84.28],
    [50.84, -83.36],
  ],
  ringOrder: "ccw",
  attrs: { zoning: { v: "SF-1", state: "present" } },
  overlays: [
    {
      id: "flood",
      label: "Zone X",
      draw: "tint-ring",
      state: "present",
    },
    {
      id: "envelope",
      label: "Buildable envelope not computed",
      draw: "suppress-setback-line",
      state: "refused",
      reason: "atom_path_pending",
    },
  ],
  confidence: "seed",
};

function stubRow(id: string) {
  return {
    parcelNodeId: id,
    label: id === "48021:25420" ? id : `label-${id}`,
    url: `https://smartsite.cloud/p/${id}`,
    situs: id === "48021:25420" ? "unknown" : "present",
    zoning: "present",
    landUse: "unknown",
    flood: "unknown",
    drainage: "unread",
    envelope: "refused",
  };
}

describe("get_smart_site batch and depth (P-91 items 3–5)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("A3: single-id node path keeps gold draw byte-identical", async () => {
    const cortexBody = {
      runId: "r1-gold",
      reportFamily: "R1",
      mode: "baked-facet-intel-v1",
      parcelNodeId: "48021:34137",
      brief: { sections: [], disclosure: [] },
      draw: GOLD_DRAW,
      source: "baked-snapshot",
    };
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(cortexBody), { status: 200 }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137" },
      });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(JSON.stringify(parsed.draw)).toBe(JSON.stringify(GOLD_DRAW));
      expect(mockCortexFetch.mock.calls[0]?.[2]).toMatchObject({
        body: JSON.stringify({ parcelNodeId: "48021:34137" }),
      });
    });
  });

  it("A1: thirteen-id stub is one call with five-state rails and no aggregates", async () => {
    const thirteen = [
      "48021:34137",
      "48021:34169",
      "48021:34121",
      "48021:33223",
      "48021:35073",
      "48021:25420",
      "48021:34073",
      "48021:34785",
      "48209:R12311",
      "48491:R062578",
      "48055:10068",
      "48453:280239",
      "48021:34161",
    ];
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcels: thirteen.map(stubRow),
          notFound: [],
        }),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: thirteen, depth: "stub" },
      });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.parcels).toHaveLength(13);
      expect(mockCortexFetch).toHaveBeenCalledTimes(1);
      for (const row of parsed.parcels) {
        expect(row).toHaveProperty("drainage");
        expect(row).not.toHaveProperty("coverage");
        expect(row).not.toHaveProperty("completeness");
      }
      expect(parsed.parcels.find((r: { parcelNodeId: string }) => r.parcelNodeId === "48021:25420")?.situs).toBe(
        "unknown",
      );
    });
  });

  it("A2: array with one invalid id returns rows plus notFound", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `48021:${34100 + i}`);
    const invalid = "not-a-parcel";
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcels: twelve.map(stubRow),
          notFound: [invalid],
        }),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: {
          parcelNodeId: [...twelve, invalid],
          depth: "stub",
        },
      });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.parcels).toHaveLength(12);
      expect(parsed.notFound).toEqual([invalid]);
      expect(parsed).not.toHaveProperty("error");
    });
  });

  it("refuses over-cap without calling cortex or truncating", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `48021:${10000 + i}`);
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: ids, depth: "stub" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({
        status: "refused",
        reason: "parcel_batch_cap",
        cap: 50,
        received: 51,
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("refuses hop1 and subgraph as not_implemented", async () => {
    await withTestClient(async (client) => {
      const hop = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137", depth: "hop1" },
      });
      expect(hop.isError).toBe(true);
      expect(JSON.parse((hop.content?.[0] as { text: string }).text)).toEqual({
        status: "not_implemented",
        depth: "hop1",
      });
      const sub = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137", depth: "subgraph" },
      });
      expect(JSON.parse((sub.content?.[0] as { text: string }).text)).toEqual({
        status: "not_implemented",
        depth: "subgraph",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("A4 falsifier: unread drainage is not collapsed into unknown flood", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcels: [
            {
              ...stubRow("48021:34137"),
              flood: "unknown",
              drainage: "unread",
            },
          ],
          notFound: [],
        }),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: {
          parcelNodeId: ["48021:34137"],
          depth: "stub",
        },
      });
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      const row = parsed.parcels[0];
      expect(row.flood).toBe("unknown");
      expect(row.drainage).toBe("unread");
      expect(row.flood).not.toBe(row.drainage);
    });
  });
});
