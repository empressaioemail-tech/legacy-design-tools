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

  it("marks the records pair and ask_the_map blocked, each with a reason", () => {
    const blocked = SMARTSITE_MCP_TOOLS.filter((t) => t.readiness === "blocked");
    expect(blocked.map((t) => t.name).sort()).toEqual([
      "ask_the_map",
      "check_request",
      "request_records",
    ]);
    for (const tool of blocked) {
      expect(
        (tool as { blockedReason?: string }).blockedReason,
        `${tool.name} blockedReason`,
      ).toMatch(/^P-\d+ item \d+/);
    }
    const askTheMap = SMARTSITE_MCP_TOOLS.find((t) => t.name === "ask_the_map");
    expect((askTheMap as { blockedReason?: string }).blockedReason).toContain(
      "P-91 item 34",
    );
  });

  it("descriptions do not promise a map, listings, web, or owner data", () => {
    const askTheMap = SMARTSITE_MCP_TOOLS.find((t) => t.name === "ask_the_map");
    expect(askTheMap?.description).not.toMatch(/visible map context/i);
    expect(askTheMap?.description).toContain("not_ready");
    const getSmartSite = SMARTSITE_MCP_TOOLS.find((t) => t.name === "get_smart_site");
    expect(getSmartSite?.description).toContain("upgrade_required");
    expect(getSmartSite?.description).toContain("Array cap 50");
    expect(getSmartSite?.description).toMatch(/does not need to be saved/);
    const findParcel = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_parcel");
    expect(findParcel?.description).toContain("missClass");
    expect(findParcel?.description).toMatch(/not that the parcel does not exist/);
    const listScreens = SMARTSITE_MCP_TOOLS.find((t) => t.name === "list_screens");
    expect(listScreens?.description).toMatch(/does not open a board/);
    for (const name of ["save_property", "set_property_status"] as const) {
      const tool = SMARTSITE_MCP_TOOLS.find((t) => t.name === name);
      expect(tool?.description).toContain("New, Watching, Chasing, Passed");
    }
    expect(
      SMARTSITE_MCP_TOOLS.find((t) => t.name === "create_screen")?.description,
    ).toContain("duplicate_resolved_node");
    expect(
      SMARTSITE_MCP_TOOLS.find((t) => t.name === "add_to_screen")?.description,
    ).toContain("walk, saved, pasted");
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
