/**
 * P-101 — the connector half of the screens gate.
 *
 * WHAT THIS FILE DOES AND DOES NOT PROVE.
 *
 * The Studio gate is on the api-server route (`peStudioGate.ts`, wired at
 * `propertyExplorer.ts`), not here. Its own falsification lives in
 * `artifacts/api-server/src/routes/__tests__/propertyExplorerScreensStubs.test.ts`
 * and `...ScreensLookup.test.ts`, where removing the middleware fails six
 * cases. Nothing in this file can fail because the gate is missing, and
 * claiming otherwise would be the vacuous-check defect.
 *
 * What this file DOES pin is the property item 2 of the P-101 card asserts and
 * the 2026-08-31 amendment depends on: THE MCP GROWS NO PARALLEL GATE, and the
 * route's refusal reaches the connector intact. Both halves are falsifiable:
 *
 *   - add a local tier check to `create_screen` in tools.ts and the
 *     "reaches cortex exactly once" cases fail, because a locally-gated tool
 *     never calls upstream;
 *   - stop surfacing the upstream status (swallow the 402, return an empty
 *     board) and the refusal-shape cases fail.
 *
 * That is deliberately the INVERSE of the both-directions shape at
 * tools.test.ts:501-576, which asserts `mockCortexFetch` was NOT called. Those
 * tools (`run_report`, `export_instrument`) are gated inside this server. These
 * are not, and cannot be: a free caller MUST reach cortex, because that is how
 * it learns it is refused. Asserting `not.toHaveBeenCalled()` here would only
 * pass if item 2 had been violated.
 *
 * The card prescribed the `not.toHaveBeenCalled()` shape for these tools. It is
 * unsatisfiable alongside item 2. Reported in CP1 and in the close.
 *
 * Lives in its own file rather than appended to tools.test.ts because open PR
 * #580 (P-106) edits that file and changes the registered-tool count.
 *
 * OPS-16 A-101 (2026-09-04). The refusal SHAPE changed, item 2 did not: a
 * 402 shaped exactly as `requirePeStudioScreens` sends it now reshapes (via
 * `mapScreensGateNonOk`, tool-honesty.ts) into the same declared
 * `upgrade_required` envelope `export_instrument`'s local Studio gate
 * already returns, instead of the generic `declareUpstreamNonOk` passthrough
 * this file originally pinned. Still exactly one cortex call, still the
 * route's own reason/tier/subscriptionTier/message carried through intact —
 * reshaped, not re-decided; still zero local tier predicate in tools.ts.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";
import { APP_RESOURCE_URI, APP_HOST_TOOLS } from "../src/mcp-app.js";

const mockCortexFetch = vi.fn();
const CORTEX_TEST_CONFIG = {
  baseUrl: "http://cortex.test",
  serviceApiKey: "test-key",
};
const mockLoadCortexConfig = vi.fn<() => typeof CORTEX_TEST_CONFIG | null>(
  () => CORTEX_TEST_CONFIG,
);
vi.mock("../src/cortex-client.js", () => ({
  loadCortexClientConfig: () => mockLoadCortexConfig(),
  cortexFetch: (...args: unknown[]) => mockCortexFetch(...args),
}));

const STUDIO_AUTH: SmartsiteAuthContext = {
  userId: "user-studio-1",
  email: "studio@example.com",
  accessTier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};

const FREE_AUTH: SmartsiteAuthContext = {
  userId: "user-free-1",
  email: "free@example.com",
  accessTier: "free",
  subscriptionTier: null,
  devRole: false,
};

let mockAuth: SmartsiteAuthContext = { ...STUDIO_AUTH };

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/request-context.js")>();
  return { ...actual, requireAuthContext: () => mockAuth };
});

async function withTestClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: "0.0.1" });
  registerTools(server);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await fn(client);
  await client.close();
  await server.close();
}

/** The exact body `requirePeStudioScreens` returns (peStudioGate.ts). */
const ROUTE_REFUSAL_BODY = JSON.stringify({
  error: "upgrade_required",
  reason: "studio_screens",
  message:
    "Studio or Team is required to build a screen. Solo answers one parcel; Studio works a list of them.",
  tier: "free",
  subscriptionTier: null,
});

function refused402(): Response {
  return new Response(ROUTE_REFUSAL_BODY, { status: 402 });
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

describe("P-101 screens gate is inherited from the route, not re-implemented here", () => {
  beforeEach(() => {
    mockAuth = { ...STUDIO_AUTH };
    mockCortexFetch.mockReset();
    mockLoadCortexConfig.mockReturnValue(CORTEX_TEST_CONFIG);
  });

  it("free create_screen: reaches cortex ONCE and surfaces the route refusal as a declared upgrade_required", async () => {
    mockAuth = { ...FREE_AUTH };
    mockCortexFetch.mockResolvedValue(refused402());

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "create_screen",
        arguments: { name: "walk", queries: ["48021:34137"], source: "pasted" },
      });
      expect(result.isError).toBe(true);
      // No local gate: the tool asked upstream, which is the only place the
      // tier is known. Exactly one call, so it did not retry past the refusal.
      expect(mockCortexFetch).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(textOf(result));
      // OPS-16 A-101: the same declared envelope export_instrument's local
      // Studio gate returns, reshaped from the route's own 402 body — not
      // the generic upstream-error passthrough (no `error` or
      // `upstreamStatus` key; top-level `status` is the declared kind).
      expect(parsed).toEqual({
        status: "upgrade_required",
        reason: "studio_screens",
        tier: "free",
        subscriptionTier: null,
        message:
          "Studio or Team is required to build a screen. Solo answers one parcel; Studio works a list of them.",
      });
      // The sentence survives the hop; the connector does not have to invent one.
      expect(parsed.message).toMatch(/screen/i);
    });
  });

  it("free add_to_screen: same, and the screen id is not echoed as a success", async () => {
    mockAuth = { ...FREE_AUTH };
    mockCortexFetch.mockResolvedValue(refused402());

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "add_to_screen",
        arguments: {
          screenId: "s-1",
          parcelNodeId: "48021:34137",
          source: "walk",
        },
      });
      expect(result.isError).toBe(true);
      expect(mockCortexFetch).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(textOf(result));
      expect(parsed).toMatchObject({
        status: "upgrade_required",
        reason: "studio_screens",
      });
      expect(parsed).not.toHaveProperty("screenId");
      expect(parsed).not.toHaveProperty("upstreamStatus");
    });
  });

  it("a 402 NOT shaped like the screens gate falls back to the generic declared envelope, never fabricated", async () => {
    mockAuth = { ...FREE_AUTH };
    // Same status, different (and incomplete) body: no `message`, and a
    // `reason` this gate never emits. mapScreensGateNonOk must decline
    // rather than guess a tier/subscriptionTier/message it never read.
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "upgrade_required", reason: "some_other_gate" }), {
        status: 402,
      }),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "create_screen",
        arguments: { name: "walk", queries: ["48021:34137"], source: "pasted" },
      });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(textOf(result));
      // The generic upstream-error shape, not the screens upgrade_required
      // envelope: falling back is honest about what it actually read.
      expect(parsed).toMatchObject({
        status: "error",
        reason: "some_other_gate",
        upstreamStatus: 402,
      });
    });
  });

  it("studio create_screen: not refused, reaches cortex, returns the screen", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ screen: { id: "s-1", name: "walk", rows: [] } }),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "create_screen",
        arguments: { name: "walk", queries: ["48021:34137"], source: "pasted" },
      });
      expect(result.isError).toBe(false);
      expect(mockCortexFetch).toHaveBeenCalledTimes(1);
      expect(JSON.parse(textOf(result))).toMatchObject({
        screen: { id: "s-1" },
      });
    });
  });

  it("studio add_to_screen: not refused", async () => {
    mockCortexFetch.mockResolvedValue(
      new Response(
        JSON.stringify({ screenId: "s-1", row: { query: "48021:34137" } }),
        { status: 200 },
      ),
    );

    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "add_to_screen",
        arguments: {
          screenId: "s-1",
          parcelNodeId: "48021:34137",
          source: "walk",
        },
      });
      expect(result.isError).toBe(false);
      expect(JSON.parse(textOf(result))).toMatchObject({ screenId: "s-1" });
    });
  });
});

/**
 * P-101 item 9 — call 1 of the operator ruling, in the connector.
 *
 * `create_screen` and `list_screens` are two of three `APP_HOST_TOOLS`; the
 * third, `get_smart_site`, is already paid-gated. Gating `list_screens` too
 * would leave a free connector user with NO panel entry point at all. The
 * ruling therefore leaves it open, and this is the proof that the decision
 * survives in the code: a free caller gets a 200 and an empty list, and the
 * tool that gave it to them carries the panel resource.
 */
describe("P-101 item 9: the panel still mounts for a free connector user", () => {
  beforeEach(() => {
    mockAuth = { ...FREE_AUTH };
    mockCortexFetch.mockReset();
    mockLoadCortexConfig.mockReturnValue(CORTEX_TEST_CONFIG);
  });

  it("list_screens is one of the panel-mounting tools and is NOT gated", async () => {
    expect(APP_HOST_TOOLS).toContain("list_screens");
    mockCortexFetch.mockResolvedValue(
      new Response(JSON.stringify({ screens: [] }), { status: 200 }),
    );

    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const listed = tools.find((t) => t.name === "list_screens");
      expect(listed).toBeDefined();
      expect(
        (listed as { _meta?: { ui?: { resourceUri?: string } } })._meta?.ui
          ?.resourceUri,
      ).toBe(APP_RESOURCE_URI);

      const result = await client.callTool({
        name: "list_screens",
        arguments: {},
      });
      expect(result.isError).toBe(false);
      expect(JSON.parse(textOf(result))).toEqual({ screens: [] });
    });
  });

  it("a free user is not left with zero panel entry points: create_screen refuses, list_screens serves", async () => {
    mockCortexFetch.mockImplementation(
      async (_config: unknown, path: string, init?: { method?: string }) => {
        if (init?.method === "POST") return refused402();
        return new Response(JSON.stringify({ screens: [] }), { status: 200 });
      },
    );

    await withTestClient(async (client) => {
      const refused = await client.callTool({
        name: "create_screen",
        arguments: { name: "walk", queries: ["48021:34137"], source: "pasted" },
      });
      expect(refused.isError).toBe(true);

      const served = await client.callTool({
        name: "list_screens",
        arguments: {},
      });
      expect(served.isError).toBe(false);
    });
  });
});
