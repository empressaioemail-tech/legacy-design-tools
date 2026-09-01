import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { sanitizeAskTheMapErrorBody } from "../src/tool-honesty.js";
import { ANCHOR_BATCH_READ_CAP } from "../src/parcel-anchor.js";
import { registerTools, splitFindParcelHits } from "../src/tools.js";
import { VOCABULARY_MIME, VOCABULARY_RESOURCE_URI } from "../src/vocabulary.js";

const mockCortexFetch = vi.fn();
const CORTEX_TEST_CONFIG = { baseUrl: "http://cortex.test", serviceApiKey: "test-key" };
const mockLoadCortexConfig = vi.fn<() => typeof CORTEX_TEST_CONFIG | null>(
  () => CORTEX_TEST_CONFIG,
);
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => mockLoadCortexConfig(),
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

describe("ask_the_map leak closed (P-91 item 10) and blocked (P-91 item 34)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("falsifier: the synthetic cortex 400 still carries every leak token", () => {
    const raw = JSON.stringify(CORTEX_CHAT_VALIDATION_400);
    for (const token of ASK_THE_MAP_LEAK_TOKENS) {
      expect(raw).toContain(token);
    }
  });

  it("scrub on the synthetic cortex 400 stays proven while the path is blocked", () => {
    const scrubbed = sanitizeAskTheMapErrorBody(
      JSON.stringify(CORTEX_CHAT_VALIDATION_400),
    );
    assertNoAskTheMapLeakTokens(scrubbed);
    expect(JSON.parse(scrubbed).accepted.optional).toEqual([
      "history",
      "areaContext",
      "purpose",
    ]);
  });

  it("publishes a strict two-field schema in tools/list", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "ask_the_map");
      expect(tool).toBeDefined();
      const schema = tool!.inputSchema as {
        additionalProperties?: unknown;
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
        "message",
        "parcelNodeId",
      ]);
      expect([...(schema.required ?? [])].sort()).toEqual([
        "message",
        "parcelNodeId",
      ]);
    });
  });

  it("extra keys are refused at the schema without echoing their names", async () => {
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
      expect(text).toContain("ask_the_map accepts parcelNodeId and message.");
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

  it("a legal call returns not_ready and never reaches cortex", async () => {
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
      const parsed = JSON.parse(text);
      expect(parsed).toMatchObject({ status: "not_ready", tool: "ask_the_map" });
      expect(parsed.reason).toContain("P-91 item 34");
      assertNoAskTheMapLeakTokens(JSON.stringify(result));
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("tools/list still returns thirteen names with ask_the_map listed", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(13);
      expect(tools.map((t) => t.name)).toContain("ask_the_map");
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

  it("A3: single-id node path keeps gold draw's own facts byte-identical; V3/V5 add reasonDisplayText and derivedFigures only", async () => {
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
      // V3: the raw machine token on the envelope overlay's `reason` field
      // (this is the exact live-session bug: "atom_path_pending" reaching
      // the model with no display string) now carries the panel's own
      // translation beside it, unchanged and additive.
      expect(parsed.draw.overlays[1]).toEqual({
        ...GOLD_DRAW.overlays[1],
        reasonDisplayText: "Withheld, setbacks unruled",
      });
      expect(JSON.stringify(parsed.draw)).toBe(
        JSON.stringify({
          ...GOLD_DRAW,
          overlays: [
            GOLD_DRAW.overlays[0],
            { ...GOLD_DRAW.overlays[1], reasonDisplayText: "Withheld, setbacks unruled" },
          ],
          derivedFigures: {
            denies: ["area", "coverage_ratio", "lot_coverage_pct", "setback_distance", "buildable_area"],
            reason:
              "ring, edges, and overlays are for rendering only. Do not compute an area, a coverage ratio, a percentage, or a distance from them; use a brief section's own figure, or say the figure is not on record.",
          },
        }),
      );
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

  it("refuses over-cap at the published schema without calling cortex or truncating", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `48021:${10000 + i}`);
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "get_smart_site");
      const parcelNodeId = (tool?.inputSchema as {
        properties?: { parcelNodeId?: { anyOf?: Array<Record<string, unknown>> } };
      }).properties?.parcelNodeId;
      const arrayBranch = parcelNodeId?.anyOf?.find((b) => b.type === "array");
      expect(arrayBranch, "array branch published in tools/list").toBeDefined();
      expect(arrayBranch?.maxItems).toBe(50);
      expect(arrayBranch?.minItems).toBe(1);

      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: ids, depth: "stub" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain("50");
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
        reason: "depth_not_implemented",
        depth: "hop1",
      });
      const sub = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137", depth: "subgraph" },
      });
      expect(JSON.parse((sub.content?.[0] as { text: string }).text)).toEqual({
        status: "not_implemented",
        reason: "depth_not_implemented",
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
      expect(parsed).toEqual({
        status: "refused",
        reason: "screen_id_not_accepted",
        error: "screen_id_not_accepted",
      });
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

  it("create_screen chrome is refused at the schema and never reaches cortex", async () => {
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
      const text = (result.content?.[0] as { text: string }).text;
      expect(text).toContain("pasted");
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });
});

describe("get_smart_site non-OK wire contract (P-91 build plan 4.1)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  const ID = "48021:900099";

  function expectMissShape(
    text: string,
    id: string,
    reason: "parcel_not_found" | "baked_snapshot_not_found",
    parcelExists: boolean | "unmeasured",
  ): void {
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({
      parcels: [],
      notFound: [id],
      reason,
      parcelExists,
    });
  }

  async function callSingle(status: number, body: unknown, id = ID) {
    mockCortexFetch.mockResolvedValue(
      new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        { status },
      ),
    );
    let out: { isError?: boolean; text: string } | null = null;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: id },
      });
      out = {
        isError: result.isError as boolean | undefined,
        text: (result.content?.[0] as { text: string }).text,
      };
    });
    return out!;
  }

  it("404 parcel_not_found is a declared absence with isError false", async () => {
    const res = await callSingle(404, {
      error: "parcel_not_found",
      message: "No parcel record for this node.",
      parcelNodeId: ID,
      parcelExists: false,
    });
    expect(res.isError).toBe(false);
    expectMissShape(res.text, ID, "parcel_not_found", false);
  });

  it("404 baked_snapshot_not_found carries cortex parcelExists when present", async () => {
    const res = await callSingle(404, {
      error: "baked_snapshot_not_found",
      message: "No baked facet snapshot exists for this parcel node.",
      parcelNodeId: ID,
      parcelExists: true,
    });
    expect(res.isError).toBe(false);
    expectMissShape(res.text, ID, "baked_snapshot_not_found", true);
  });

  it("404 baked_snapshot_not_found from an old cortex is parcelExists unmeasured, never a boolean", async () => {
    const res = await callSingle(404, {
      error: "baked_snapshot_not_found",
      message: "No baked facet snapshot exists for this parcel node.",
      parcelNodeId: ID,
    });
    expect(res.isError).toBe(false);
    expectMissShape(res.text, ID, "baked_snapshot_not_found", "unmeasured");
  });

  it("402 upgrade_required on one id is a refused row with isError false", async () => {
    const res = await callSingle(402, {
      error: "upgrade_required",
      message: "Unlock this property or go Pro to run this report",
      tier: "free",
      property: { parcelNodeId: ID, unlocked: false },
    });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({
      parcels: [],
      notFound: [],
      refused: [{ parcelNodeId: ID, reason: "upgrade_required" }],
    });
    expect(res.text).not.toContain("go Pro");
  });

  it("402 upgrade_required on an array refuses every id", async () => {
    const ids = ["48021:34137", "48021:34169", "48021:34121"];
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "upgrade_required",
          message: "Paid deep access required for this route",
          tier: "free",
        }),
        { status: 402 },
      ),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: ids, depth: "stub" },
      });
      expect(result.isError).toBe(false);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({
        parcels: [],
        notFound: [],
        refused: ids.map((id) => ({ parcelNodeId: id, reason: "upgrade_required" })),
      });
    });
  });

  it("404 on an array is not rewritten into per-id absences", async () => {
    const ids = ["48021:34137", "48021:900099"];
    const body = {
      error: "baked_snapshot_not_found",
      message: "No baked facet snapshot exists for this parcel node.",
    };
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(body), { status: 404 }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: ids, depth: "stub" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({
        ...body,
        status: "error",
        reason: "baked_snapshot_not_found",
        upstreamStatus: 404,
      });
      expect(parsed).not.toHaveProperty("notFound");
    });
  });

  it("any other non-OK is declared: upstream keys kept, status error, reason, upstreamStatus (H1)", async () => {
    const res = await callSingle(500, { error: "internal", detail: "pool exhausted" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      error: "internal",
      detail: "pool exhausted",
      status: "error",
      reason: "internal",
      upstreamStatus: 500,
    });

    const html = await callSingle(502, "<html>bad gateway</html>");
    expect(html.isError).toBe(true);
    expect(JSON.parse(html.text)).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: 502,
      brief: "<html>bad gateway</html>",
    });

    const auth = await callSingle(401, { error: "authentication_required" });
    expect(auth.isError).toBe(true);
    expect(JSON.parse(auth.text)).toEqual({
      error: "authentication_required",
      status: "error",
      reason: "authentication_required",
      upstreamStatus: 401,
    });
  });

  it("falsifier: a fixture with reason stripped fails the shape check", () => {
    const stripped = JSON.stringify({
      parcels: [],
      notFound: [ID],
      parcelExists: false,
    });
    expect(() =>
      expectMissShape(stripped, ID, "parcel_not_found", false),
    ).toThrow();
  });
});

describe("run_report honesty stamp only on res.ok (deep dive 4.1 row 4)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("cortex 402 returns status error with the upstream body and no read stamp", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "upgrade_required",
          message: "Unlock this property or go Pro to run this report",
          tier: "free",
          property: { parcelNodeId: "48021:34137", unlocked: false },
        }),
        { status: 402 },
      ),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "48021:34137" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed.status).toBe("error");
      expect(parsed.reason).toBe("upgrade_required");
      expect(parsed.upstreamStatus).toBe(402);
      expect(parsed.error).toBe("upgrade_required");
      expect(parsed.tier).toBe("free");
      expect(parsed).not.toHaveProperty("reportKind");
      expect(parsed).not.toHaveProperty("reportReadMode");
      expect(parsed).not.toHaveProperty("async");
    });
  });

  it("cortex 404 returns status error and no read stamp", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "baked_snapshot_not_found",
          message: "No baked facet snapshot exists for this parcel node.",
          parcelNodeId: "48021:900099",
        }),
        { status: 404 },
      ),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "48021:900099" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({
        status: "error",
        reason: "baked_snapshot_not_found",
        upstreamStatus: 404,
        error: "baked_snapshot_not_found",
        message: "No baked facet snapshot exists for this parcel node.",
        parcelNodeId: "48021:900099",
      });
    });
  });

  it("non-JSON non-OK body lands under brief with status error", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response("upstream unavailable", { status: 502 }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "run_report",
        arguments: { parcelNodeId: "48021:34137" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(parsed).toEqual({
        status: "error",
        reason: "upstream_non_json",
        upstreamStatus: 502,
        brief: "upstream unavailable",
      });
    });
  });
});

describe("schemas as types (P-91 S2 item 5)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
  });

  function propertySchema(
    tools: Array<{ name: string; inputSchema: unknown }>,
    tool: string,
    prop: string,
  ): Record<string, unknown> | undefined {
    const found = tools.find((t) => t.name === tool);
    const props = (found?.inputSchema as { properties?: Record<string, Record<string, unknown>> })
      ?.properties;
    return props?.[prop];
  }

  it("tools/list publishes the enums", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      expect(propertySchema(tools, "create_screen", "source")?.enum).toEqual(["pasted"]);
      expect(propertySchema(tools, "add_to_screen", "source")?.enum).toEqual([
        "walk",
        "saved",
        "pasted",
      ]);
      expect(propertySchema(tools, "save_property", "status")?.enum).toEqual([
        "New",
        "Watching",
        "Chasing",
        "Passed",
      ]);
      expect(propertySchema(tools, "set_property_status", "status")?.enum).toEqual([
        "New",
        "Watching",
        "Chasing",
        "Passed",
      ]);
      const saveRequired = (tools.find((t) => t.name === "save_property")?.inputSchema as {
        required?: string[];
      }).required;
      expect(saveRequired).not.toContain("status");
    });
  });

  it("add_to_screen source outside walk|saved|pasted is refused at the schema", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "add_to_screen",
        arguments: { screenId: "scr-1", parcelNodeId: "48021:34137", source: "chrome" },
      });
      expect(result.isError).toBe(true);
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("save_property lowercase status is refused at the schema; omitted status passes", async () => {
    await withTestClient(async (client) => {
      const refused = await client.callTool({
        name: "save_property",
        arguments: { parcelNodeId: "48021:34137", status: "watching" },
      });
      expect(refused.isError).toBe(true);
      expect(mockCortexFetch).not.toHaveBeenCalled();

      const ok = await client.callTool({
        name: "save_property",
        arguments: { parcelNodeId: "48021:34137", note: "keep" },
      });
      expect(ok.isError).toBe(false);
      expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    });
  });

  it("set_property_status outside the four statuses is refused at the schema", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "set_property_status",
        arguments: { parcelNodeId: "48021:34137", status: "Closed" },
      });
      expect(result.isError).toBe(true);
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });
});

describe("find_parcel hits carry parcel records only (P-91 QA 2026-08-30 D1)", () => {
  const live = JSON.stringify({
    hits: [
      { parcelNodeId: "48021:8720522", situsAddress: "111 RAINMAKER CV, BASTROP, TX 78602", countyFips: "48021", source: "parcel-situs" },
      { parcelNodeId: null, label: "111 Rainmaker Cv, Bastrop, TX 78602", countyFips: "48021", latitude: 30.1, longitude: -97.3, source: "address-point" },
    ],
  });

  it("drops the null-id address point when a parcel hit exists", () => {
    const out = JSON.parse(splitFindParcelHits(live)) as { hits: Array<{ parcelNodeId: unknown }>; located?: unknown };
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.parcelNodeId).toBe("48021:8720522");
    expect(out.located).toBeUndefined();
    for (const hit of out.hits) expect(typeof hit.parcelNodeId).toBe("string");
  });

  it("moves address points to located, typed and without a parcel id, when nothing binds", () => {
    const miss = JSON.stringify({
      hits: [
        { parcelNodeId: null, label: "9999 Nowhere Ln, Bastrop, TX", countyFips: "48021", latitude: 30.2, longitude: -97.4, source: "address-point" },
      ],
    });
    const out = JSON.parse(splitFindParcelHits(miss)) as {
      hits: unknown[];
      located?: Array<Record<string, unknown>>;
      missClass?: string;
    };
    expect(out.hits).toEqual([]);
    expect(out.located).toHaveLength(1);
    expect(out.located?.[0]).not.toHaveProperty("parcelNodeId");
    expect(out.located?.[0]).toMatchObject({ latitude: 30.2, longitude: -97.4, source: "address-point" });
    expect(out.missClass).toBe("located-unbound");
  });

  it("keeps a cortex missClass and passes non-JSON through", () => {
    const budget = JSON.stringify({ hits: [], missClass: "situs-search-budget" });
    expect(JSON.parse(splitFindParcelHits(budget))).toEqual({ hits: [], missClass: "situs-search-budget" });
    expect(splitFindParcelHits("<html>500</html>")).toBe("<html>500</html>");
  });
});

/**
 * P-91 v3 Q1. find_parcel gains `near` and `street`, both consuming the
 * cortex radius-search / street-search routes. The load-bearing distinction
 * this whole card turns on: a 422 serve_refused is a DECLARED REFUSAL
 * (status "refused", reason the code, reasonDisplayText the human word),
 * never folded into the generic H1 upstream-error envelope; a 400 is a
 * caller bug and does fold into it; and cap/received/truncated (radiusFt
 * too, for near) reach the caller unmodified on a 200.
 */
describe("find_parcel near/street (P-91 v3 Q1)", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
    mockLoadCortexConfig.mockReturnValue(CORTEX_TEST_CONFIG);
  });

  function callResponses(
    ...bodies: Array<{ status: number; body: unknown }>
  ): void {
    for (const { status, body } of bodies) {
      mockCortexFetch.mockResolvedValueOnce(
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
        }),
      );
    }
  }

  async function callFindParcel(args: Record<string, unknown>) {
    let out: { isError?: boolean; text: string } | null = null;
    await withTestClient(async (client) => {
      const result = await client.callTool({ name: "find_parcel", arguments: args });
      out = {
        isError: result.isError as boolean | undefined,
        text: (result.content?.[0] as { text: string }).text,
      };
    });
    return out!;
  }

  const RADIUS_HITS_BODY = {
    cap: 10,
    received: 2,
    truncated: false,
    radiusFt: 1000,
    hits: [
      { parcelNodeId: "48021:1", situsAddress: "1 PINE ST", countyFips: "48021", distanceFt: 12 },
      { parcelNodeId: "48021:2", situsAddress: "2 PINE ST", countyFips: "48021", distanceFt: 40 },
    ],
  };

  it("near with a free-text address: geocodes via place/resolve, then radius-searches, passing cap/received/truncated/radiusFt/hits through verbatim", async () => {
    callResponses(
      { status: 200, body: { placeKey: "coord:30.1:-97.3", geocode: { lat: 30.1, lng: -97.3, city: "Bastrop", state: "TX", confidence: "high" } } },
      { status: 200, body: RADIUS_HITS_BODY },
    );
    const res = await callFindParcel({ near: { query: "123 Main St, Bastrop TX", radiusFt: 1000, cap: 10 } });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual(RADIUS_HITS_BODY);
    expect(mockCortexFetch).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockCortexFetch.mock.calls as Array<
      [unknown, string, RequestInit & { userId?: string }]
    >;
    expect(firstCall[1]).toBe("/api/brokerage/v1/place/resolve");
    expect(firstCall[2]?.method).toBe("POST");
    expect(JSON.parse(String(firstCall[2]?.body))).toEqual({ address: "123 Main St, Bastrop TX" });
    expect(secondCall[1]).toContain("/api/brokerage/v1/place/radius-search?");
    const qs = new URLSearchParams(secondCall[1].split("?")[1]);
    expect(qs.get("lat")).toBe("30.1");
    expect(qs.get("lng")).toBe("-97.3");
    expect(qs.get("radiusFt")).toBe("1000");
    expect(qs.get("cap")).toBe("10");
  });

  it("near with a parcel node id: reads the same facets route M-1's anchor reads, never place/resolve", async () => {
    callResponses(
      { status: 200, body: { cityLimitsFact: { queryPoint: { longitude: -97.35, latitude: 30.15 } } } },
      { status: 200, body: { ...RADIUS_HITS_BODY, received: 1, hits: [RADIUS_HITS_BODY.hits[0]] } },
    );
    const res = await callFindParcel({ near: { query: "48021:34137", radiusFt: 500 } });
    expect(res.isError).toBe(false);
    expect(mockCortexFetch).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockCortexFetch.mock.calls as Array<[unknown, string]>;
    expect(firstCall[1]).toBe("/api/brokerage/v1/place/node/48021%3A34137/facets");
    const qs = new URLSearchParams(secondCall[1].split("?")[1]);
    expect(qs.get("lat")).toBe("30.15");
    expect(qs.get("lng")).toBe("-97.35");
  });

  it("near: an upstream failure on the centre-point read (facets 502) is the ordinary H1 declared error, radius-search never called", async () => {
    callResponses({ status: 502, body: "<html>bad gateway</html>" });
    const res = await callFindParcel({ near: { query: "48021:34137", radiusFt: 500 } });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: 502,
      brief: "<html>bad gateway</html>",
    });
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
  });

  it("near: a parcel with no centre point on file (facets 200, no cityLimitsFact) is a declared refusal, not an error, radius-search never called", async () => {
    callResponses({ status: 200, body: { someOtherField: true } });
    const res = await callFindParcel({ near: { query: "48021:34137", radiusFt: 500 } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed).toMatchObject({
      status: "refused",
      reason: "near_center_absent",
      parcelNodeId: "48021:34137",
    });
    expect(parsed.anchorRead).toMatchObject({ status: "absent", reason: "city_limits_fact_absent" });
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
  });

  it("near: place/resolve's own geocode_miss 422 is the ordinary H1 declared error (status error), NOT a place-search refusal — that shape is reserved for radius-search/street-search's five codes", async () => {
    callResponses({
      status: 422,
      body: { errorClass: "geocode_miss", error: "geocode_miss", message: "Could not geocode the provided address" },
    });
    const res = await callFindParcel({ near: { query: "not a real address at all", radiusFt: 500 } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("error");
    expect(parsed).not.toHaveProperty("reasonDisplayText");
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
  });

  it("near: radius-search's 422 radius_unbounded is a DECLARED REFUSAL (status refused, reasonDisplayText present), never folded into the generic upstream-error envelope", async () => {
    callResponses(
      { status: 200, body: { geocode: { lat: 30.1, lng: -97.3 } } },
      {
        status: 422,
        body: {
          error: "radius_unbounded",
          errorClass: "serve_refused",
          message: "Candidate set exceeded 2000. Refusing rather than returning a silently short neighbourhood.",
        },
      },
    );
    const res = await callFindParcel({ near: { query: "123 Main St", radiusFt: 5000 } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("refused");
    expect(parsed.reason).toBe("radius_unbounded");
    expect(parsed.message).toContain("Candidate set exceeded 2000");
    expect(typeof parsed.reasonDisplayText).toBe("string");
    expect(parsed.reasonDisplayText.length).toBeGreaterThan(0);
    // Never the upstream-error shape.
    expect(parsed).not.toHaveProperty("upstreamStatus");
  });

  it("near: radius-search's 400 (a caller bug) is the ordinary H1 declared error", async () => {
    callResponses(
      { status: 200, body: { geocode: { lat: 30.1, lng: -97.3 } } },
      {
        status: 400,
        body: { error: "invalid_request", errorClass: "validation_error", message: "radiusFt max 5280" },
      },
    );
    const res = await callFindParcel({ near: { query: "123 Main St", radiusFt: 999999 } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("error");
    expect(parsed.reason).toBe("invalid_request");
    expect(parsed.upstreamStatus).toBe(400);
  });

  it("street: success passes cap/received/truncated/hits through verbatim, q/cap/countyFips reach the query string", async () => {
    const streetBody = { cap: 25, received: 3, truncated: true, hits: [{ parcelNodeId: "48021:9", situsAddress: "9 PINE ST", countyFips: "48021" }] };
    callResponses({ status: 200, body: streetBody });
    const res = await callFindParcel({ street: { query: "Pine St", cap: 25, countyFips: "48021" } });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual(streetBody);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    const [call] = mockCortexFetch.mock.calls as Array<[unknown, string]>;
    const qs = new URLSearchParams(call[1].split("?")[1]);
    expect(qs.get("q")).toBe("Pine St");
    expect(qs.get("cap")).toBe("25");
    expect(qs.get("countyFips")).toBe("48021");
  });

  it("street: bare_street_unbounded is a DECLARED REFUSAL, never an error", async () => {
    callResponses({
      status: 422,
      body: {
        error: "bare_street_unbounded",
        errorClass: "serve_refused",
        message: "Bare street search requires a city, ZIP, or countyFips. Refusing an unbounded contains.",
      },
    });
    const res = await callFindParcel({ street: { query: "Pine St" } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("refused");
    expect(parsed.reason).toBe("bare_street_unbounded");
    expect(typeof parsed.reasonDisplayText).toBe("string");
  });

  it("street: bare_street_not_a_street is a DECLARED REFUSAL, never an error", async () => {
    callResponses({
      status: 422,
      body: {
        error: "bare_street_not_a_street",
        errorClass: "serve_refused",
        message: "q is not a bare street. A house-number-prefixed query belongs on situs-search.",
      },
    });
    const res = await callFindParcel({ street: { query: "908 Pine St", countyFips: "48021" } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    // `reason` alone is not meaning-shaped here: declareUpstreamNonOk's
    // fold-through would ALSO set reason to body.error when body.reason is
    // absent (see declareUpstreamNonOk's `nonEmptyString(rest.error)`
    // branch), so a reason-only check cannot tell the two paths apart —
    // caught by literally running this exact mutation. `status` and
    // `reasonDisplayText` are what only the correct path produces.
    expect(parsed.status).toBe("refused");
    expect(parsed.reason).toBe("bare_street_not_a_street");
    expect(typeof parsed.reasonDisplayText).toBe("string");
    expect(parsed.reasonDisplayText.length).toBeGreaterThan(0);
  });

  it("street: a 400 is the ordinary H1 declared error", async () => {
    callResponses({
      status: 400,
      body: { error: "invalid_request", errorClass: "validation_error", message: "countyFips must be 5 digits" },
    });
    const res = await callFindParcel({ street: { query: "Pine St", countyFips: "48021" } });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("error");
    expect(parsed.upstreamStatus).toBe(400);
  });

  it("mode missing: no query, near, or street is a declared refusal, zero cortex calls", async () => {
    const res = await callFindParcel({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      status: "refused",
      reason: "find_parcel_mode_missing",
      message: "Provide one of query, near, or street.",
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("mode ambiguous: more than one of query/near/street is a declared refusal, zero cortex calls", async () => {
    const combos: Array<Record<string, unknown>> = [
      { query: "908 Pine", near: { query: "908 Pine", radiusFt: 500 } },
      { query: "908 Pine", street: { query: "Pine St" } },
      { near: { query: "908 Pine", radiusFt: 500 }, street: { query: "Pine St" } },
    ];
    for (const args of combos) {
      const res = await callFindParcel(args);
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.parse(res.text)).toEqual({
        status: "refused",
        reason: "find_parcel_mode_ambiguous",
        message: "Provide exactly one of query, near, or street, not more than one.",
      });
    }
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("near/street reject an unrecognised key at the schema, before any cortex call (strict object)", async () => {
    const res = await callFindParcel({ near: { query: "908 Pine", radiusFt: 500, bogus: true } });
    expect(res.isError).toBe(true);
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("near.cap and street.cap above the local max (50) are rejected at the schema, before any cortex call", async () => {
    const overCap = await callFindParcel({ near: { query: "908 Pine", radiusFt: 500, cap: 51 } });
    expect(overCap.isError).toBe(true);
    const overCapStreet = await callFindParcel({ street: { query: "Pine St", cap: 51 } });
    expect(overCapStreet.isError).toBe(true);
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("near.radiusFt carries NO local bound: an absurdly large value still reaches cortex rather than being schema-rejected, so radius_exceeds_max stays reachable through this tool", async () => {
    callResponses(
      { status: 200, body: { geocode: { lat: 30.1, lng: -97.3 } } },
      {
        status: 422,
        body: {
          error: "radius_exceeds_max",
          errorClass: "serve_refused",
          message: "radiusFt 999999999 exceeds the stated max",
        },
      },
    );
    const res = await callFindParcel({ near: { query: "123 Main St", radiusFt: 999999999 } });
    expect(mockCortexFetch).toHaveBeenCalledTimes(2);
    const parsed = JSON.parse(res.text);
    expect(parsed.status).toBe("refused");
    expect(parsed.reason).toBe("radius_exceeds_max");
  });

  it("plain query is unaffected: still hits situs-search and still splits address-point hits (regression)", async () => {
    callResponses({
      status: 200,
      body: {
        hits: [
          { parcelNodeId: "48021:8720522", situsAddress: "111 RAINMAKER CV", countyFips: "48021", source: "parcel-situs" },
          { parcelNodeId: null, label: "9999 Nowhere Ln", countyFips: "48021", latitude: 30.2, longitude: -97.4, source: "address-point" },
        ],
      },
    });
    const res = await callFindParcel({ query: "908 Pine" });
    expect(res.isError).toBe(false);
    const parsed = JSON.parse(res.text);
    expect(parsed.hits).toHaveLength(1);
    expect(parsed.hits[0].parcelNodeId).toBe("48021:8720522");
    const [call] = mockCortexFetch.mock.calls as Array<[unknown, string]>;
    expect(call[1]).toContain("/api/brokerage/v1/place/situs-search?q=");
  });
});

/**
 * H2 (measured 2026-08-30): a node body averages 4,711 chars (largest 5,549);
 * a 50-id node batch is about 235,000 chars, past the roughly 150,000 at which
 * the host writes the result to a file and hands the panel a pointer. Node
 * arrays cap at 25; stub keeps 50. The schema cannot express a depth-dependent
 * cap, so the array stays max(50) and the node rule lives in the handler.
 */
describe("H2: node-depth array cap 25", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ parcels: [], notFound: [] }), { status: 200 }),
    );
  });

  const idsOf = (n: number) => Array.from({ length: n }, (_, i) => `48021:${20000 + i}`);

  async function call(parcelNodeId: string[], depth?: "stub" | "node") {
    let out: { isError?: boolean; text: string } | null = null;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "get_smart_site",
        arguments: depth ? { parcelNodeId, depth } : { parcelNodeId },
      });
      out = {
        isError: result.isError as boolean | undefined,
        text: (result.content?.[0] as { text: string }).text,
      };
    });
    return out!;
  }

  /* M-4: a node array now issues the brief AND up to ANCHOR_BATCH_READ_CAP
   * facets reads, so counting every cortex call no longer measures "one brief
   * went out". Split by path: the brief count is the H2 assertion, the facets
   * count is the anchor fan, and each is asserted against its own bound. */
  const BRIEF_PATH = "/api/property-explorer/v1/research/brief";
  function callsTo(path: string): unknown[][] {
    return mockCortexFetch.mock.calls.filter((c) => String(c[1]).startsWith(path));
  }
  function briefCalls(): unknown[][] {
    return callsTo(BRIEF_PATH);
  }
  function facetsCalls(): unknown[][] {
    return callsTo("/api/brokerage/v1/place/node/");
  }

  function cortexBodySent(): Record<string, unknown> {
    const init = briefCalls()[0]?.[2] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? "{}");
  }

  it("26 ids at depth node refuse with parcel_batch_cap, cap 25, depth node, and never reach cortex", async () => {
    const res = await call(idsOf(26), "node");
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      status: "refused",
      reason: "parcel_batch_cap",
      cap: 25,
      received: 26,
      depth: "node",
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("25 ids at depth node pass to cortex with depth node", async () => {
    const res = await call(idsOf(25), "node");
    expect(res.isError).toBe(false);
    expect(briefCalls()).toHaveLength(1);
    expect(cortexBodySent()).toMatchObject({ depth: "node" });
    expect((cortexBodySent().parcelNodeId as string[]).length).toBe(25);
  });

  it("a 25 id node array fans anchors to the cap and declares the truncation", async () => {
    const res = await call(idsOf(25), "node");
    expect(facetsCalls()).toHaveLength(ANCHOR_BATCH_READ_CAP);
    expect(JSON.parse(res.text).anchorBatch).toEqual({
      cap: ANCHOR_BATCH_READ_CAP,
      received: 25,
      attempted: ANCHOR_BATCH_READ_CAP,
      notAttempted: 25 - ANCHOR_BATCH_READ_CAP,
      reason: "anchor_read_batch_cap",
    });
  });

  it("a stub array reads no facets at any length, and declares why", async () => {
    const res = await call(idsOf(50), "stub");
    expect(facetsCalls()).toHaveLength(0);
    expect(JSON.parse(res.text).anchorRead).toEqual({
      status: "skipped",
      reason: "anchor_read_stub_depth",
    });
    expect(JSON.parse(res.text)).not.toHaveProperty("anchorBatch");
  });

  it("26 ids at depth stub pass to cortex", async () => {
    const res = await call(idsOf(26), "stub");
    expect(res.isError).toBe(false);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    expect(briefCalls()).toHaveLength(1);
    expect((cortexBodySent().parcelNodeId as string[]).length).toBe(26);
  });

  it("26 ids with no depth (array default is stub) pass to cortex without a depth key", async () => {
    const res = await call(idsOf(26));
    expect(res.isError).toBe(false);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    expect(cortexBodySent()).not.toHaveProperty("depth");
  });

  it("50 ids at depth stub pass to cortex", async () => {
    const res = await call(idsOf(50), "stub");
    expect(res.isError).toBe(false);
    expect(mockCortexFetch).toHaveBeenCalledTimes(1);
    expect((cortexBodySent().parcelNodeId as string[]).length).toBe(50);
  });

  it("51 ids at any depth refuse at the published schema (max 50) before the handler", async () => {
    for (const depth of ["node", "stub", undefined] as const) {
      const res = await call(idsOf(51), depth);
      expect(res.isError, `depth ${depth}`).toBe(true);
      expect(res.text, `depth ${depth}`).toContain("50");
      expect(res.text, `depth ${depth}`).not.toContain("parcel_batch_cap");
    }
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });
});

describe("H1 wire half: every non-OK or refused body carries a machine-readable status and reason", () => {
  const originalHauskaUrl = process.env.HAUSKA_MCP_BASE_URL;

  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
    delete process.env.HAUSKA_MCP_BASE_URL;
  });

  afterEach(() => {
    if (originalHauskaUrl === undefined) delete process.env.HAUSKA_MCP_BASE_URL;
    else process.env.HAUSKA_MCP_BASE_URL = originalHauskaUrl;
    vi.restoreAllMocks();
  });

  /** Meaning-shaped: status and reason are both non-empty strings. */
  function expectDeclared(parsed: unknown): void {
    const rec = parsed as Record<string, unknown>;
    expect(typeof rec.status, "status is a string").toBe("string");
    expect((rec.status as string).length, "status non-empty").toBeGreaterThan(0);
    expect(typeof rec.reason, "reason is a string").toBe("string");
    expect((rec.reason as string).length, "reason non-empty").toBeGreaterThan(0);
  }

  async function callRaw(name: string, args: Record<string, unknown>) {
    let out: { isError?: boolean; text: string } | null = null;
    await withTestClient(async (client) => {
      const result = await client.callTool({ name, arguments: args });
      out = {
        isError: result.isError as boolean | undefined,
        text: (result.content?.[0] as { text: string }).text,
      };
    });
    return out!;
  }

  it("falsifier: expectDeclared rejects a body missing status, missing reason, or carrying an empty one", () => {
    expect(() => expectDeclared({ status: "error" })).toThrow();
    expect(() => expectDeclared({ reason: "x" })).toThrow();
    expect(() => expectDeclared({ status: "", reason: "x" })).toThrow();
    expect(() => expectDeclared({ status: "error", reason: "" })).toThrow();
    expect(() => expectDeclared({ status: "error", reason: 7 })).toThrow();
    expect(() => expectDeclared({ status: "error", reason: "x" })).not.toThrow();
  });

  it("not_implemented (hop1, subgraph) carries reason depth_not_implemented", async () => {
    for (const depth of ["hop1", "subgraph"]) {
      const res = await callRaw("get_smart_site", { parcelNodeId: "48021:34137", depth });
      expect(res.isError).toBe(true);
      const parsed = JSON.parse(res.text);
      expectDeclared(parsed);
      expect(parsed).toEqual({ status: "not_implemented", reason: "depth_not_implemented", depth });
    }
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("the batch-cap refuse carries status, reason, cap, received, depth", async () => {
    const res = await callRaw("get_smart_site", {
      parcelNodeId: Array.from({ length: 26 }, (_, i) => `48021:${30000 + i}`),
      depth: "node",
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expectDeclared(parsed);
    expect(parsed).toMatchObject({
      status: "refused",
      reason: "parcel_batch_cap",
      cap: 25,
      received: 26,
      depth: "node",
    });
  });

  it("list_my_properties screenId refuse carries status refused and reason screen_id_not_accepted", async () => {
    const res = await callRaw("list_my_properties", { screenId: "x" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expectDeclared(parsed);
    expect(parsed).toEqual({
      status: "refused",
      reason: "screen_id_not_accepted",
      error: "screen_id_not_accepted",
    });
  });

  it("degradedResult: cortex not configured carries status degraded and reason cortex_not_configured", async () => {
    mockLoadCortexConfig.mockReturnValueOnce(null);
    const res = await callRaw("find_parcel", { query: "908 Pine" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expectDeclared(parsed);
    expect(parsed).toMatchObject({ status: "degraded", reason: "cortex_not_configured" });
    expect(typeof parsed.message).toBe("string");
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("notReadyMessage: a blocked tool carries status not_ready, tool, and the plan-row reason", async () => {
    const res = await callRaw("request_records", { parcelNodeId: "48021:34137" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expectDeclared(parsed);
    expect(parsed).toMatchObject({
      status: "not_ready",
      tool: "request_records",
      reason: "P-85 item 4",
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  it("upgradeRequiredResult carries status upgrade_required and a gate reason", async () => {
    mockAuth = { ...defaultAuth, accessTier: "free", subscriptionTier: null };
    const report = JSON.parse((await callRaw("run_report", { parcelNodeId: "48021:34137" })).text);
    expectDeclared(report);
    expect(report).toMatchObject({ status: "upgrade_required", reason: "deep_report" });
    const studio = JSON.parse(
      (await callRaw("export_instrument", { parcelNodeId: "48021:34137", kind: "siteplan" })).text,
    );
    expectDeclared(studio);
    expect(studio).toMatchObject({ status: "upgrade_required", reason: "studio_report" });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });

  /** Every cortex-backed tool with legal arguments. */
  const CORTEX_CALLS: Array<[string, Record<string, unknown>]> = [
    ["find_parcel", { query: "908 Pine" }],
    // P-91 v3 Q1: both new find_parcel modes fail on their FIRST cortex
    // call under a uniform non-OK mock (near's centre-point read for a
    // parcel-node-id query; street's single street-search call), so both
    // conform to the default expectedCortexCalls of 1 below.
    ["find_parcel", { near: { query: "48021:34137", radiusFt: 500 } }],
    ["find_parcel", { street: { query: "Pine St", countyFips: "48021" } }],
    ["get_smart_site", { parcelNodeId: "48021:34137" }],
    ["get_smart_site", { parcelNodeId: ["48021:34137", "48021:34169"], depth: "stub" }],
    ["list_my_properties", {}],
    ["run_report", { parcelNodeId: "48021:34137" }],
    ["create_screen", { queries: ["111 Rainmaker Cv"], source: "pasted" }],
    ["add_to_screen", { screenId: "scr-1", parcelNodeId: "48021:34137", source: "walk" }],
    ["list_screens", {}],
    ["list_screens", { screenId: "scr-1" }],
    ["save_property", { parcelNodeId: "48021:34137", status: "Watching" }],
    ["set_property_status", { parcelNodeId: "48021:34137", status: "Passed" }],
  ];

  /**
   * P-91 v3 M-1: a single-id node get_smart_site issues a second, concurrent
   * cortex call for the parcel anchor. Every other entry still reaches cortex
   * exactly once, which is what this count is guarding.
   */
  function expectedCortexCalls(
    name: string,
    args: Record<string, unknown>,
  ): number {
    return name === "get_smart_site" && typeof args.parcelNodeId === "string"
      ? 2
      : 1;
  }

  it("an opaque (HTML) upstream non-OK is wrapped as upstream_non_json with the HTTP status, on every cortex-backed tool", async () => {
    for (const [name, args] of CORTEX_CALLS) {
      mockCortexFetch.mockReset();
      mockCortexFetch.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
      const res = await callRaw(name, args);
      expect(res.isError, `${name} isError`).toBe(true);
      const parsed = JSON.parse(res.text);
      expectDeclared(parsed);
      expect(parsed, name).toEqual({
        status: "error",
        reason: "upstream_non_json",
        upstreamStatus: 502,
        brief: "<html>bad gateway</html>",
      });
      expect(mockCortexFetch, `${name} reached cortex`).toHaveBeenCalledTimes(
        expectedCortexCalls(name, args),
      );
    }
  });

  it("a JSON upstream non-OK keeps its keys and gains status error, reason from error, and the HTTP status, on every cortex-backed tool", async () => {
    for (const [name, args] of CORTEX_CALLS) {
      mockCortexFetch.mockReset();
      mockCortexFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: "internal", detail: "pool exhausted" }), {
          status: 500,
        }),
      );
      const res = await callRaw(name, args);
      expect(res.isError, `${name} isError`).toBe(true);
      const parsed = JSON.parse(res.text);
      expectDeclared(parsed);
      expect(parsed, name).toEqual({
        error: "internal",
        detail: "pool exhausted",
        status: "error",
        reason: "internal",
        upstreamStatus: 500,
      });
    }
  });

  it("meaning check: upstreamStatus in the body agrees with the HTTP status the mock served", async () => {
    for (const status of [400, 403, 409, 429, 503]) {
      mockCortexFetch.mockReset();
      mockCortexFetch.mockResolvedValue(new Response("nope", { status }));
      const parsed = JSON.parse(
        (await callRaw("create_screen", { queries: ["x"], source: "pasted" })).text,
      );
      expect(parsed.upstreamStatus).toBe(status);
    }
  });

  it("an upstream JSON body with its own status and reason: status moves to upstreamBodyStatus, reason is kept", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ status: "queued", reason: "rate_limited" }), { status: 429 }),
    );
    const parsed = JSON.parse((await callRaw("list_screens", {})).text);
    expect(parsed).toEqual({
      status: "error",
      reason: "rate_limited",
      upstreamStatus: 429,
      upstreamBodyStatus: "queued",
    });
  });

  it("list_my_properties: a 200 that is not JSON is declared upstream_non_json with upstreamStatus 200, isError true", async () => {
    mockCortexFetch.mockResolvedValue(new Response("<html>login</html>", { status: 200 }));
    const res = await callRaw("list_my_properties", {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.text)).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: 200,
      brief: "<html>login</html>",
    });
  });

  it("OK bodies are untouched: a 200 JSON pass-through gains no status or reason", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: "scr-1", rows: [] }), { status: 200 }),
    );
    const res = await callRaw("list_screens", { screenId: "scr-1" });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.text)).toEqual({ id: "scr-1", rows: [] });
  });

  it("export_instrument: a Hauska non-OK pass-through is declared; the HTTP status is unmeasured at this boundary", async () => {
    process.env.HAUSKA_MCP_BASE_URL = "https://hauska-mcp.test";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("hauska-mcp.test/health")) return new Response("{}", { status: 200 });
      if (url.includes("hauska-mcp.test/tools/export_instrument")) {
        return new Response("<html>500</html>", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await callRaw("export_instrument", { parcelNodeId: "48021:34137", kind: "brief" });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.text);
    expectDeclared(parsed);
    expect(parsed).toEqual({
      status: "error",
      reason: "upstream_non_json",
      upstreamStatus: "unmeasured",
      brief: "<html>500</html>",
    });
    expect(mockCortexFetch).not.toHaveBeenCalled();
  });
});

describe("P-91 v3 V2: standing vocabulary block and resource", () => {
  beforeEach(() => {
    mockAuth = { ...defaultAuth };
    mockCortexFetch.mockReset();
  });

  it("every successful tool result carries the standing vocabulary block as an additional content entry; content[0] is untouched", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ hits: [] }), { status: 200 }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcel",
        arguments: { query: "908 pine" },
      });
      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(2);
      const first = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(first).toEqual({ hits: [] });
      const second = JSON.parse((result.content?.[1] as { text: string }).text) as {
        smartSiteVocabulary: Array<{ token: string; displayText: string; meaning: string }>;
        resource: string;
      };
      expect(second.resource).toBe(VOCABULARY_RESOURCE_URI);
      expect(second.smartSiteVocabulary.length).toBeGreaterThanOrEqual(15);
      expect(second.smartSiteVocabulary.some((e) => e.token === "unknown")).toBe(true);
    });
  });

  it("the standing block also rides on a blocked / not_ready result", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "check_request",
        arguments: { jobId: "job-1" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(2);
      const first = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(first.status).toBe("not_ready");
      const second = JSON.parse((result.content?.[1] as { text: string }).text);
      expect(second.resource).toBe(VOCABULARY_RESOURCE_URI);
    });
  });

  it("the standing block also rides on a declared upstream error result", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcel",
        arguments: { query: "908 pine" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(2);
      const second = JSON.parse((result.content?.[1] as { text: string }).text);
      expect(second.resource).toBe(VOCABULARY_RESOURCE_URI);
    });
  });

  it("falsifier: a naive caller reading content[0] as the vocabulary block would fail — it never carries smartSiteVocabulary", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ hits: [] }), { status: 200 }),
    );
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcel",
        arguments: { query: "x" },
      });
      const first = JSON.parse((result.content?.[0] as { text: string }).text);
      expect(first).not.toHaveProperty("smartSiteVocabulary");
    });
  });

  it("registers the vocabulary resource on a real server, readable via readResource", async () => {
    await withTestClient(async (client) => {
      const resources = await client.listResources();
      const uris = resources.resources.map((r) => r.uri);
      expect(uris).toContain(VOCABULARY_RESOURCE_URI);
      const read = await client.readResource({ uri: VOCABULARY_RESOURCE_URI });
      const body = read.contents[0];
      expect(body?.mimeType).toBe(VOCABULARY_MIME);
      if (body && "text" in body && typeof body.text === "string") {
        const parsed = JSON.parse(body.text) as { vocabulary: Array<{ token: string }> };
        expect(parsed.vocabulary.length).toBeGreaterThanOrEqual(15);
      } else {
        throw new Error("resource text missing");
      }
    });
  });
});
