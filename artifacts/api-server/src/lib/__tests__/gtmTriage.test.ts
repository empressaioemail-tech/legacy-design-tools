import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { classifyGtmEvent, inferDataPackage } from "../gtmTriage";

describe("gtmTriage", () => {
  it("maps resolve_place to parcel package with high conversion for external caller", () => {
    const result = classifyGtmEvent({
      eventType: "mcp_tool_call",
      toolName: "resolve_place",
      externalCaller: true,
      jurisdictionKey: "bastrop_tx",
    });
    expect(result.dataPackage).toBe("parcel");
    expect(result.intentScore).toBeGreaterThanOrEqual(70);
    expect(result.conversionOpportunity).toBe("high");
    expect(result.friction).toBe("none");
  });

  it("classifies mcp_error with no_coverage as friction", () => {
    const result = classifyGtmEvent({
      eventType: "mcp_error",
      toolName: "get_subsurface_context",
      errorClass: "no_coverage",
      externalCaller: true,
    });
    expect(result.dataPackage).toBe("subsurface");
    expect(result.friction).toBe("no_coverage");
    expect(result.conversionOpportunity).toBe("none");
  });

  it("infers hydrology package from drainage tools", () => {
    expect(inferDataPackage("simulate_site_drainage")).toBe("hydrology");
  });

  it("infers code package from reconcile tools", () => {
    expect(inferDataPackage("reconcileStandardPrecedence")).toBe("code");
  });
});
