import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SERVER_NAME, SMARTSITE_MCP_TOOLS } from "../src/constants.js";
import { registerTools } from "../src/tools.js";

describe("smartsite-mcp tools/list", () => {
  it("registers exactly eight tools with Smart Site server name", async () => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: "0.0.1",
    });
    registerTools(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    expect(tools.map((t) => t.name).sort()).toEqual(
      SMARTSITE_MCP_TOOLS.map((t) => t.name).sort(),
    );

    await client.close();
    await server.close();
  });
});
