import { describe, expect, it, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME } from "../src/constants.js";
import { APP_MIME, APP_RESOURCE_URI } from "../src/mcp-app.js";
import { registerTools, shapeSmartSiteNodeResult } from "../src/tools.js";
import { STANDING_VOCAB_CONTENT_PART } from "../src/vocabulary.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";

const mockCortexFetch = vi.fn();
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => ({ baseUrl: "http://cortex.test", serviceApiKey: "test-key" }),
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const mockHasPropertyUnlock = vi.fn<() => Promise<boolean>>(() => Promise.resolve(false));
vi.mock("../src/property-unlock.js", () => ({
  hasPropertyUnlock: (...args: unknown[]) => mockHasPropertyUnlock(...(args as [string, string])),
}));

const mockAuth: SmartsiteAuthContext = {
  userId: "user-test-1",
  email: "test@example.com",
  accessTier: "paid",
  subscriptionTier: "solo",
  devRole: false,
};
vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-context.js")>();
  return { ...actual, requireAuthContext: () => mockAuth };
});

afterEach(() => {
  mockCortexFetch.mockReset();
  mockHasPropertyUnlock.mockReset();
  mockHasPropertyUnlock.mockResolvedValue(false);
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

/**
 * P-399. The defect this file pins, measured on the wire 2026-09-21
 * (_inbox/2026-09-21_p399_wireread_surface_probe.json, seven live
 * get_smart_site tools/call results at depth node against the deployed
 * server, all identical in shape):
 *
 *   content            = [ "text" (1805 B prose + table), "resource_link" ]
 *   structuredContent  = populated, 25310 B, every fact rail
 *   the prose          = "Full record, geometry, and the map panel are
 *                         attached to this result; ..."
 *
 * The record existed ONLY in structuredContent. A consumer that renders
 * content parts without reading structuredContent -- the widget-capable
 * path -- received the sentence and no record. `structuredContent` is a
 * field a host may simply not read; `content` is what every MCP client
 * renders. The fix carries the record in `content` as well, and the
 * sentence now describes only what is actually in this array.
 *
 * The CONTROL is the "record is reachable without structuredContent"
 * assertion below, NOT any assertion about the sentence's wording: a test
 * that pins the prose string cannot detect whether the record arrived.
 */

const RECORD = {
  runId: "pe-r1-p399",
  reportFamily: "R1",
  mode: "baked-facet-intel-v1",
  parcelNodeId: "48021:34137",
  onRecord: {
    apn: "34137",
    acreage: { value: 0.3827, sqft: 16673 },
    countyFips: "48021",
    countyName: "Bastrop",
    situsState: "TX",
  },
  brief: { sections: [], disclosure: [] },
  draw: {
    node: "48021:34137",
    kind: "parcel",
    label: "908 PINE, BASTROP, TX 78602",
    url: "https://smartsite.cloud/p/48021:34137",
    asOf: "2026-08-04",
    frame: { units: "ft", origin: "centroid" },
    attrs: { zoning: { v: "SF-1", state: "present" } },
    overlays: [
      { id: "flood", label: "Zone X", sfha: false, state: "present" },
      { id: "pipeline", label: "Legend only", draw: "legend-only", state: "unknown", reason: "atom_path_pending" },
    ],
    ring: [
      [48.6, 83.94],
      [-50.37, 83.7],
      [-49.07, -84.28],
      [50.84, -83.36],
    ],
  },
  source: "baked-snapshot",
};

const RECORD_TEXT = JSON.stringify(RECORD);

/** Every text part's parsed JSON, or null where a part is not JSON. */
function textParts(result: { content?: Array<{ type: string; text?: string }> }) {
  return (result.content ?? []).filter((c) => c.type === "text");
}

function recordReachableWithoutStructuredContent(
  result: { content?: Array<{ type: string; text?: string }> },
  record: unknown,
): boolean {
  const target = JSON.stringify(record);
  return textParts(result as { content?: Array<{ type: string; text?: string }> }).some((part) => {
    try {
      return JSON.stringify(JSON.parse(part.text as string)) === target;
    } catch {
      return false;
    }
  });
}

describe("P-399: the record reaches the model at depth node (shaper unit)", () => {
  it("carries the record as a content text part, byte-identical to the pre-shaping record", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    const texts = textParts(result as { content?: Array<{ type: string; text?: string }> });
    // Two text parts: content[0] is the Claude-view prose, content[1] is the record.
    expect(texts).toHaveLength(2);
    expect(texts[1].text).toBe(RECORD_TEXT);
  });

  it("CONTROL: the record is reachable without reading structuredContent (this is what failed before P-399)", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    expect(recordReachableWithoutStructuredContent(result, JSON.parse(RECORD_TEXT))).toBe(true);
  });

  it("does not solve it by moving the record out of structuredContent either: both carry it", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    expect(result.structuredContent).toEqual(JSON.parse(RECORD_TEXT));
  });

  it("keeps the record OUT of content[0], so the Claude-view prose is still the first text part (P-243 preserved)", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    const first = textParts(result as { content?: Array<{ type: string; text?: string }> })[0];
    expect(first.text).not.toBe(RECORD_TEXT);
    expect(() => JSON.parse(first.text as string)).toThrow();
  });

  it("degradation, not denial: the sentence names the resource link as unopenable for a non-widget client instead of asserting the panel is attached", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    const prose = textParts(result as { content?: Array<{ type: string; text?: string }> })[0]
      .text as string;
    // The pre-fix sentence ("...and the map panel are attached to this result")
    // asserted an attachment a content-only consumer cannot read.
    expect(prose).not.toContain("are attached to this result");
    expect(prose).toMatch(/MCP Apps|resource link/i);
  });

  it("NOT VACUOUS: a pre-P-399-shaped payload (record only in structuredContent) fails the control", () => {
    const preFix = {
      content: [{ type: "text" as const, text: "prose summary only" }],
      structuredContent: JSON.parse(RECORD_TEXT) as Record<string, unknown>,
    };
    expect(recordReachableWithoutStructuredContent(preFix, JSON.parse(RECORD_TEXT))).toBe(false);
  });

  it("a record that is not JSON never produces a claim about it (fail-closed path unchanged)", () => {
    const result = shapeSmartSiteNodeResult("not json at all");
    const texts = textParts(result as { content?: Array<{ type: string; text?: string }> });
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("not json at all");
    expect((result as { structuredContent?: unknown }).structuredContent).toBeUndefined();
  });
});

describe("P-399 positive: the widget path at depth node, end to end through the server", () => {
  it("returns content parts [text, text, resource_link] and the second is the record", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify(RECORD), { status: 200 }),
    );
    await withTestClient(async (client) => {
      const result = (await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137", depth: "node" },
      })) as { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean };

      expect(result.isError).toBe(false);
      expect((result.content ?? []).map((c) => c.type)).toEqual(["text", "text", "resource_link"]);
      expect(recordReachableWithoutStructuredContent(result, result.structuredContent)).toBe(true);
      expect(JSON.parse((result.content as Array<{ text: string }>)[1].text)).toEqual(
        result.structuredContent,
      );
    });
  });
});

describe("P-399 negatives: the paths that already worked are untouched", () => {
  it("NEGATIVE 1 -- depth stub (array) still answers JSON in a single text part, no resource_link", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcels: [
            { parcelNodeId: "48021:34137", label: "908 PINE", situs: "present", drainage: "unread" },
            { parcelNodeId: "48021:34169", label: "910 PINE", situs: "present", drainage: "unread" },
          ],
          notFound: [],
        }),
        { status: 200 },
      ),
    );
    await withTestClient(async (client) => {
      const result = (await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: ["48021:34137", "48021:34169"], depth: "stub" },
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.isError).toBe(false);
      // P-437: a stub batch opens the screening board — JSON, vocabulary, resource_link.
      expect((result.content ?? []).map((c) => c.type)).toEqual(["text", "text", "resource_link"]);
      expect((result.content as Array<{ text: string }>)[1].text).toBe(
        STANDING_VOCAB_CONTENT_PART.text,
      );
      const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(parsed.parcels).toHaveLength(2);
      expect(parsed.parcels[0].parcelNodeId).toBe("48021:34137");
    });
  });

  it("NEGATIVE 1b -- a single id at depth stub is also left unshaped", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          parcels: [{ parcelNodeId: "48021:34137", label: "908 PINE", situs: "present" }],
          notFound: [],
        }),
        { status: 200 },
      ),
    );
    await withTestClient(async (client) => {
      const result = (await client.callTool({
        name: "get_smart_site",
        arguments: { parcelNodeId: "48021:34137", depth: "stub" },
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.isError).toBe(false);
      expect((result.content ?? []).some((c) => c.type === "resource_link")).toBe(false);
      expect(() => JSON.parse((result.content as Array<{ text: string }>)[0].text)).not.toThrow();
    });
  });

  it("NEGATIVE 2 -- find_parcel still answers its hits verbatim in one text part, no resource_link", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ hits: [{ parcelNodeId: "48021:34137", label: "908 PINE" }] }),
        { status: 200 },
      ),
    );
    await withTestClient(async (client) => {
      const result = (await client.callTool({
        name: "find_parcel",
        arguments: { query: "908 PINE ST" },
      })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean };

      expect(result.isError).toBe(false);
      expect((result.content ?? []).map((c) => c.type)).toEqual(["text", "text"]);
      expect((result.content ?? []).some((c) => c.type === "resource_link")).toBe(false);
      const body = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(body.hits[0].parcelNodeId).toBe("48021:34137");
    });
  });

  it("NEGATIVE 3 -- the panel still renders: the node result carries the app resource_link unchanged", () => {
    const result = shapeSmartSiteNodeResult(RECORD_TEXT);
    const link = result.content.find((c) => c.type === "resource_link") as
      | { uri: string; mimeType?: string; name: string }
      | undefined;
    expect(link).toBeDefined();
    expect(link?.uri).toBe(APP_RESOURCE_URI);
    expect(link?.mimeType).toBe(APP_MIME);
    // Still the last part, and still only one of them.
    expect(result.content.map((c) => c.type)).toEqual(["text", "text", "resource_link"]);
    expect(result.content.filter((c) => c.type === "resource_link")).toHaveLength(1);
  });
});
