import { describe, expect, it } from "vitest";
import { SMARTSITE_MCP_TOOLS } from "../src/constants.js";

describe("find_nearest_parcels catalog", () => {
  const tool = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_nearest_parcels");

  it("is live and tells the model not to web-search comparables", () => {
    expect(tool?.readiness).toBe("live");
    expect(tool?.description.toLowerCase()).toContain("never search the web");
    expect(tool?.description.toLowerCase()).toContain("comparables");
  });

  it("is distinct from find_parcels constraint search", () => {
    const plural = SMARTSITE_MCP_TOOLS.find((t) => t.name === "find_parcels");
    expect(plural?.description).toContain("filters");
    expect(tool?.description).not.toContain("filters array");
  });
});
