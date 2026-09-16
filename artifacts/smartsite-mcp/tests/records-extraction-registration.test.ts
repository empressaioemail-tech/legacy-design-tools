/**
 * P-113 registration follow-up. recordsExtraction.ts (list_purchased_records,
 * read_purchased_record) was built and unit-tested against a real DB in
 * tests/records-extraction.test.ts (PR #596) but never wired into
 * SMARTSITE_MCP_TOOLS / the tools.ts dispatch table — this file is that
 * wiring's own test, at the dispatch layer records-extraction.test.ts does
 * not reach.
 *
 * P-242 (operator ruling 2026-09-15, coming-soon on every surface): both
 * tools flip from `readiness: "live"` to `readiness: "blocked"` in
 * constants.ts. registerTools's dispatch wrapper (tools.ts) checks
 * `tool.readiness === "blocked"` BEFORE calling recordsExtraction.ts at all
 * — before the Studio entitlement gate, before parcelNodeId/artifactId
 * validation, at any caller tier. The tests below that used to prove a
 * free-tier caller reaches the real Studio gate, and that a Studio caller
 * reaches recordsExtraction.ts's own arg validation, are REWRITTEN here to
 * prove the opposite: every caller, regardless of tier or argument shape,
 * now gets the declared not_ready envelope and never reaches
 * recordsExtraction.ts. The Studio-tier case is the one that matters most
 * (P-242 falsifier 1): it is the one path that reached the real handler
 * before this row, so it is the only one whose still-succeeding would be
 * proof this row did nothing.
 *
 * Deliberately does NOT mock ../src/recordsExtraction.js: every assertion
 * here exercises the REAL dispatch wrapper and the REAL module, proving the
 * block fires in the actual dispatch path rather than in a stub. Stays
 * DB-free the same way it always did: the blocked check (like the
 * entitlement gate it now pre-empts) resolves before @workspace/db is ever
 * touched.
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
  it("both tools still appear in tools/list, now readiness blocked with the P-242 blockedReason", async () => {
    await withTestClient(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // P-242 predicate 3 / falsifier 2: coming-soon means listed-and-
      // refusing, never removed from the catalog.
      expect(names).toContain("list_purchased_records");
      expect(names).toContain("read_purchased_record");

      const listCatalog = SMARTSITE_MCP_TOOLS.find(
        (t) => t.name === "list_purchased_records",
      );
      const readCatalog = SMARTSITE_MCP_TOOLS.find(
        (t) => t.name === "read_purchased_record",
      );
      expect(listCatalog?.readiness).toBe("blocked");
      expect(readCatalog?.readiness).toBe("blocked");
      expect(listCatalog?.blockedReason).toBe("P-242");
      expect(readCatalog?.blockedReason).toBe("P-242");

      const listTool = tools.find((t) => t.name === "list_purchased_records");
      const readTool = tools.find((t) => t.name === "read_purchased_record");
      expect(listTool?.title).toBe(listCatalog?.title);
      expect(readTool?.title).toBe(readCatalog?.title);
      // Reads: readOnlyHint true, same as every other Smart Site lookup tool.
      expect(listTool?.annotations?.readOnlyHint).toBe(true);
      expect(readTool?.annotations?.readOnlyHint).toBe(true);
    });
  });

  it("P-242 falsifier 1: a Studio-tier caller — the one path that reached the real handler before this row — now declines with not_ready on list_purchased_records", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_purchased_records",
        arguments: { parcelNodeId: "48453:R123456" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({
        status: "not_ready",
        tool: "list_purchased_records",
        reason: "P-242",
      });
    });
  });

  it("P-242 falsifier 1: a Studio-tier caller now declines with not_ready on read_purchased_record", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "read_purchased_record",
        arguments: { parcelNodeId: "48453:R123456", artifactId: "art-1" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({
        status: "not_ready",
        tool: "read_purchased_record",
        reason: "P-242",
      });
    });
  });

  it("a free-tier caller ALSO gets not_ready, not the Studio-gate upgrade_required — the block fires before any entitlement check", async () => {
    mockAuth = FREE_AUTH;
    await withTestClient(async (client) => {
      const listResult = await client.callTool({
        name: "list_purchased_records",
        arguments: { parcelNodeId: "48453:R123456" },
      });
      expect(listResult.isError).toBe(true);
      expect(firstBody(listResult)).toMatchObject({ status: "not_ready" });

      const readResult = await client.callTool({
        name: "read_purchased_record",
        arguments: { parcelNodeId: "48453:R123456", artifactId: "art-1" },
      });
      expect(readResult.isError).toBe(true);
      expect(firstBody(readResult)).toMatchObject({ status: "not_ready" });
    });
  });

  it("a Studio caller's malformed parcelNodeId still gets not_ready, never recordsExtraction.ts's own validation — proves the block runs before args are even inspected, not merely before valid args succeed", async () => {
    mockAuth = STUDIO_AUTH;
    await withTestClient(async (client) => {
      const result = await client.callTool({
        name: "list_purchased_records",
        arguments: { parcelNodeId: "not-a-parcel-id" },
      });
      expect(result.isError).toBe(true);
      expect(firstBody(result)).toMatchObject({ status: "not_ready" });
    });
  });

  it("read_purchased_record's inputSchema still rejects an unknown extra key at the schema boundary (schema validation is unaffected by readiness)", async () => {
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
