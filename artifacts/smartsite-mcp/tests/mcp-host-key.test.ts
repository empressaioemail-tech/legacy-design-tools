import { describe, expect, it } from "vitest";

import { mcpRenderHostKeyFromClientName } from "../src/mcp-host-key.js";

describe("mcpRenderHostKeyFromClientName", () => {
  it("maps claude-ai to claude.ai", () => {
    expect(mcpRenderHostKeyFromClientName("claude-ai")).toBe("claude.ai");
  });

  it("maps Claude Desktop", () => {
    expect(mcpRenderHostKeyFromClientName("claude-desktop")).toBe("claude-desktop");
  });

  it("maps chrome hosts", () => {
    expect(mcpRenderHostKeyFromClientName("Claude in Chrome")).toBe("claude-chrome");
  });
});
