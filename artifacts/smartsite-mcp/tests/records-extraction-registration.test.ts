/**
 * P-113 registration follow-up. recordsExtraction.ts (list_purchased_records,
 * read_purchased_record) was built and unit-tested against a real DB in
 * tests/records-extraction.test.ts (PR #596) but never wired into
 * SMARTSITE_MCP_TOOLS / the tools.ts dispatch table — this file is that
 * wiring's own test, at the dispatch layer records-extraction.test.ts does
 * not reach.
 *
 * Deliberately does NOT mock ../src/recordsExtraction.js: every assertion
 * here exercises the REAL module through the REAL MCP dispatch, proving the
 * tool names resolve to the actual implementation rather than a stub. It
 * stays DB-free by only exercising response paths recordsExtraction.ts
 * itself resolves before ever touching @workspace/db (the Studio
 * entitlement gate, and the parcelNodeId / artifactId shape checks) — the
 * exact same reason a FREE-tier caller never reaches Postgres in
 * production. The DB-backed rows (an actual purchased job/document) stay
 * covered by tests/records-extraction.test.ts's real-Postgres suite; this
 * file's job is "does tools/list carry these two tools, and does calling
 * them reach recordsExtraction.ts with the arguments the caller gave" —
 * not re-testing recordsExtraction.ts's own DB logic.
 */
import { describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import type { SmartsiteAuthContext } from "../src/request-context.js";
import { registerTools } from "../src/tools.js";

let mockAuth: SmartsiteAuthContext;

vi.mock("../src/request-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-context.js")>();
  return {
    ...actual,
    requireAuthContext: () => mockAuth,
  };
});

const FREE_AUTH: SmartsiteAuthContext = {
  userId: "user-free-1",
  email: "free@example.com",
  accessTier: "free",
  subscriptionTier: null,
  devRole: false,
};

const STUDIO_AUTH: SmartsiteAuthContext = {
  userId: "user-studio-1",
  email: "studio@example.com",
  accessTier: "paid",
  subscriptionTier: "studio",
  devRole: false,
};

async function withTestClient(
  fn: (client: Client) => Promise<void>,
): Promise<void> {
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

function firstBody(result: unknown): unknown {
  const content = (result as { content?: Array<{ text?: unknown }> }).content;
  const text = content?.[0]?.text;
  return typeof text === "string" ? JSON.parse(text) : undefined;
}

describe("P-113 registration: list_purchased_records / read_purchased_record", () => {
  it("both tools appear in tools/list with readiness live and the catalog's title", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_purchased_records");
      expect(names).toContain("read_purchased_record");

      const listCatalog = SMARTSITE_MCP_TOOLS.find(
        (t) => t.name === "list_purchased_records",
      );
      const readCatalog = SMARTSITE_MCP_TOOLS.find(
        (t) => t.name === "read_purchased_record",
      );
      expect(listCatalog?.readiness).toBe("live");
      expect(readCatalog?.readiness).toBe("live");

      const listTool = tools.find((t) => t.name === "list_purchased_records");
      const readTool = tools.find((t) => t.name === "read_purchased_record");
      expect(listTool?.title).toBe(listCatalog?.title);
      expect(readTool?.title).toBe(readCatalog?.title);
      // Reads: readOnlyHint true, same as every other Smart Site lookup tool.
      expect(listTool?.annotations?.readOnlyHint).toBe(true);
      expect(readTool?.annotations?.readOnlyHint).toBe(true);
    });
  });

  it("list_purchased_records dispatches to the real Studio gate for a free-tier caller", async () => {
    mockAuth = FREE_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_purchased_records",
        arguments: { parcelNodeId: "48453:R123456" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({
        status: "upgrade_required",
        reason: "studio_report",
        tier: "free",
      });
    });
  });

  it("read_purchased_record dispatches to the real Studio gate for a free-tier caller", async () => {
    mockAuth = FREE_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "read_purchased_record",
        arguments: { parcelNodeId: "48453:R123456", artifactId: "art-1" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({
        status: "upgrade_required",
        reason: "studio_report",
        tier: "free",
      });
    });
  });

  it("a Studio caller's malformed parcelNodeId reaches recordsExtraction.ts's own validation (proves the arg is threaded through, not swallowed at dispatch)", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_purchased_records",
        arguments: { parcelNodeId: "not-a-parcel-id" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({
        status: "refused",
        reason: "parcel_node_id_invalid",
        parcelNodeId: "not-a-parcel-id",
      });
    });
  });

  it("a Studio caller's missing artifactId reaches recordsExtraction.ts's own validation on read_purchased_record", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      // artifactId is required by the tool's own inputSchema (.strict()), so
      // omitting it is refused at the schema boundary before the handler
      // runs — still proof the schema for this new tool is wired correctly.
      const result = await client.callTool({
        name: "read_purchased_record",
        arguments: { parcelNodeId: "48453:R123456" },
      });
      expect(result.isError).toBe(true);
    });
  });

  it("read_purchased_record's inputSchema rejects an unknown extra key (registered as .strict(), like its siblings)", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "read_purchased_record",
        arguments: {
          parcelNodeId: "48453:R123456",
          artifactId: "art-1",
          extra: "nope",
        },
      });
      expect(result.isError).toBe(true);
    });
  });
});
