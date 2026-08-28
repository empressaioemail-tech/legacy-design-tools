import { describe, expect, it } from "vitest";

import { SMARTSITE_MCP_TOOLS, SERVER_NAME } from "../src/constants.js";
import { renderLlmsTxt } from "../src/health.js";

describe("smartsite-mcp constants", () => {
  it("lists exactly thirteen tools", () => {
    expect(SMARTSITE_MCP_TOOLS).toHaveLength(13);
    expect(new Set(SMARTSITE_MCP_TOOLS.map((t) => t.name)).size).toBe(13);
  });

  it("names the server Smart Site", () => {
    expect(SERVER_NAME).toBe("Smart Site");
  });

  it("marks records tools blocked pending backend", () => {
    const records = SMARTSITE_MCP_TOOLS.filter((t) => t.readiness === "blocked");
    expect(records.map((t) => t.name).sort()).toEqual([
      "check_request",
      "request_records",
    ]);
  });
});

describe("llms.txt", () => {
  it("includes hostname and thirteen tool names", () => {
    const txt = renderLlmsTxt("https://mcp.smartsite.cloud");
    expect(txt).toContain("mcp.smartsite.cloud");
    for (const tool of SMARTSITE_MCP_TOOLS) {
      expect(txt).toContain(tool.name);
    }
  });
});
