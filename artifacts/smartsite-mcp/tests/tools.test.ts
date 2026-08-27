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
