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

type ListedTool = {
  name: string;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
};

/** Returns names that omit a boolean annotations.readOnlyHint. */
function namesMissingReadOnlyHint(tools: readonly ListedTool[]): string[] {
  return tools
    .filter((tool) => typeof tool.annotations?.readOnlyHint !== "boolean")
    .map((tool) => tool.name);
}

const READ_ONLY_BY_NAME: Record<string, boolean> = {
  find_parcel: true,
  get_smart_site: true,
  list_my_properties: true,
  run_report: true,
  check_request: true,
  ask_the_map: true,
  export_instrument: true,
  request_records: false,
  create_screen: false,
  add_to_screen: false,
  list_screens: true,
  save_property: false,
  set_property_status: false,
};

describe("smartsite-mcp tools/list", () => {
  it("registers exactly thirteen tools with Smart Site server name", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      expect(tools.map((t) => t.name).sort()).toEqual(
        SMARTSITE_MCP_TOOLS.map((t) => t.name).sort(),
      );
    });
  });
});

describe("smartsite-mcp tool annotations (P-91 item 1)", () => {
  it("fails when any of the eight tools omits annotations.readOnlyHint", () => {
    const fixture: ListedTool[] = SMARTSITE_MCP_TOOLS.map((tool, index) => ({
      name: tool.name,
      annotations: index === 0 ? {} : { readOnlyHint: true },
    }));
    expect(namesMissingReadOnlyHint(fixture)).toEqual([
      SMARTSITE_MCP_TOOLS[0].name,
    ]);
  });

  it("accepts a complete thirteen-tool fixture", () => {
    const fixture: ListedTool[] = SMARTSITE_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      annotations: { readOnlyHint: READ_ONLY_BY_NAME[tool.name] },
    }));
    expect(namesMissingReadOnlyHint(fixture)).toEqual([]);
  });

  it("listTools exposes annotations.readOnlyHint on every registered tool", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      expect(namesMissingReadOnlyHint(tools)).toEqual([]);
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint).toBe(READ_ONLY_BY_NAME[tool.name]);
        if (tool.name === "request_records") {
          expect(tool.annotations?.destructiveHint).toBe(false);
        }
      }
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
          stub: {
            situs: "unread",
            zoning: "unread",
            landUse: "unread",
            flood: "unread",
            drainage: "unread",
            envelope: "unread",
          },
          status: null,
          note: null,
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
          stub: {
            situs: "unread",
            zoning: "unread",
            landUse: "unread",
            flood: "unread",
            drainage: "unread",
            envelope: "unread",
          },
          status: null,
          note: null,
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

const ASK_THE_MAP_LEAK_TOKENS = [
  "workspaceDid",
  "personaBucket",
  "starterPromptId",
  "mls_id",
  "presentationMode",
] as const;

/** Cortex RESEARCH_CHAT_BODY 400 — the live leak this boundary must strip. */
const CORTEX_CHAT_VALIDATION_400 = {
  error: "invalid_request",
  message: "Invalid research chat body",
  details: {
    formErrors: [],
    fieldErrors: {
      runId: [
        "Provide runId, address, workspaceDid, or areaContext (scope=area or visibleParcels)",
      ],
    },
  },
  accepted: {
    required: ["message"],
    runSelector:
      "runId (uuid) OR address OR workspaceDid OR areaContext (scope=area or visibleParcels)",
    optional: [
      "history",
      "presentationMode",
      "starterPromptId",
      "personaBucket",
      "mls_id",
      "areaContext",
      "purpose",
    ],
  },
};

function assertNoAskTheMapLeakTokens(body: string): void {
  for (const token of ASK_THE_MAP_LEAK_TOKENS) {
    expect(body, `leak token ${token} must not appear`).not.toContain(token);
  }
}

describe("ask_the_map leak closed (P-91 item 10)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("violated schema response body omits brokerage internals", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(CORTEX_CHAT_VALIDATION_400), { status: 400 }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "ask_the_map",
        arguments: {
          parcelNodeId: "48021:34137",
          message: "what is the flood zone",
          workspaceDid: "did:hauska:property-workspace:leak",
          personaBucket: "owner_buyer",
          starterPromptId: "adu",
          mls_id: "MLS-LEAK",
          presentationMode: "consumer",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
      const parsed = JSON.parse(text);
      expect(parsed).toEqual({
        status: "invalid_request",
        message: "ask_the_map accepts parcelNodeId and message.",
      });
      assertNoAskTheMapLeakTokens(JSON.stringify(result));
      assertNoAskTheMapLeakTokens(text);
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("MCP-side empty message plus leak fields still omits brokerage internals", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "ask_the_map",
        arguments: {
          parcelNodeId: "48021:34137",
          message: "",
          workspaceDid: "did:hauska:property-workspace:leak",
          personaBucket: "owner_buyer",
          starterPromptId: "adu",
          mls_id: "MLS-LEAK",
          presentationMode: "consumer",
        },
      });
      expect(result.isError).toBe(true);
      assertNoAskTheMapLeakTokens(JSON.stringify(result));
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("forwards a sanitized cortex 400 when the MCP args are legal", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(CORTEX_CHAT_VALIDATION_400), { status: 400 }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "ask_the_map",
        arguments: {
          parcelNodeId: "48021:34137",
          message: "what is the flood zone",
        },
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
      assertNoAskTheMapLeakTokens(text);
      expect(mockCortexFetch).toHaveBeenCalled();
    });
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
      citations: [],
      citationsDegraded: true,
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

describe("P-91 Wave B screen/save tools", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("tools/list is 13 and omits get_screen, unsave_property, delete_screen", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      const names = tools.map((t) => t.name);
      expect(names).toContain("create_screen");
      expect(names).toContain("add_to_screen");
      expect(names).toContain("list_screens");
      expect(names).toContain("save_property");
      expect(names).toContain("set_property_status");
      expect(names).not.toContain("get_screen");
      expect(names).not.toContain("unsave_property");
      expect(names).not.toContain("delete_screen");
    });
  });

  it("list_my_properties accepting screenId refuses screen_id_not_accepted", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_my_properties",
        arguments: { screenId: "should-refuse" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({ error: "screen_id_not_accepted" });
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("save_property POSTs /save and never PUTs snapshot", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcelNodeId: "48021:34137",
          status: "Watching",
          note: "keep",
        }),
        { status: 200 },
      ),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "save_property",
        arguments: {
          parcelNodeId: "48021:34137",
          status: "Watching",
          note: "keep",
        },
      });
      expect(result.isError).toBe(false);
    });
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    const [config, path, init] = mockCortexFetch.mock.calls[0] as [
      unknown,
      string,
      { method?: string; body?: string },
    ];
    void config;
    expect(path).toContain("/saved-properties/48021%3A34137/save");
    expect(init.method).toBe("POST");
    expect(path).not.toMatch(/saved-properties\/48021%3A34137$/);
    expect(JSON.parse(init.body ?? "{}")).not.toHaveProperty("snapshot");
  });

  it("create_screen chrome refuses intake_not_implemented without writing", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "intake_not_implemented" }), {
        status: 400,
      }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "create_screen",
        arguments: {
          queries: ["111 Rainmaker Cv, Bastrop TX"],
          source: "chrome",
        },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.error).toBe("intake_not_implemented");
    });
  });
});
