import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { SMARTSITE_PROMPTS, registerSmartsitePrompts } from "../src/prompts.js";

describe("starter prompts (F10)", () => {
  it("lists every prompt and fills its argument into a plain ask", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    registerSmartsitePrompts(server as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "c", version: "0" });
    await client.connect(b);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(SMARTSITE_PROMPTS.map((p) => p.name).sort());
    const got = await client.getPrompt({ name: "look_up_property", arguments: { address: "1301 Water St, Bastrop, TX" } });
    expect((got.messages[0]!.content as { text: string }).text).toBe("Look up 1301 Water St, Bastrop, TX in Smart Site.");
  });
});
