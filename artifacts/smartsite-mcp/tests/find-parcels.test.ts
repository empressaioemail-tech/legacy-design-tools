/**
 * P-106 items 3, 4, 5 and 6 at the MCP boundary.
 *
 * Item 3 is a CONTRACT test, not a style one: `find_parcel` and `find_parcels`
 * differ by one character, and a caller reaching for one and getting the other
 * is the defect the card names. The distinguishability checks below read both
 * descriptions the way a model does and pin that each says what it is NOT.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";
import { VOCABULARY } from "../src/vocabulary.js";

const mockCortexFetch = vi.fn();
const CORTEX_TEST_CONFIG = {
  baseUrl: "http://cortex.test",
  serviceApiKey: "test-key",
};
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => CORTEX_TEST_CONFIG,
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const auth: SmartsiteAuthContext = {
  userId: "user-test-1",
  email: "test@example.com",
  accessTier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/request-context.js")>();
  return { ...actual, requireAuthContext: () => auth };
});

async function withTestClient(fn: (client: Client) => Promise<void>) {
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

function firstText(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

const THREE_SET_BODY = {
  countyFips: "48021",
  filters: [
    { rail: "acreage", op: "gte", number: 2 },
    { rail: "flood", op: "is_false" },
  ],
  matched: { count: 412, cap: 50, received: 50, truncated: true, parcels: [] },
  excluded: { count: 89, byRail: { flood: 89 } },
  notEvaluated: { count: 1203, byRail: { flood: 1203 } },
  countyParcels: 1704,
  unmeasuredPctByRail: { acreage: 0.6, flood: 76.3 },
  countingRule: "matched + excluded + notEvaluated = countyParcels",
  projection: {
    builtAt: "2026-09-02T00:00:00.000Z",
    ageHours: 1,
    stale: false,
    staleAfterHours: 26,
  },
};

beforeEach(() => {
  mockCortexFetch.mockReset();
});

describe("find_parcels is not confusable with find_parcel", () => {
  const singular = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_parcel");
  const plural = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_parcels");

  it("both tools exist and are distinct entries", () => {
    expect(singular).toBeDefined();
    expect(plural).toBeDefined();
    expect(singular?.name).not.toBe(plural?.name);
  });

  it("each description says what it is NOT, in the other's terms", () => {
    // The plural names the singular as the address path.
    expect(plural?.description).toMatch(/NOT the tool for looking up an address/);
    expect(plural?.description).toContain("find_parcel, singular");
    // The singular already names the three lookup modes it owns and never
    // claims to answer a question across parcels.
    expect(singular?.description).toMatch(/Exactly one of query, near, or street/);
    expect(singular?.description).not.toMatch(/across parcels/i);
    // The plural leads with the word that separates them.
    expect(plural?.description.startsWith("PLURAL.")).toBe(true);
  });

  it("the plural publishes all three sets in its own description", () => {
    for (const word of ["matched", "excluded", "notEvaluated"]) {
      expect(plural?.description).toContain(word);
    }
    expect(plural?.description).toMatch(/THE RESULT IS THREE SETS/);
  });

  it("the plural promises no ranking and no owner data", () => {
    expect(plural?.description).toMatch(/no ranking/);
    expect(plural?.description).toMatch(/no owner data/);
  });

  it("publishes a distinct input schema: county plus filters, no address", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const pluralTool = tools.find((t) => t.name === "find_parcels");
      const singularTool = tools.find((t) => t.name === "find_parcel");
      const pluralProps = Object.keys(
        (pluralTool?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      ).sort();
      const singularProps = Object.keys(
        (singularTool?.inputSchema as { properties?: Record<string, unknown> })
          ?.properties ?? {},
      ).sort();
      expect(pluralProps).toEqual(["cap", "countyFips", "filters", "query"]);
      expect(singularProps).toEqual(["near", "query", "street"]);
      // The one overlapping key is `query`, and on the plural it exists only
      // so a single address can be REFUSED by name.
      expect(pluralProps).toContain("query");
    });
  });
});

describe("find_parcels declared refusals", () => {
  it("refuses with no county, before anything reaches the wire", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: { filters: [{ rail: "acreage", op: "gte", number: 2 }] },
      });
      expect(firstText(result)).toMatchObject({
        status: "refused",
        reason: "constraint_bound_missing",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("refuses with no filters, before anything reaches the wire", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: { countyFips: "48021", filters: [] },
      });
      expect(firstText(result)).toMatchObject({
        status: "refused",
        reason: "constraint_filters_missing",
      });
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  it("routes a single street address back to find_parcel by name", async () => {
    mockCortexFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          error: "constraint_single_address",
          errorClass: "serve_refused",
          message:
            "That reads as one street address, which is a lookup rather than a constraint search. Use find_parcel for a single address.",
        }),
    });
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [{ rail: "acreage", op: "gte", number: 2 }],
          query: "908 PINE ST",
        },
      });
      const body = firstText(result);
      expect(body).toMatchObject({
        status: "refused",
        reason: "constraint_single_address",
      });
      expect(String(body.message)).toContain("find_parcel");
      expect(body.reasonDisplayText).toBe("That is a lookup, not a search");
    });
  });

  it("carries the measured number through an unmeasured-rail refusal", async () => {
    mockCortexFetch.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () =>
        JSON.stringify({
          error: "constraint_rail_unmeasured",
          errorClass: "serve_refused",
          message:
            "Rail flood is unmeasured on 76.3 percent of the 1704 parcels in county 48021, above the 50 percent ceiling for a filter.",
          detail: {
            rail: "flood",
            countyFips: "48021",
            countyParcels: 1704,
            unmeasuredParcels: 1300,
            unmeasuredPct: 76.3,
            ceilingPct: 50,
          },
        }),
    });
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [{ rail: "flood", op: "is_false" }],
        },
      });
      const body = firstText(result);
      expect(body.reason).toBe("constraint_rail_unmeasured");
      // The number is the refusal. A threshold with the measurement stripped
      // out is an assertion.
      expect(body.detail).toMatchObject({ unmeasuredPct: 76.3, ceilingPct: 50 });
    });
  });

  it("gives every constraint refusal code a vocabulary row", () => {
    const codes = [
      "constraint_bound_missing",
      "constraint_county_out_of_scope",
      "constraint_single_address",
      "constraint_filters_missing",
      "constraint_rail_unknown",
      "constraint_op_unsupported",
      "constraint_cap_invalid",
      "constraint_rail_unmeasured",
      "constraint_projection_missing",
    ];
    for (const code of codes) {
      const entry = VOCABULARY.find((e) => e.token === code);
      expect(entry, `vocabulary row for ${code}`).toBeDefined();
      expect(entry?.displayText.length).toBeGreaterThan(0);
      expect(entry?.meaning).toContain("find_parcels");
    }
  });
});

describe("find_parcels three-set passthrough", () => {
  it("passes all three sets and the counting rule through verbatim", async () => {
    mockCortexFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(THREE_SET_BODY),
    });
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [
            { rail: "acreage", op: "gte", number: 2 },
            { rail: "flood", op: "is_false" },
          ],
        },
      });
      const body = firstText(result);
      // The whole card in one assertion: three sets, none merged, none dropped.
      expect(body.matched).toMatchObject({ count: 412, truncated: true });
      expect(body.excluded).toMatchObject({ count: 89 });
      expect(body.notEvaluated).toMatchObject({ count: 1203 });
      expect(body.notEvaluated).toHaveProperty("byRail");
      expect((body.notEvaluated as { byRail: Record<string, number> }).byRail)
        .toHaveProperty("flood");
      expect(body.countingRule).toBe(THREE_SET_BODY.countingRule);
      expect(body.projection).toMatchObject({
        builtAt: "2026-09-02T00:00:00.000Z",
        stale: false,
      });
      expect(body.unmeasuredPctByRail).toMatchObject({ flood: 76.3 });
    });
  });

  it("puts the filter set on the wire as JSON, county and cap as parameters", async () => {
    mockCortexFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(THREE_SET_BODY),
    });
    await withTestClient(async (client) => {
      await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [{ rail: "acreage", op: "gte", number: 2 }],
          cap: 25,
        },
      });
      const path = String(mockCortexFetch.mock.calls[0][1]);
      expect(path).toContain("/api/brokerage/v1/place/constraint-search?");
      expect(path).toContain("countyFips=48021");
      expect(path).toContain("cap=25");
      expect(decodeURIComponent(path)).toContain(
        '"rail":"acreage","op":"gte","number":2',
      );
    });
  });

  it("refuses an unrecognised filter op at the tool boundary", async () => {
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [{ rail: "acreage", op: "roughly", number: 2 }],
        },
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(mockCortexFetch).not.toHaveBeenCalled();
    });
  });

  /**
   * Item 6. The result feeds a screen with NO re-fetch and NO re-typing: the
   * parcel node ids come back on the matched parcels and `create_screen` takes
   * a node id as a query directly (peScreenSaveResolveCore's node-id branch
   * skips situs search and looks the parcel up). This test walks that path
   * end to end through the tool surface.
   */
  it("feeds create_screen straight from the matched parcel ids", async () => {
    const matchedIds = ["48021:103255", "48021:103281"];
    mockCortexFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ...THREE_SET_BODY,
            matched: {
              count: 2,
              cap: 50,
              received: 2,
              truncated: false,
              parcels: matchedIds.map((id) => ({
                parcelNodeId: id,
                countyFips: "48021",
                rails: { acreage: { state: "present", value: 5 } },
              })),
            },
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            screen: {
              id: "screen-1",
              name: "Bastrop 2ac dry",
              rows: matchedIds.map((id) => ({ parcelNodeId: id, resolved: true })),
            },
          }),
      });

    await withTestClient(async (client) => {
      const search = await client.callTool({
        name: "find_parcels",
        arguments: {
          countyFips: "48021",
          filters: [{ rail: "acreage", op: "gte", number: 2 }],
        },
      });
      const parcels = (
        firstText(search).matched as { parcels: Array<{ parcelNodeId: string }> }
      ).parcels;
      const ids = parcels.map((p) => p.parcelNodeId);
      expect(ids).toEqual(matchedIds);

      const screen = await client.callTool({
        name: "create_screen",
        arguments: { name: "Bastrop 2ac dry", queries: ids, source: "pasted" },
      });
      const screenBody = firstText(screen);
      expect(screenBody).toHaveProperty("screen");

      // The ids went through untouched: no re-fetch, no re-typing, no
      // intermediate lookup call.
      const createCall = mockCortexFetch.mock.calls[1];
      expect(String(createCall[1])).toContain("/screens");
      expect(String(createCall[2] && (createCall[2] as { body?: string }).body))
        .toContain(matchedIds[0]);
      expect(mockCortexFetch).toHaveBeenCalledTimes(2);
    });
  });
});
